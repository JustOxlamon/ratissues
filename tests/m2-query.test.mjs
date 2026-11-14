import test from 'node:test';
import assert from 'node:assert/strict';

import { appendEvent } from '../src/core/events.mjs';
import { getStats, listLog, nextIssue, searchIssues } from '../src/core/query.mjs';
import {
  archiveProject,
  changeStatus,
  createIssue,
  createProject,
  initDatabase,
} from '../src/core/store.mjs';
import { createSandbox, seedIssue } from './helpers.mjs';

const ISSUE_KEYS = [
  'assignee',
  'body',
  'close_reason',
  'closed_at',
  'created_at',
  'id',
  'labels',
  'meta',
  'milestone',
  'num',
  'priority',
  'project',
  'ref',
  'status',
  'title',
  'updated_at',
];

test('searchIssues: FTS5 находит русское слово в title/body, латиницу и метку', (t) => {
  const box = createSandbox(t, 'rat-m2-query-');
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });

  const cyrillic = createIssue(wrapper, {
    project: 'AXEL',
    title: 'Починить кнопку сохранения',
    body: 'Русский текст про вёрстку и Unicode',
    labels: 'ui,bug',
  });
  const latin = createIssue(wrapper, {
    project: 'AXEL',
    title: 'Refactor database layer',
    body: 'sqlite wrapper and migrations',
    labels: 'backend',
  });
  createIssue(wrapper, {
    project: 'AXEL',
    title: 'Другая задача',
    body: 'Ничего общего',
    labels: 'docs',
  });

  assert.ok(wrapper.hasFts5, 'тест ожидает сборку с FTS5');
  assert.deepEqual(searchIssues(wrapper, { project: 'AXEL', q: 'кнопку' }).issues.map((i) => i.id), [
    cyrillic.id,
  ]);
  assert.deepEqual(searchIssues(wrapper, { project: 'AXEL', q: 'вёрстку' }).issues.map((i) => i.id), [
    cyrillic.id,
  ]);
  assert.deepEqual(searchIssues(wrapper, { project: 'AXEL', q: 'database' }).issues.map((i) => i.id), [
    latin.id,
  ]);
  assert.deepEqual(searchIssues(wrapper, { project: 'AXEL', q: 'bug' }).issues.map((i) => i.id), [
    cyrillic.id,
  ]);

  // Рантайм-флаг выключен → тот же поиск через LIKE (включая кириллицу).
  wrapper.hasFts5 = false;
  assert.deepEqual(searchIssues(wrapper, { project: 'AXEL', q: 'кнопку' }).issues.map((i) => i.id), [
    cyrillic.id,
  ]);
  assert.deepEqual(searchIssues(wrapper, { project: 'AXEL', q: 'вёрстку' }).issues.map((i) => i.id), [
    cyrillic.id,
  ]);
  assert.deepEqual(searchIssues(wrapper, { project: 'AXEL', q: 'database' }).issues.map((i) => i.id), [
    latin.id,
  ]);
  assert.deepEqual(searchIssues(wrapper, { project: 'AXEL', q: 'bug' }).issues.map((i) => i.id), [
    cyrillic.id,
  ]);
  wrapper.hasFts5 = true;

  // Таблица FTS физически удалена, флаг остался true → тоже LIKE.
  wrapper.db.exec('DROP TRIGGER IF EXISTS issues_fts_ai');
  wrapper.db.exec('DROP TRIGGER IF EXISTS issues_fts_ad');
  wrapper.db.exec('DROP TRIGGER IF EXISTS issues_fts_au');
  wrapper.db.exec('DROP TABLE IF EXISTS issues_fts');
  assert.deepEqual(searchIssues(wrapper, { project: 'AXEL', q: 'кнопку' }).issues.map((i) => i.id), [
    cyrillic.id,
  ]);
});

test('searchIssues: кавычки и спецсимволы в q не ломают MATCH', (t) => {
  const box = createSandbox(t, 'rat-m2-query-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const quoted = createIssue(wrapper, {
    title: 'Он сказал "привет" и ушёл',
    body: 'AND OR NOT * ( ) - "кавычки"',
  });

  // Спецсимволы FTS/кавычки: не падает; операторы FTS трактуются как слова.
  assert.doesNotThrow(() => searchIssues(wrapper, { q: 'foo"bar' }));
  assert.deepEqual(searchIssues(wrapper, { q: 'foo"bar' }).issues, []);
  assert.deepEqual(
    searchIssues(wrapper, { q: 'AND OR NOT * ( )' }).issues.map((i) => i.id),
    [quoted.id],
  );
  assert.deepEqual(searchIssues(wrapper, { q: 'привет' }).issues.map((i) => i.id), [quoted.id]);
  assert.deepEqual(searchIssues(wrapper, { q: '"привет"' }).issues.map((i) => i.id), [quoted.id]);

  wrapper.hasFts5 = false;
  assert.doesNotThrow(() => searchIssues(wrapper, { q: 'foo"bar' }));
  assert.deepEqual(searchIssues(wrapper, { q: 'привет' }).issues.map((i) => i.id), [quoted.id]);
  assert.deepEqual(searchIssues(wrapper, { q: 'foo%bar' }).issues, []);
});

