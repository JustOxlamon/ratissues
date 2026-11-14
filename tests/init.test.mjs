import test from 'node:test';
import assert from 'node:assert/strict';

import { migrate } from '../src/core/db.mjs';
import { doctor, initDatabase } from '../src/core/store.mjs';
import { createSandbox, runCli, seedIssue } from './helpers.mjs';

test('init создаёт схему и проект RAT', (t) => {
  const box = createSandbox(t, 'rat-init-');
  const wrapper = box.open();

  const report = initDatabase(wrapper);
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.projectCreated, true);
  assert.equal(report.defaultProject, 'RAT');

  const tables = wrapper.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const name of ['meta', 'projects', 'issues', 'events', 'milestones']) {
    assert.ok(tables.includes(name), `нет таблицы ${name}`);
  }

  const version = wrapper.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(version.value, '3');
  assert.equal(wrapper.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
  assert.equal(wrapper.db.prepare("SELECT name FROM projects WHERE key = 'RAT'").get().name, 'RatIssues');
  assert.equal(wrapper.db.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 0);
});

test('повторный init идемпотентен: версия не растёт, RAT не дублируется', (t) => {
  const box = createSandbox(t, 'rat-init-');
  const wrapper = box.open();

  const first = initDatabase(wrapper);
  const second = initDatabase(wrapper);

  assert.equal(second.schemaVersion, first.schemaVersion);
  assert.equal(second.projectCreated, false);
  assert.equal(wrapper.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
  assert.equal(wrapper.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE key = 'RAT'").get().n, 1);
});

test('прямой вызов migrate тоже идемпотентен', (t) => {
  const box = createSandbox(t, 'rat-init-');
  const wrapper = box.open();

  const first = migrate(wrapper);
  const second = migrate(wrapper);
  assert.equal(first.schemaVersion, 3);
  assert.equal(second.schemaVersion, 3);
  assert.equal(wrapper.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '3');
});

test('миграция v1→v3: данные и FTS сохраняются, появляются deferred и милстоуны', (t) => {
  const box = createSandbox(t, 'rat-init-');
  const wrapper = box.open();

  // Ручная старая схема (v1) без статуса deferred.
  wrapper.db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key, value) VALUES ('schema_version', '1');
    CREATE TABLE projects (
      key TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT,
      color TEXT NOT NULL DEFAULT 'zinc', created_at INTEGER NOT NULL, archived_at INTEGER
    );
    INSERT INTO projects(key, name, root_path, color, created_at)
      VALUES ('RAT', 'RatIssues', NULL, 'lime', 0);
    CREATE TABLE issues (
      id INTEGER PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(key),
      num INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','doing','blocked','done','cancelled')),
      priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
      labels TEXT NOT NULL DEFAULT '[]', assignee TEXT, ref TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      closed_at INTEGER, close_reason TEXT, meta TEXT NOT NULL DEFAULT '{}',
      UNIQUE (project_key, num)
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id),
      ts INTEGER NOT NULL, actor TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('created','status','comment','edit','link','claim')),
      data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX idx_issues_project_status ON issues(project_key, status, priority);
    CREATE INDEX idx_issues_status_updated ON issues(status, updated_at);
  `);
  seedIssue(wrapper.db, { num: 1, title: 'Старая задача' });

  const report = migrate(wrapper);
  assert.equal(report.schemaVersion, 3);
  assert.equal(
    wrapper.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
    '3',
  );

  // Данные пережили перестройку.
  const issue = wrapper.db.prepare('SELECT title, num FROM issues WHERE num = 1').get();
  assert.equal(issue.title, 'Старая задача');
  assert.equal(issue.num, 1);

  // Новый CHECK допускает deferred; FK-зависимая events цела.
  seedIssue(wrapper.db, { num: 2, title: 'Отложенная', status: 'deferred' });
  assert.equal(wrapper.db.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 2);
  assert.equal(wrapper.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);

  // FTS-триггеры на пересозданной issues работают.
  if (wrapper.hasFts5) {
    const found = wrapper.db
      .prepare("SELECT rowid FROM issues_fts WHERE issues_fts MATCH 'Отложенная'")
      .all();
    assert.ok(found.length > 0, 'FTS не проиндексировал перенесённые/новые задачи');
  }

  // v3: таблица милстоунов и nullable-колонка добавились без пересборки.
  const tables = wrapper.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes('milestones'), 'нет таблицы milestones');
  const columns = wrapper.db.prepare('PRAGMA table_info(issues)').all().map((row) => row.name);
  assert.ok(columns.includes('milestone_id'), 'нет колонки issues.milestone_id');
  assert.equal(
    wrapper.db.prepare('SELECT milestone_id FROM issues WHERE num = 1').get().milestone_id,
    null,
  );
});

test('миграция v2→v3: аддитивна, данные целы, FK на milestones работает', (t) => {
  const box = createSandbox(t, 'rat-init-');
  const wrapper = box.open();

  // Ручная схема v2 (без milestones и milestone_id).
  wrapper.db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key, value) VALUES ('schema_version', '2');
    CREATE TABLE projects (
      key TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT,
      color TEXT NOT NULL DEFAULT 'zinc', created_at INTEGER NOT NULL, archived_at INTEGER
    );
    INSERT INTO projects(key, name, root_path, color, created_at)
      VALUES ('RAT', 'RatIssues', NULL, 'lime', 0);
    CREATE TABLE issues (
      id INTEGER PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(key),
      num INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','doing','blocked','deferred','done','cancelled')),
      priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
      labels TEXT NOT NULL DEFAULT '[]', assignee TEXT, ref TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      closed_at INTEGER, close_reason TEXT, meta TEXT NOT NULL DEFAULT '{}',
      UNIQUE (project_key, num)
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id),
      ts INTEGER NOT NULL, actor TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('created','status','comment','edit','link','claim')),
      data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX idx_issues_project_status ON issues(project_key, status, priority);
    CREATE INDEX idx_issues_status_updated ON issues(status, updated_at);
    CREATE INDEX idx_events_issue_ts ON events(issue_id, ts);
    CREATE INDEX idx_events_ts ON events(ts);
  `);
  const issueId = seedIssue(wrapper.db, {
    num: 7,
    title: 'Задача из v2',
    status: 'doing',
    labels: '["backend"]',
    createdAt: 1234,
    updatedAt: 5678,
  });

  const report = migrate(wrapper);
  assert.equal(report.schemaVersion, 3);

  const issue = wrapper.db
    .prepare('SELECT id, title, status, labels, created_at, updated_at, milestone_id FROM issues WHERE id = ?')
    .get(issueId);
  assert.deepEqual(
    {
      title: issue.title,
      status: issue.status,
      labels: issue.labels,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      milestone_id: issue.milestone_id,
    },
    {
      title: 'Задача из v2',
      status: 'doing',
      labels: '["backend"]',
      created_at: 1234,
      updated_at: 5678,
      milestone_id: null,
    },
  );

  // Милстоун вставляется, привязывается, FK ловит чужой id.
  const now = Date.now();
  const created = wrapper.db
    .prepare(
      `INSERT INTO milestones(project_key, name, name_key, created_at, updated_at)
       VALUES ('RAT', 'v1.0', 'v1.0', ?, ?)`,
    )
    .run(now, now);
  const milestoneId = Number(created.lastInsertRowid);
  wrapper.db.prepare('UPDATE issues SET milestone_id = ? WHERE id = ?').run(milestoneId, issueId);
  assert.equal(
    wrapper.db.prepare('SELECT milestone_id FROM issues WHERE id = ?').get(issueId).milestone_id,
    milestoneId,
  );
  assert.throws(
    () => wrapper.db.prepare('UPDATE issues SET milestone_id = 9999 WHERE id = ?').run(issueId),
    /FOREIGN KEY constraint failed/,
  );

  // Уникальность имени внутри проекта (name_key), но не между проектами.
  assert.throws(
    () =>
      wrapper.db
        .prepare(
          `INSERT INTO milestones(project_key, name, name_key, created_at, updated_at)
           VALUES ('RAT', 'V1.0', 'v1.0', ?, ?)`,
        )
        .run(now, now),
    /UNIQUE constraint failed/,
  );

  // Повторный migrate не ломается и остаётся на v3.
  assert.equal(migrate(wrapper).schemaVersion, 3);
});

