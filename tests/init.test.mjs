import test from 'node:test';
import assert from 'node:assert/strict';

import { migrate } from '../src/core/db.mjs';
import { doctor, initDatabase } from '../src/core/store.mjs';
import { createSandbox, runCli, seedIssue } from './helpers.mjs';

test('init создаёт схему и проект RAT', (t) => {
  const box = createSandbox(t, 'rat-init-');
  const wrapper = box.open();

  const report = initDatabase(wrapper);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.projectCreated, true);
  assert.equal(report.defaultProject, 'RAT');

  const tables = wrapper.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const name of ['meta', 'projects', 'issues', 'events']) {
    assert.ok(tables.includes(name), `нет таблицы ${name}`);
  }

  const version = wrapper.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(version.value, '1');
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
  assert.equal(first.schemaVersion, 1);
  assert.equal(second.schemaVersion, 1);
  assert.equal(wrapper.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1');
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
  assert.equal(report.schemaVersion, 1);
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
  assert.equal(firstReport.schema_version, 1);
  assert.equal(firstReport.default_project, 'RAT');
  assert.equal(firstReport.project_created, true);
  assert.equal(firstReport.path, box.dbPath);

  const second = runCli(['init', '--json'], { dbPath: box.dbPath });
  assert.equal(second.code, 0, second.stderr);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(secondReport.schema_version, 1);
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
  assert.equal(report.schema_version, 1);
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
