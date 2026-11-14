import test from 'node:test';
import assert from 'node:assert/strict';

import { exportMarkdown } from '../src/core/export.mjs';
import { searchIssues } from '../src/core/query.mjs';
import {
  addComment,
  createIssue,
  doctor,
  initDatabase,
} from '../src/core/store.mjs';
import { createSandbox, runCli } from './helpers.mjs';

function setup(t, prefix = 'rat-m7-schema-') {
  const box = createSandbox(t, prefix);
  const wrapper = box.open();
  initDatabase(wrapper);
  const issue = createIssue(wrapper, { title: 'До миграции' });
  return { box, wrapper, issue };
}

function setSchemaVersion(wrapper, version) {
  wrapper.db
    .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
    .run(String(version));
}

function isSchemaOutdated(err) {
  return err?.code === 'schema_outdated' && err?.exitCode === 4;
}

test('устаревшая схема: store/query/export падают schema_outdated, а не «no such table»', (t) => {
  const { wrapper, issue } = setup(t);
  setSchemaVersion(wrapper, 2);

  assert.throws(
    () => addComment(wrapper, { ref: issue.id, text: 'не должно записаться' }),
    (err) => isSchemaOutdated(err) && /v2/.test(err.message) && /rat init/.test(err.hint),
  );
  assert.throws(() => searchIssues(wrapper, {}), isSchemaOutdated);
  assert.throws(() => exportMarkdown(wrapper, { project: 'RAT' }), isSchemaOutdated);

  // Отклонённая запись не оставила события в базе.
  const comments = wrapper.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'comment'")
    .get().n;
  assert.equal(comments, 0);
});

test('doctor на устаревшей схеме не падает, а показывает ошибку schema', (t) => {
  const { wrapper } = setup(t);
  setSchemaVersion(wrapper, 1);

  const report = doctor(wrapper);
  assert.equal(report.ok, false);
  const schema = report.checks.find((check) => check.id === 'schema');
  assert.equal(schema.ok, false);
  assert.match(schema.message, /Схема v1 устарела/);
  assert.match(schema.message, /rat init/);
});

test('CLI: stale-база → exit 4 с schema_outdated и подсказкой rat init', (t) => {
  const { box } = setup(t);
  const wrapper = box.open();
  setSchemaVersion(wrapper, 2);
  box.close();

  const ls = runCli(['ls', '--json'], { dbPath: box.dbPath });
  assert.equal(ls.code, 4);
  const error = JSON.parse(ls.stderr).error;
  assert.equal(error.code, 'schema_outdated');
  assert.match(error.message, /v2/);
  assert.match(error.hint, /rat init/);

  const show = runCli(['show', 'RAT-1', '--json'], { dbPath: box.dbPath });
  assert.equal(show.code, 4, show.stderr);
  assert.equal(JSON.parse(show.stderr).error.code, 'schema_outdated');

  const comment = runCli(['comment', 'RAT-1', 'текст', '--json'], { dbPath: box.dbPath });
  assert.equal(comment.code, 4, comment.stderr);
  assert.equal(JSON.parse(comment.stderr).error.code, 'schema_outdated');
});

test('rat init обновляет stale-базу, данные остаются, команды снова работают', (t) => {
  const { box } = setup(t);
  const wrapper = box.open();
  setSchemaVersion(wrapper, 1);
  box.close();

  const init = runCli(['init', '--json'], { dbPath: box.dbPath });
  assert.equal(init.code, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).schema_version, 3);

  const ls = runCli(['ls', '--json'], { dbPath: box.dbPath });
  assert.equal(ls.code, 0, ls.stderr);
  const issues = JSON.parse(ls.stdout).issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'До миграции');

  const comment = runCli(['comment', 'RAT-1', 'после миграции', '--json'], { dbPath: box.dbPath });
  assert.equal(comment.code, 0, comment.stderr);
});

test('пустая база → db_not_initialized (exit 1), схема новее → schema_too_new (exit 4)', (t) => {
  const empty = createSandbox(t, 'rat-m7-schema-empty-');
  const notInitialized = runCli(['ls', '--json'], { dbPath: empty.dbPath });
  assert.equal(notInitialized.code, 1);
  assert.equal(JSON.parse(notInitialized.stderr).error.code, 'db_not_initialized');

  const { box } = setup(t, 'rat-m7-schema-new-');
  const wrapper = box.open();
  setSchemaVersion(wrapper, 99);
  box.close();

  const tooNew = runCli(['ls', '--json'], { dbPath: box.dbPath });
  assert.equal(tooNew.code, 4);
  assert.equal(JSON.parse(tooNew.stderr).error.code, 'schema_too_new');
});