test('searchIssues: статусы, метки, приоритеты, проект и лимит', (t) => {
  const box = createSandbox(t, 'rat-m2-query-');
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });

  const now = 1_700_000_000_000;
  const p2old = seedIssue(wrapper.db, {
    num: 1,
    title: 'RAT open p2 old',
    status: 'open',
    priority: 2,
    labels: '["ui"]',
    createdAt: now - 5000,
    updatedAt: now - 5000,
  });
  const p0doing = seedIssue(wrapper.db, {
    num: 2,
    title: 'RAT doing p0',
    status: 'doing',
    priority: 0,
    labels: '["backend","ui"]',
    createdAt: now - 4000,
    updatedAt: now - 3000,
  });
  const p1blocked = seedIssue(wrapper.db, {
    num: 3,
    title: 'RAT blocked p1',
    status: 'blocked',
    priority: 1,
    labels: '["ui"]',
    createdAt: now - 3000,
    updatedAt: now - 1000,
  });
  const p0done = seedIssue(wrapper.db, {
    num: 4,
    title: 'RAT done p0',
    status: 'done',
    priority: 0,
    labels: '["ui"]',
    createdAt: now - 6000,
    updatedAt: now - 4000,
  });
  seedIssue(wrapper.db, {
    num: 5,
    title: 'RAT cancelled p3',
    status: 'cancelled',
    priority: 3,
    labels: '["docs"]',
    createdAt: now - 7000,
    updatedAt: now - 6000,
  });
  const axelOpen = seedIssue(wrapper.db, {
    projectKey: 'AXEL',
    num: 1,
    title: 'AXEL open p0',
    status: 'open',
    priority: 0,
    labels: '["docs"]',
    createdAt: now - 2000,
    updatedAt: now - 2000,
  });

  assert.deepEqual(
    searchIssues(wrapper, { project: 'RAT', status: 'active' }).issues.map((i) => i.id),
    ['RAT-2', 'RAT-3', 'RAT-1'],
  );
  assert.equal(searchIssues(wrapper, { project: 'RAT', status: 'all' }).issues.length, 5);
  assert.deepEqual(
    searchIssues(wrapper, { project: 'RAT', status: 'done' }).issues.map((i) => i.id),
    ['RAT-4'],
  );
  assert.deepEqual(
    searchIssues(wrapper, { project: 'RAT', status: 'all', label: 'UI' }).issues.map((i) => i.id),
    ['RAT-4', 'RAT-2', 'RAT-3', 'RAT-1'],
  );
  assert.deepEqual(
    searchIssues(wrapper, { project: 'RAT', status: 'all', priority: 'p0' }).issues.map((i) => i.id),
    ['RAT-4', 'RAT-2'],
  );
  assert.deepEqual(
    searchIssues(wrapper, { project: 'RAT', status: 'all', priority: '0..1' }).issues.map((i) => i.id),
    ['RAT-4', 'RAT-2', 'RAT-3'],
  );
  assert.deepEqual(
    searchIssues(wrapper, { project: 'RAT', status: 'all', priority: 3 }).issues.map((i) => i.id),
    ['RAT-5'],
  );
  assert.deepEqual(
    searchIssues(wrapper, { project: 'RAT', status: 'active', label: 'nope' }).issues,
    [],
  );

  // Проект vs все проекты; AXEL присутствует только в режиме всех проектов.
  assert.deepEqual(
    searchIssues(wrapper, { project: 'AXEL', status: 'all' }).issues.map((i) => i.id),
    ['AXEL-1'],
  );
  const all = searchIssues(wrapper, { project: null, status: 'all' });
  assert.equal(all.issues.length, 6);
  assert.ok(
    all.issues.every((issue) => issue.id.startsWith('RAT-') || issue.id.startsWith('AXEL-')),
  );
  assert.deepEqual(
    [...new Set(all.issues.map((issue) => issue.project))].sort(),
    ['AXEL', 'RAT'],
  );

  // Лимит и курсор: страницы не пересекаются и вместе дают весь набор.
  const firstPage = searchIssues(wrapper, { project: 'RAT', status: 'all', limit: 2 });
  assert.equal(firstPage.issues.length, 2);
  assert.equal(typeof firstPage.nextCursor, 'string');
  const secondPage = searchIssues(wrapper, {
    project: 'RAT',
    status: 'all',
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.issues.length, 2);
  assert.equal(new Set([...firstPage.issues, ...secondPage.issues].map((i) => i.id)).size, 4);
  const thirdPage = searchIssues(wrapper, {
    project: 'RAT',
    status: 'all',
    limit: 2,
    cursor: secondPage.nextCursor,
  });
  assert.equal(thirdPage.issues.length, 1);
  assert.equal(thirdPage.nextCursor, null);

  // Сортировка updated: свежие сверху.
  assert.deepEqual(
    searchIssues(wrapper, { project: 'RAT', status: 'all', sort: 'updated' }).issues.map((i) => i.id),
    ['RAT-3', 'RAT-2', 'RAT-4', 'RAT-1', 'RAT-5'],
  );

  // Архивный проект пропадает из all, но остаётся при явном project.
  archiveProject(wrapper, { key: 'AXEL' });
  assert.equal(searchIssues(wrapper, { project: null, status: 'all' }).issues.length, 5);
  assert.deepEqual(
    searchIssues(wrapper, { project: 'AXEL', status: 'all' }).issues.map((i) => i.id),
    ['AXEL-1'],
  );
  assert.ok([axelOpen, p2old, p0doing, p1blocked, p0done].every((id) => id > 0));

  assert.throws(
    () => searchIssues(wrapper, { status: 'nope' }),
    (err) => err.code === 'invalid_status' && err.exitCode === 2,
  );
  assert.throws(
    () => searchIssues(wrapper, { priority: 'p9' }),
    (err) => err.code === 'invalid_priority' && err.exitCode === 2,
  );
  assert.throws(
    () => searchIssues(wrapper, { sort: 'nope' }),
    (err) => err.code === 'invalid_sort' && err.exitCode === 2,
  );
  assert.throws(
    () => searchIssues(wrapper, { limit: 0 }),
    (err) => err.code === 'invalid_limit' && err.exitCode === 2,
  );
  assert.throws(
    () => searchIssues(wrapper, { cursor: 'не-курсор' }),
    (err) => err.code === 'invalid_cursor' && err.exitCode === 2,
  );
  assert.throws(
    () => searchIssues(wrapper, { project: 'ZZZ' }),
    (err) => err.code === 'project_not_found' && err.exitCode === 1,
  );

  const shape = searchIssues(wrapper, { project: 'RAT', status: 'all', limit: 1 }).issues[0];
  assert.deepEqual(Object.keys(shape).sort(), ISSUE_KEYS);
});

