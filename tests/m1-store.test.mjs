import test from 'node:test';
import assert from 'node:assert/strict';

import { migrate, readMeta } from '../src/core/db.mjs';
import { listEvents } from '../src/core/events.mjs';
import { getStats, searchIssues } from '../src/core/query.mjs';
import {
  addComment,
  changeStatus,
  claimIssue,
  createIssue,
  createProject,
  getIssue,
  getIssueDetail,
  initDatabase,
  ISSUE_STATUSES,
  listProjectsWithCounts,
  normalizeLabels,
} from '../src/core/store.mjs';
import { createSandbox } from './helpers.mjs';

test('createProject: ключ в uppercase, дубль → ConflictError, default_project на пустой базе', (t) => {
  const box = createSandbox(t, 'rat-m1-store-');
  const wrapper = box.open();
  migrate(wrapper);

  const project = createProject(wrapper, {
    key: 'axel',
    name: 'Axel',
    rootPath: box.dir,
    color: 'sky',
  });
  assert.equal(project.key, 'AXEL');
  assert.equal(project.name, 'Axel');
  assert.equal(project.root_path, box.dir);
  assert.equal(project.color, 'sky');
  assert.equal(project.archived_at, null);
  assert.equal(typeof project.created_at, 'number');
  assert.equal(readMeta(wrapper, 'default_project'), 'AXEL');

  assert.throws(
    () => createProject(wrapper, { key: 'AXEL', name: 'Дубль' }),
    (err) => err.code === 'project_exists' && err.exitCode === 3,
  );
  assert.throws(
    () => createProject(wrapper, { key: 'A', name: 'Короткий' }),
    (err) => err.code === 'invalid_project_key' && err.exitCode === 2,
  );
  assert.throws(
    () => createProject(wrapper, { key: 'ABCDEFGHIJK', name: 'Длинный' }),
    (err) => err.code === 'invalid_project_key',
  );
});

test('createProject не перебивает default_project, если проекты уже были', (t) => {
  const box = createSandbox(t, 'rat-m1-store-');
  const wrapper = box.open();
  initDatabase(wrapper);

  createProject(wrapper, { key: 'AXEL', name: 'Axel' });
  assert.equal(readMeta(wrapper, 'default_project'), 'RAT');
});

test('listProjectsWithCounts: счётчики по статусам, сортировка по key, архив', (t) => {
  const box = createSandbox(t, 'rat-m1-store-');
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });

  const doing = createIssue(wrapper, { project: 'AXEL', title: 'В работе' });
  const done = createIssue(wrapper, { project: 'AXEL', title: 'Готово' });
  changeStatus(wrapper, { ref: doing.id, status: 'doing', actor: 'me' });
  changeStatus(wrapper, { ref: done.id, status: 'done', actor: 'me' });

  const projects = listProjectsWithCounts(wrapper);
  assert.deepEqual(projects.map((project) => project.key), ['AXEL', 'RAT']);
  assert.deepEqual(projects[0].counts, {
    open: 0,
    doing: 1,
    blocked: 0,
    deferred: 0,
    done: 1,
    cancelled: 0,
    total: 2,
  });
  assert.deepEqual(projects[1].counts, {
    open: 0,
    doing: 0,
    blocked: 0,
    deferred: 0,
    done: 0,
    cancelled: 0,
    total: 0,
  });

  wrapper.db
    .prepare('UPDATE projects SET archived_at = ? WHERE key = ?')
    .run(Date.now(), 'AXEL');
  assert.deepEqual(listProjectsWithCounts(wrapper).map((project) => project.key), ['RAT']);
  assert.deepEqual(
    listProjectsWithCounts(wrapper, { includeArchived: true }).map((project) => project.key),
    ['AXEL', 'RAT'],
  );
});

