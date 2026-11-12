import test from 'node:test';
import assert from 'node:assert/strict';

import { listEvents } from '../src/core/events.mjs';
import { searchIssues } from '../src/core/query.mjs';
import {
  archiveProject,
  changeStatus,
  createIssue,
  createProject,
  editIssue,
  getIssue,
  getIssueDetail,
  initDatabase,
  listProjectsWithCounts,
} from '../src/core/store.mjs';
import { createSandbox } from './helpers.mjs';

const EVENT_KEYS = ['actor', 'data', 'id', 'issue', 'kind', 'project', 'ts'];

test('editIssue: каждое изменённое поле → отдельное событие edit {field,from,to}', (t) => {
  const box = createSandbox(t, 'rat-m2-edit-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const issue = createIssue(wrapper, {
    title: 'Старое имя',
    body: 'старое тело',
    priority: 2,
    labels: 'y,ui',
    assignee: 'me',
    ref: 'src/x.mjs',
  });

  const result = editIssue(wrapper, {
    ref: issue.id,
    changes: {
      title: 'Новое имя',
      body: 'новое тело',
      priority: 0,
      assignee: 'agent:test',
      ref: 'src/y.mjs',
      labels: { add: ['x', 'BUG'], remove: ['y'] },
    },
    actor: 'agent:test',
  });

  assert.equal(result.issue.title, 'Новое имя');
  assert.equal(result.issue.body, 'новое тело');
  assert.equal(result.issue.priority, 0);
  assert.equal(result.issue.assignee, 'agent:test');
  assert.equal(result.issue.ref, 'src/y.mjs');
  assert.deepEqual(result.issue.labels, ['bug', 'ui', 'x']);

  assert.deepEqual(
    result.events.map((event) => event.data.field),
    ['title', 'body', 'priority', 'assignee', 'ref', 'labels'],
  );
  for (const event of result.events) {
    assert.equal(event.kind, 'edit');
    assert.equal(event.issue, 'RAT-1');
    assert.equal(event.actor, 'agent:test');
    assert.deepEqual(Object.keys(event).sort(), EVENT_KEYS);
    assert.deepEqual(Object.keys(event.data).sort(), ['field', 'from', 'to']);
    assert.equal(event.ts, result.issue.updated_at);
  }

  assert.deepEqual(result.events[0].data, {
    field: 'title',
    from: 'Старое имя',
    to: 'Новое имя',
  });
  assert.deepEqual(result.events[2].data, { field: 'priority', from: 2, to: 0 });
  assert.deepEqual(result.events[5].data, {
    field: 'labels',
    from: ['ui', 'y'],
    to: ['bug', 'ui', 'x'],
  });

  const events = listEvents(wrapper, { issueId: issue.id, kind: 'edit' });
  assert.equal(events.length, 6);
  assert.equal(getIssueDetail(wrapper, { ref: issue.id }).issue.updated_at, result.events[0].ts);

  // Полная замена набора меток (массив нормализуется).
  const replaced = editIssue(wrapper, { ref: issue.id, changes: { labels: ['Z', 'a', 'z'] } });
  assert.deepEqual(replaced.issue.labels, ['a', 'z']);
  assert.deepEqual(replaced.events[0].data, {
    field: 'labels',
    from: ['bug', 'ui', 'x'],
    to: ['a', 'z'],
  });

  // assignee можно очистить явным null.
  const cleared = editIssue(wrapper, { ref: issue.id, changes: { assignee: null } });
  assert.equal(cleared.issue.assignee, null);
  assert.deepEqual(cleared.events[0].data, { field: 'assignee', from: 'agent:test', to: null });
});