test('nextIssue: open → priority asc → updated_at asc, метка и пустой результат', (t) => {
  const box = createSandbox(t, 'rat-m2-query-');
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });

  const now = 1_700_000_000_000;
  seedIssue(wrapper.db, { num: 1, title: 'open p1 fresh', priority: 1, updatedAt: now - 100 });
  const olderP0 = seedIssue(wrapper.db, {
    num: 2,
    title: 'open p0 older',
    priority: 0,
    updatedAt: now - 500,
  });
  seedIssue(wrapper.db, {
    num: 3,
    title: 'open p0 newer',
    priority: 0,
    updatedAt: now - 300,
  });
  seedIssue(wrapper.db, {
    num: 4,
    title: 'doing p0',
    status: 'doing',
    priority: 0,
    updatedAt: now - 900,
  });
  seedIssue(wrapper.db, {
    num: 5,
    title: 'done p0',
    status: 'done',
    priority: 0,
    updatedAt: now - 800,
  });
  seedIssue(wrapper.db, {
    num: 6,
    title: 'open p1 ui',
    priority: 1,
    labels: '["ui"]',
    updatedAt: now - 400,
  });

  assert.equal(nextIssue(wrapper, { project: 'RAT' }).id, 'RAT-2');
  assert.equal(nextIssue(wrapper, { project: 'RAT', label: 'UI' }).id, 'RAT-6');
  assert.equal(nextIssue(wrapper, { project: 'RAT', label: 'nope' }), null);
  assert.equal(nextIssue(wrapper, { project: 'AXEL' }), null);

  changeStatus(wrapper, { ref: 'RAT-2', status: 'doing' });
  assert.equal(nextIssue(wrapper, { project: 'RAT' }).id, 'RAT-3');

  assert.throws(
    () => nextIssue(wrapper, { project: 'ZZZ' }),
    (err) => err.code === 'project_not_found',
  );
  assert.ok(olderP0 > 0);
});