test('createIssue: нумерация, labels, priority, created-событие, публичный id', (t) => {
  const box = createSandbox(t, 'rat-m1-store-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const first = createIssue(wrapper, {
    title: '  Первая  ',
    body: 'тело',
    labels: 'B, a , a',
    assignee: 'me',
    ref: 'src/x.mjs',
    actor: 'agent:test',
  });
  assert.equal(first.id, 'RAT-1');
  assert.equal(first.project, 'RAT');
  assert.equal(first.num, 1);
  assert.equal(first.title, 'Первая');
  assert.equal(first.body, 'тело');
  assert.equal(first.status, 'open');
  assert.equal(first.priority, 2);
  assert.deepEqual(first.labels, ['a', 'b']);
  assert.equal(first.assignee, 'me');
  assert.equal(first.ref, 'src/x.mjs');
  assert.equal(first.closed_at, null);
  assert.equal(first.close_reason, null);
  assert.equal(first.deduplicated, false);
  assert.equal(first.created_at, first.updated_at);

  const second = createIssue(wrapper, { title: 'Вторая', labels: ['Z', 'a', 'z'], priority: 0 });
  assert.equal(second.id, 'RAT-2');
  assert.deepEqual(second.labels, ['a', 'z']);
  assert.equal(second.priority, 0);

  const events = listEvents(wrapper, { issueId: first.id });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'created');
  assert.equal(events[0].actor, 'agent:test');
  assert.equal(events[0].public_id, 'RAT-1');
  assert.deepEqual(events[0].data, {});

  const fetched = getIssue(wrapper, 'rat-1');
  const withoutDedup = { ...first };
  delete withoutDedup.deduplicated;
  assert.deepEqual(fetched, withoutDedup);
  assert.equal(Object.hasOwn(fetched, 'issue_id'), false);
});