test('на коннекте включены WAL, busy_timeout, synchronous=NORMAL, foreign_keys', (t) => {
  const box = createSandbox(t, 'rat-init-');
  const wrapper = box.open();

  assert.equal(wrapper.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(wrapper.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(wrapper.db.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.equal(wrapper.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('FTS5 создана вместе с триггерами либо помечена как недоступная', (t) => {
  const box = createSandbox(t, 'rat-init-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const fts = wrapper.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issues_fts'")
    .get();

  if (wrapper.hasFts5) {
    assert.ok(fts, 'hasFts5=true, но issues_fts отсутствует');
    const triggers = wrapper.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'issues_fts_%'")
      .all()
      .map((row) => row.name);
    assert.equal(triggers.length, 3);

    seedIssue(wrapper.db, { num: 1, title: 'Database search test' });
    const found = wrapper.db
      .prepare("SELECT rowid FROM issues_fts WHERE issues_fts MATCH 'database'")
      .all();
    assert.equal(found.length, 1, 'триггер не проиндексировал задачу');
  } else {
    assert.equal(fts, undefined);
  }
});

test('doctor на здоровой базе → ok', (t) => {
  const box = createSandbox(t, 'rat-init-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const report = doctor(wrapper);
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.journalMode, 'wal');
  assert.equal(report.counts.projects, 1);
  assert.equal(report.checks.length >= 4, true);
});

test('CLI: init дважды подряд, вторая база уже с проектом RAT', (t) => {
  const box = createSandbox(t, 'rat-init-');

  const first = runCli(['init', '--json'], { dbPath: box.dbPath });
  assert.equal(first.code, 0, first.stderr);
  const firstReport = JSON.parse(first.stdout);
  assert.equal(firstReport.ok, true);
  assert.equal(firstReport.schema_version, 3);
  assert.equal(firstReport.default_project, 'RAT');
  assert.equal(firstReport.project_created, true);
  assert.equal(firstReport.path, box.dbPath);

  const second = runCli(['init', '--json'], { dbPath: box.dbPath });
  assert.equal(second.code, 0, second.stderr);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(secondReport.schema_version, 3);
  assert.equal(secondReport.project_created, false);

  const wrapper = box.open();
  assert.equal(wrapper.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
});

test('CLI: doctor --json на здоровой базе → exit 0', (t) => {
  const box = createSandbox(t, 'rat-init-');
  assert.equal(runCli(['init'], { dbPath: box.dbPath }).code, 0);

  const result = runCli(['doctor', '--json'], { dbPath: box.dbPath });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.journal_mode, 'wal');
  assert.equal(report.schema_version, 3);
});

test('CLI: глобальные флаги работают до команды', (t) => {
  const box = createSandbox(t, 'rat-init-');
  assert.equal(runCli(['init'], { dbPath: box.dbPath }).code, 0);

  const result = runCli(['--json', 'doctor'], { dbPath: box.dbPath });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('CLI: неизвестная команда → exit 2 и справка', (t) => {
  const box = createSandbox(t, 'rat-init-');
  const result = runCli(['совершенно-неизвестная-команда'], { dbPath: box.dbPath });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Неизвестная команда/);
  assert.match(result.stderr, /init/);
  assert.match(result.stderr, /doctor/);
});

test('CLI: лишний аргумент → exit 2 и JSON-ошибка в stderr', (t) => {
  const box = createSandbox(t, 'rat-init-');
  const result = runCli(['init', 'лишнее', '--json'], { dbPath: box.dbPath });

  assert.equal(result.code, 2);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.error.code, 'unexpected_argument');
  assert.match(payload.error.message, /не принимает аргументов/);
});