test('listLog: since/kind/limit/проект и публичные id', (t) => {
  const box = createSandbox(t, 'rat-m2-query-');
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });
  seedIssue(wrapper.db, { num: 1, title: 'RAT-1' });
  seedIssue(wrapper.db, { projectKey: 'AXEL', num: 1, title: 'AXEL-1' });

  appendEvent(wrapper, { issueId: 'RAT-1', kind: 'created', data: {}, ts: 1000 });
  appendEvent(wrapper, { issueId: 'RAT-1', kind: 'comment', data: { text: 'a' }, ts: 2000 });
  appendEvent(wrapper, {
    issueId: 'RAT-1',
    kind: 'status',
    data: { from: 'open', to: 'doing' },
    ts: 3000,
  });
  appendEvent(wrapper, { issueId: 'AXEL-1', kind: 'created', data: {}, ts: 2500 });

  const all = listLog(wrapper, {});
  assert.equal(all.length, 4);
  assert.deepEqual(Object.keys(all[0]).sort(), [
    'actor',
    'data',
    'id',
    'issue',
    'kind',
    'project',
    'ts',
  ]);
  assert.equal(all.find((event) => event.issue === 'RAT-1').project, 'RAT');

  assert.deepEqual(listLog(wrapper, { since: 1500 }).map((event) => event.ts), [2000, 2500, 3000]);
  assert.deepEqual(listLog(wrapper, { kind: 'comment' }).map((event) => event.kind), ['comment']);
  assert.deepEqual(
    listLog(wrapper, { project: 'AXEL' }).map((event) => event.issue),
    ['AXEL-1'],
  );
  const limited = listLog(wrapper, { limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].ts, 3000);

  assert.throws(
    () => listLog(wrapper, { kind: 'nope' }),
    (err) => err.code === 'invalid_event_kind' && err.exitCode === 2,
  );
  assert.throws(
    () => listLog(wrapper, { project: 'ZZZ' }),
    (err) => err.code === 'project_not_found' && err.exitCode === 1,
  );
});

test('getStats: счётчики проектов/статусов/приоритетов и недельные цифры', (t) => {
  const box = createSandbox(t, 'rat-m2-query-');
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });

  const now = Date.now();
  const fresh = createIssue(wrapper, { title: 'Свежая', priority: 0 });
  const closedRecently = createIssue(wrapper, { title: 'Закрыта недавно', priority: 2 });
  changeStatus(wrapper, { ref: closedRecently.id, status: 'done', reason: 'ок' });

  const oldId = seedIssue(wrapper.db, {
    num: 10,
    title: 'Старая закрытая',
    status: 'done',
    priority: 2,
    createdAt: now - 10 * 86_400_000,
    updatedAt: now - 10 * 86_400_000,
  });
  wrapper.db
    .prepare('UPDATE issues SET closed_at = ?, close_reason = ? WHERE id = ?')
    .run(now - 9 * 86_400_000, 'старое', oldId);

  createIssue(wrapper, { project: 'AXEL', title: 'Задача AXEL', priority: 2 });

  appendEvent(wrapper, {
    issueId: fresh.id,
    kind: 'comment',
    data: { text: 'свежий' },
    ts: now - 1000,
  });
  appendEvent(wrapper, {
    issueId: fresh.id,
    kind: 'comment',
    data: { text: 'старый' },
    ts: now - 8 * 86_400_000,
  });

  const stats = getStats(wrapper);
  assert.deepEqual(Object.keys(stats).sort(), ['projects', 'totals', 'week']);
  assert.deepEqual(stats.projects.map((project) => project.key), ['AXEL', 'RAT']);
  assert.deepEqual(Object.keys(stats.projects[0]).sort(), ['counts', 'key', 'name']);

  const rat = stats.projects.find((project) => project.key === 'RAT');
  assert.deepEqual(rat.counts, {
    open: 1,
    doing: 0,
    blocked: 0,
    deferred: 0,
    done: 2,
    cancelled: 0,
    total: 3,
  });
  const axel = stats.projects.find((project) => project.key === 'AXEL');
  assert.deepEqual(axel.counts, {
    open: 1,
    doing: 0,
    blocked: 0,
    deferred: 0,
    done: 0,
    cancelled: 0,
    total: 1,
  });

  assert.deepEqual(stats.totals.byStatus, {
    open: 2,
    doing: 0,
    blocked: 0,
    deferred: 0,
    done: 2,
    cancelled: 0,
  });
  assert.equal(stats.totals.byPriority[0], 1);
  assert.equal(stats.totals.byPriority[2], 3);
  assert.equal(stats.totals.total, 4);

  assert.deepEqual(stats.week, { created: 3, closed: 1, comments: 1 });
  assert.ok(fresh.id);
});