test('editIssue: no-op не пишет события и не двигает updated_at', (t) => {
  const box = createSandbox(t, 'rat-m2-edit-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const issue = createIssue(wrapper, { title: 'Та же', body: 'то же', labels: 'a,b' });
  const before = getIssue(wrapper, issue.id);
  const editCountBefore = listEvents(wrapper, { issueId: issue.id, kind: 'edit' }).length;

  const same = editIssue(wrapper, {
    ref: issue.id,
    changes: {
      title: 'Та же',
      body: 'то же',
      priority: 2,
      labels: { add: [], remove: [] },
      assignee: null,
      ref: null,
    },
  });
  assert.deepEqual(same.events, []);
  assert.equal(same.issue.updated_at, before.updated_at);
  assert.equal(listEvents(wrapper, { issueId: issue.id, kind: 'edit' }).length, editCountBefore);

  const empty = editIssue(wrapper, { ref: issue.id, changes: {} });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.issue.updated_at, before.updated_at);

  // Тот же набор меток в другом порядке — тоже no-op.
  const reordered = editIssue(wrapper, { ref: issue.id, changes: { labels: ['b', 'a'] } });
  assert.deepEqual(reordered.events, []);

  assert.throws(
    () => editIssue(wrapper, { ref: issue.id, changes: { nope: 1 } }),
    (err) => err.code === 'invalid_field' && err.exitCode === 2,
  );
  assert.throws(
    () => editIssue(wrapper, { ref: issue.id, changes: { title: '   ' } }),
    (err) => err.code === 'required_field' && err.exitCode === 2,
  );
  assert.throws(
    () => editIssue(wrapper, { ref: issue.id, changes: { priority: 9 } }),
    (err) => err.code === 'invalid_priority' && err.exitCode === 2,
  );
  assert.throws(
    () => editIssue(wrapper, { ref: issue.id, changes: { labels: { add: ['x'], zap: ['y'] } } }),
    (err) => err.code === 'invalid_labels' && err.exitCode === 2,
  );
  assert.throws(
    () => editIssue(wrapper, { ref: 'RAT-99', changes: { title: 'x' } }),
    (err) => err.code === 'issue_not_found' && err.exitCode === 1,
  );
});

test('editIssue: закрытую задачу править можно (ограничен только статус)', (t) => {
  const box = createSandbox(t, 'rat-m2-edit-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const issue = createIssue(wrapper, { title: 'Закрытая' });
  changeStatus(wrapper, { ref: issue.id, status: 'done', reason: 'ок' });

  const result = editIssue(wrapper, { ref: issue.id, changes: { title: 'Закрытая, но правленая' } });
  assert.equal(result.issue.status, 'done');
  assert.equal(result.issue.title, 'Закрытая, но правленая');
  assert.equal(result.events.length, 1);
});

test('archiveProject: скрывает из дефолтного списка, повтор → конфликт, задачи живы', (t) => {
  const box = createSandbox(t, 'rat-m2-edit-');
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });

  const axelIssue = createIssue(wrapper, { project: 'AXEL', title: 'Задача AXEL' });
  const archived = archiveProject(wrapper, { key: 'axel' });

  assert.equal(archived.key, 'AXEL');
  assert.equal(typeof archived.archived_at, 'number');
  assert.deepEqual(Object.keys(archived).sort(), [
    'archived_at',
    'color',
    'created_at',
    'key',
    'name',
    'root_path',
  ]);

  assert.deepEqual(listProjectsWithCounts(wrapper).map((project) => project.key), ['RAT']);
  const withArchived = listProjectsWithCounts(wrapper, { includeArchived: true });
  const axel = withArchived.find((project) => project.key === 'AXEL');
  assert.equal(typeof axel.archived_at, 'number');
  assert.equal(axel.counts.total, 1);

  assert.equal(getIssue(wrapper, axelIssue.id).title, 'Задача AXEL');
  assert.deepEqual(
    searchIssues(wrapper, { project: 'AXEL', status: 'all' }).issues.map((issue) => issue.id),
    ['AXEL-1'],
  );
  assert.equal(
    searchIssues(wrapper, { project: null, status: 'all' }).issues.some(
      (issue) => issue.project === 'AXEL',
    ),
    false,
  );

  assert.throws(
    () => archiveProject(wrapper, { key: 'AXEL' }),
    (err) => err.code === 'project_archived' && err.exitCode === 3,
  );
  assert.throws(
    () => archiveProject(wrapper, { key: 'ZZZ' }),
    (err) => err.code === 'project_not_found' && err.exitCode === 1,
  );
  assert.throws(
    () => archiveProject(wrapper, { key: 'A' }),
    (err) => err.code === 'invalid_project_key' && err.exitCode === 2,
  );
});
