import test from 'node:test';
import assert from 'node:assert/strict';

import { doctor, initDatabase } from '../src/core/store.mjs';
import { createSandbox, runCli, seedIssue } from './helpers.mjs';

test('doctor находит задачу без проекта', (t) => {
  const box = createSandbox(t, 'rat-doctor-');
  const wrapper = box.open();
  initDatabase(wrapper);

  wrapper.db.exec('PRAGMA foreign_keys = OFF');
  seedIssue(wrapper.db, { projectKey: 'ZZZ', num: 1, title: 'Сирота' });
  wrapper.db.exec('PRAGMA foreign_keys = ON');

  const report = doctor(wrapper);
  assert.equal(report.ok, false);
  assert.equal(report.counts.issues, 1);

  const integrity = report.checks.find((check) => check.id === 'integrity');
  assert.ok(integrity, 'нет проверки integrity');
  assert.equal(integrity.ok, false);
  assert.equal(integrity.details.orphan_count, 1);
  assert.equal(integrity.details.orphan_issues[0].project_key, 'ZZZ');
  assert.equal(integrity.details.broken_json_count, 0);
});

test('doctor находит битый JSON в labels/meta/events.data', (t) => {
  const box = createSandbox(t, 'rat-doctor-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const issueId = seedIssue(wrapper.db, {
    num: 1,
    title: 'Задача с битым JSON',
    labels: 'не-json',
    meta: '{oops',
  });
  wrapper.db
    .prepare("INSERT INTO events(issue_id, ts, actor, kind, data) VALUES (?, ?, 'test', 'comment', ?)")
    .run(issueId, Date.now(), '{oops');

  const report = doctor(wrapper);
  assert.equal(report.ok, false);

  const integrity = report.checks.find((check) => check.id === 'integrity');
  assert.equal(integrity.ok, false);
  assert.equal(integrity.details.orphan_count, 0);
  assert.equal(integrity.details.broken_json_count, 3);

  const fields = integrity.details.broken_json.map((entry) => `${entry.table}.${entry.field}`).sort();
  assert.deepEqual(fields, ['events.data', 'issues.labels', 'issues.meta']);
});

test('doctor на неинициализированной базе → ok=false', (t) => {
  const box = createSandbox(t, 'rat-doctor-');
  const wrapper = box.open();

  const report = doctor(wrapper);
  assert.equal(report.ok, false);
  const schema = report.checks.find((check) => check.id === 'schema');
  assert.equal(schema.ok, false);
  assert.match(schema.message, /rat init/);
});

test('CLI: doctor на неинициализированной базе → exit 4 и ok=false', (t) => {
  const box = createSandbox(t, 'rat-doctor-');
  box.open();

  const result = runCli(['doctor', '--json'], { dbPath: box.dbPath });
  assert.equal(result.code, 4);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.schema_version, null);
});

test('CLI: doctor на битой базе → exit 4', (t) => {
  const box = createSandbox(t, 'rat-doctor-');
  const wrapper = box.open();
  initDatabase(wrapper);
  wrapper.db.exec('PRAGMA foreign_keys = OFF');
  seedIssue(wrapper.db, { projectKey: 'ZZZ', num: 1, title: 'Сирота' });
  wrapper.db.exec('PRAGMA foreign_keys = ON');
  box.close();

  const result = runCli(['doctor', '--json'], { dbPath: box.dbPath });
  assert.equal(result.code, 4, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  const integrity = report.checks.find((check) => check.id === 'integrity');
  assert.equal(integrity.ok, false);
  assert.equal(integrity.details.orphan_count, 1);
});