test('createIssue: default-проект, ошибки валидации и неизвестный проект', (t) => {
  const box = createSandbox(t, 'rat-m1-store-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const issue = createIssue(wrapper, { title: 'Без --project' });
  assert.equal(issue.id, 'RAT-1');

  assert.throws(
    () => createIssue(wrapper, { title: '   ' }),
    (err) => err.code === 'required_field' && err.exitCode === 2,
  );
  assert.throws(
    () => createIssue(wrapper, { title: 'x', priority: 4 }),
    (err) => err.code === 'invalid_priority' && err.exitCode === 2,
  );
  assert.throws(
    () => createIssue(wrapper, { title: 'x', labels: 42 }),
    (err) => err.code === 'invalid_labels',
  );
  assert.throws(
    () => createIssue(wrapper, { title: 'x', body: 'a'.repeat(64 * 1024 + 1) }),
    (err) => err.code === 'text_too_large',
  );
  assert.throws(
    () => createIssue(wrapper, { project: 'ZZZ', title: 'x' }),
    (err) => err.code === 'project_not_found' && err.exitCode === 1 && /rat project add/.test(err.hint),
  );
});

test('normalizeLabels: строка/массив → lowercase, dedup, sorted', () => {
  assert.deepEqual(normalizeLabels('B, a , a'), ['a', 'b']);
  assert.deepEqual(normalizeLabels(['B', 'a', 'a']), ['a', 'b']);
  assert.deepEqual(normalizeLabels(' x ,, y ,X '), ['x', 'y']);
  assert.deepEqual(normalizeLabels(null), []);
  assert.deepEqual(normalizeLabels(''), []);
  assert.throws(() => normalizeLabels([1]), (err) => err.code === 'invalid_labels');
});

test('--idem для задачи: повтор не создаёт дубль и возвращает существующую', (t) => {
  const box = createSandbox(t, 'rat-m1-store-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const first = createIssue(wrapper, { title: 'Идемпотентная', idem: '11111111-1111-4111-8111-111111111111' });
  const second = createIssue(wrapper, { title: 'Идемпотентная', idem: '11111111-1111-4111-8111-111111111111' });

  assert.equal(first.id, 'RAT-1');
  assert.equal(second.id, 'RAT-1');
  assert.equal(second.deduplicated, true);
  assert.equal(wrapper.db.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 1);
  const events = listEvents(wrapper, { issueId: 'RAT-1', kind: 'created' });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.idem, '11111111-1111-4111-8111-111111111111');

  const third = createIssue(wrapper, { title: 'Другая', idem: '22222222-2222-4222-8222-222222222222' });
  assert.equal(third.id, 'RAT-2');
  assert.equal(third.deduplicated, false);
});

test('changeStatus: doing ставит actor, done/cancel закрывают, reopen очищает', (t) => {
  const box = createSandbox(t, 'rat-m1-store-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const issue = createIssue(wrapper, { title: 'Цикл' });
  const doing = changeStatus(wrapper, {
    ref: issue.id,
    status: 'doing',
    actor: 'agent:test',
  });
  assert.equal(doing.issue.status, 'doing');
  assert.equal(doing.issue.assignee, 'agent:test');
  assert.equal(doing.issue.updated_at, doing.event.ts);
  assert.equal(doing.event.kind, 'status');
  assert.deepEqual(doing.event.data, { from: 'open', to: 'doing', reason: null });

  const done = changeStatus(wrapper, {
    ref: issue.id,
    status: 'done',
    reason: 'готово',
    actor: 'agent:test',
  });
  assert.equal(done.issue.status, 'done');
  assert.equal(done.issue.closed_at, done.event.ts);
  assert.equal(done.issue.close_reason, 'готово');
  assert.equal(done.issue.updated_at, done.event.ts);

  assert.throws(
    () => changeStatus(wrapper, { ref: issue.id, status: 'doing' }),
    (err) => err.code === 'issue_closed' && err.exitCode === 3 && /rat reopen RAT-1/.test(err.hint),
  );
  assert.throws(
    () => changeStatus(wrapper, { ref: issue.id, status: 'cancelled' }),
    (err) => err.code === 'issue_closed' && err.exitCode === 3,
  );

  const reopened = changeStatus(wrapper, { ref: issue.id, status: 'open', actor: 'me' });
  assert.equal(reopened.issue.status, 'open');
  assert.equal(reopened.issue.closed_at, null);
  assert.equal(reopened.issue.close_reason, null);
  assert.deepEqual(reopened.event.data, { from: 'done', to: 'open', reason: null });

  const cancelled = changeStatus(wrapper, { ref: issue.id, status: 'cancelled', reason: 'не нужно' });
  assert.equal(cancelled.issue.status, 'cancelled');
  assert.equal(cancelled.issue.closed_at, cancelled.event.ts);
  assert.equal(cancelled.issue.close_reason, 'не нужно');

  const fromCancel = changeStatus(wrapper, { ref: issue.id, status: 'open' });
  assert.equal(fromCancel.issue.status, 'open');
  assert.equal(fromCancel.issue.closed_at, null);

  assert.throws(
    () => changeStatus(wrapper, { ref: issue.id, status: 'nope' }),
    (err) => err.code === 'invalid_status' && err.exitCode === 2,
  );
  assert.deepEqual(ISSUE_STATUSES, ['open', 'doing', 'blocked', 'deferred', 'done', 'cancelled']);
});

test('changeStatus: deferred — не закрывает, обратимо свободно, не входит в active', (t) => {
  const box = createSandbox(t, 'rat-m1-store-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const issue = createIssue(wrapper, { title: 'Отложить' });
  const deferred = changeStatus(wrapper, {
    ref: issue.id,
    status: 'deferred',
    reason: 'ждём данных',
    actor: 'me',
  });
  assert.equal(deferred.issue.status, 'deferred');
  // deferred — не закрытый статус: closed_at/close_reason не заполняются.
  assert.equal(deferred.issue.closed_at, null);
  assert.equal(deferred.issue.close_reason, null);
  assert.equal(deferred.issue.updated_at, deferred.event.ts);
  assert.deepEqual(deferred.event.data, { from: 'open', to: 'deferred', reason: null });

  // Из deferred уходить можно свободно — reopen не нужен.
  const back = changeStatus(wrapper, { ref: issue.id, status: 'doing', actor: 'me' });
  assert.equal(back.issue.status, 'doing');
  assert.equal(back.issue.closed_at, null);

  // Этого формата придерживается и assignee: deferred не ставит actor автоматически.
  const again = changeStatus(wrapper, { ref: issue.id, status: 'deferred', actor: 'me' });
  assert.equal(again.issue.status, 'deferred');

  // deferred не попадает ни в active, ни в next (ищет только open).
  const active = searchIssues(wrapper, { status: 'active' });
  assert.equal(active.issues.some((item) => item.id === issue.id), false);

  const counts = listProjectsWithCounts(wrapper).find((project) => project.key === 'RAT');
  assert.deepEqual(counts.counts, {
    open: 0,
    doing: 0,
    blocked: 0,
    deferred: 1,
    done: 0,
    cancelled: 0,
    total: 1,
  });

  const stats = getStats(wrapper);
  assert.equal(stats.totals.byStatus.deferred, 1);
});

test('claimIssue: doing + assignee=actor, событие kind=claim, на закрытой → конфликт', (t) => {
  const box = createSandbox(t, 'rat-m1-store-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const issue = createIssue(wrapper, { title: 'Взять' });
  const claimed = claimIssue(wrapper, { ref: issue.id, actor: 'agent:claude' });
  assert.equal(claimed.issue.status, 'doing');
  assert.equal(claimed.issue.assignee, 'agent:claude');
  assert.equal(claimed.event.kind, 'claim');
  assert.deepEqual(claimed.event.data, {
    from: 'open',
    to: 'doing',
    assignee: 'agent:claude',
  });
  assert.equal(claimed.issue.updated_at, claimed.event.ts);

  const kinds = listEvents(wrapper, { issueId: issue.id }).map((event) => event.kind);
  assert.deepEqual(kinds, ['created', 'claim']);

  changeStatus(wrapper, { ref: issue.id, status: 'done' });
  assert.throws(
    () => claimIssue(wrapper, { ref: issue.id, actor: 'agent:claude' }),
    (err) => err.code === 'issue_closed' && err.exitCode === 3,
  );
});

test('addComment: неизменяемо, обновляет updated_at, --idem без дубля', (t) => {
  const box = createSandbox(t, 'rat-m1-store-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const issue = createIssue(wrapper, { title: 'Комментарии' });
  const comment = addComment(wrapper, {
    ref: issue.id,
    text: 'Первый комментарий',
    actor: 'agent:test',
  });
  assert.equal(comment.kind, 'comment');
  assert.equal(comment.issue, 'RAT-1');
  assert.deepEqual(comment.data, { text: 'Первый комментарий' });
  assert.equal(comment.deduplicated, false);

  const updated = getIssue(wrapper, issue.id);
  assert.equal(updated.updated_at, comment.ts);

  const second = addComment(wrapper, { ref: issue.id, text: 'Второй' });
  assert.notEqual(second.id, comment.id);
  assert.equal(listEvents(wrapper, { issueId: issue.id, kind: 'comment' }).length, 2);

  assert.throws(
    () => addComment(wrapper, { ref: issue.id, text: '   ' }),
    (err) => err.code === 'empty_comment' && err.exitCode === 2,
  );

  const idem = '33333333-3333-4333-8333-333333333333';
  const a = addComment(wrapper, { ref: issue.id, text: 'Идем', idem });
  const b = addComment(wrapper, { ref: issue.id, text: 'Идем', idem });
  assert.equal(a.id, b.id);
  assert.equal(b.deduplicated, true);
  assert.equal(listEvents(wrapper, { issueId: issue.id, kind: 'comment' }).length, 3);
});

test('getIssueDetail: issue + последние N событий в хронологическом порядке', (t) => {
  const box = createSandbox(t, 'rat-m1-store-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const issue = createIssue(wrapper, { title: 'Деталь' });
  claimIssue(wrapper, { ref: issue.id, actor: 'agent:test' });
  addComment(wrapper, { ref: issue.id, text: 'комментарий' });
  changeStatus(wrapper, { ref: issue.id, status: 'done', reason: 'ок' });

  const all = getIssueDetail(wrapper, { ref: 'rat-1' });
  assert.equal(all.issue.id, 'RAT-1');
  assert.equal(all.issue.status, 'done');
  assert.deepEqual(all.events.map((event) => event.kind), ['created', 'claim', 'comment', 'status']);
  assert.deepEqual(Object.keys(all.events[0]).sort(), [
    'actor',
    'data',
    'id',
    'issue',
    'kind',
    'project',
    'ts',
  ]);
  assert.equal(all.events[0].issue_id, undefined);
  assert.equal(all.events[0].issue, 'RAT-1');
  assert.equal(all.events[0].project, 'RAT');
  for (let i = 1; i < all.events.length; i += 1) {
    assert.ok(all.events[i].ts >= all.events[i - 1].ts);
  }

  const lastTwo = getIssueDetail(wrapper, { ref: issue.id, events: 2 });
  assert.deepEqual(lastTwo.events.map((event) => event.kind), ['comment', 'status']);

  const none = getIssueDetail(wrapper, { ref: issue.id, events: 0 });
  assert.deepEqual(none.events, []);
});
