import test from 'node:test';
import assert from 'node:assert/strict';

import { listEvents } from '../src/core/events.mjs';
import { searchIssues } from '../src/core/query.mjs';
import {
  changeStatus,
  createIssue,
  createMilestone,
  createProject,
  editIssue,
  getIssue,
  initDatabase,
  updateIssue,
  updateMilestone,
} from '../src/core/store.mjs';
import { createSandbox } from './helpers.mjs';

const MILESTONE_KEYS = [
  'body',
  'closed_at',
  'created_at',
  'due_at',
  'name',
  'progress',
  'project',
  'state',
  'updated_at',
];

function setup(t) {
  const box = createSandbox(t, 'rat-m7-store-');
  const wrapper = box.open();
  initDatabase(wrapper);
  return { box, wrapper };
}

test('createMilestone: поля, нулевой progress и due_at = 00:00 UTC', (t) => {
  const { wrapper } = setup(t);

  const milestone = createMilestone(wrapper, {
    project: 'RAT',
    name: '  v1.0  ',
    body: 'Первый релиз',
    due: '2026-12-31',
  });

  assert.deepEqual(Object.keys(milestone).sort(), MILESTONE_KEYS);
  assert.equal(milestone.project, 'RAT');
  assert.equal(milestone.name, 'v1.0');
  assert.equal(milestone.body, 'Первый релиз');
  assert.equal(milestone.due_at, Date.UTC(2026, 11, 31));
  assert.equal(milestone.state, 'open');
  assert.equal(milestone.closed_at, null);
  assert.deepEqual(milestone.progress, { total: 0, done: 0, cancelled: 0, percent: 0 });

  assert.throws(
    () => createMilestone(wrapper, { project: 'RAT', name: 'bad', due: '2026-02-30' }),
    (err) => err.code === 'invalid_due' && err.exitCode === 2,
  );
});

test('createMilestone: дубль имени без учёта регистра, включая кириллицу', (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });
  createMilestone(wrapper, { project: 'RAT', name: 'Бета' });

  assert.throws(
    () => createMilestone(wrapper, { project: 'RAT', name: 'V1.0' }),
    (err) => err.code === 'milestone_exists' && err.exitCode === 3,
  );
  assert.throws(
    () => createMilestone(wrapper, { project: 'RAT', name: 'бета' }),
    (err) => err.code === 'milestone_exists' && err.exitCode === 3,
  );
});

test('createMilestone: одинаковое имя в разных проектах разрешено', (t) => {
  const { wrapper } = setup(t);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });

  const rat = createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });
  const axel = createMilestone(wrapper, { project: 'AXEL', name: 'v1.0' });

  assert.equal(rat.project, 'RAT');
  assert.equal(axel.project, 'AXEL');
});

test('createIssue: привязка к милстоуну и data.milestone в created-событии', (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });

  const issue = createIssue(wrapper, { title: 'В релиз', milestone: 'v1.0' });
  assert.equal(issue.milestone, 'v1.0');

  const events = listEvents(wrapper, { issueId: 1, limit: 10 }).map((event) => ({
    kind: event.kind,
    data: event.data,
  }));
  assert.deepEqual(events, [{ kind: 'created', data: { milestone: 'v1.0' } }]);

  const plain = createIssue(wrapper, { title: 'Без милстоуна' });
  assert.equal(plain.milestone, null);
  const plainEvent = listEvents(wrapper, { issueId: 2, limit: 1 })[0];
  assert.deepEqual(plainEvent.data, {});
});

test('editIssue: привязка/отвязка и ровно одно событие edit', (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });
  const issue = createIssue(wrapper, { title: 'Задача' });

  const attached = editIssue(wrapper, { ref: issue.id, changes: { milestone: 'v1.0' } });
  assert.equal(attached.issue.milestone, 'v1.0');
  assert.equal(attached.events.length, 1);
  assert.deepEqual(attached.events[0].data, {
    field: 'milestone',
    from: null,
    to: 'v1.0',
  });

  const repeated = editIssue(wrapper, { ref: issue.id, changes: { milestone: 'v1.0' } });
  assert.equal(repeated.events.length, 0);
  assert.equal(repeated.issue.milestone, 'v1.0');

  const detached = editIssue(wrapper, { ref: issue.id, changes: { milestone: null } });
  assert.equal(detached.issue.milestone, null);
  assert.equal(detached.events.length, 1);
  assert.deepEqual(detached.events[0].data, {
    field: 'milestone',
    from: 'v1.0',
    to: null,
  });

  for (const value of ['-', 'none']) {
    editIssue(wrapper, { ref: issue.id, changes: { milestone: 'v1.0' } });
    const result = editIssue(wrapper, { ref: issue.id, changes: { milestone: value } });
    assert.equal(result.issue.milestone, null, `отвязка через ${value}`);
    assert.equal(result.events.length, 1);
  }
});

test('updateIssue: привязка/отвязка (вторая точка записи)', (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });
  const issue = createIssue(wrapper, { title: 'Задача' });

  const attached = updateIssue(wrapper, { issueRef: issue.id, milestone: 'v1.0' });
  assert.equal(attached.issue.milestone, 'v1.0');
  assert.equal(attached.events.length, 1);
  assert.deepEqual(attached.events[0].data, {
    field: 'milestone',
    from: null,
    to: 'v1.0',
  });

  const repeated = updateIssue(wrapper, { issueRef: issue.id, milestone: 'v1.0' });
  assert.equal(repeated.events.length, 0);

  const detached = updateIssue(wrapper, { issueRef: issue.id, milestone: '-' });
  assert.equal(detached.issue.milestone, null);
  assert.equal(detached.events.length, 1);
  assert.deepEqual(detached.events[0].data, {
    field: 'milestone',
    from: 'v1.0',
    to: null,
  });
});

test('привязка: чужой/несуществующий милстоун → UsageError invalid_milestone', (t) => {
  const { wrapper } = setup(t);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });
  createMilestone(wrapper, { project: 'AXEL', name: 'v1.0' });

  assert.throws(
    () => createIssue(wrapper, { project: 'RAT', title: 'Чужая', milestone: 'v1.0' }),
    (err) => err.code === 'invalid_milestone' && err.exitCode === 2,
  );

  const issue = createIssue(wrapper, { project: 'RAT', title: 'Задача' });
  assert.throws(
    () => editIssue(wrapper, { ref: issue.id, changes: { milestone: 'v1.0' } }),
    (err) => err.code === 'invalid_milestone' && err.exitCode === 2,
  );
  assert.throws(
    () => updateIssue(wrapper, { issueRef: issue.id, milestone: 'nope' }),
    (err) => err.code === 'invalid_milestone' && err.exitCode === 2,
  );
});

test('закрытый милстоун: ConflictError milestone_closed, после reopen привязка работает', (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });
  updateMilestone(wrapper, { ref: 'v1.0', project: 'RAT', state: 'closed' });

  assert.throws(
    () => createIssue(wrapper, { title: 'Поздняя', milestone: 'v1.0' }),
    (err) => err.code === 'milestone_closed' && err.exitCode === 3,
  );

  updateMilestone(wrapper, { ref: 'v1.0', project: 'RAT', state: 'open' });
  const issue = createIssue(wrapper, { title: 'Снова можно', milestone: 'v1.0' });
  assert.equal(issue.milestone, 'v1.0');
});

test('close не меняет статусы задач; closed_at ставится и очищается', (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });
  const openIssue = createIssue(wrapper, { title: 'Открытая', milestone: 'v1.0' });
  const doingIssue = createIssue(wrapper, { title: 'В работе', milestone: 'v1.0' });
  changeStatus(wrapper, { ref: doingIssue.id, status: 'doing' });

  const closed = updateMilestone(wrapper, { ref: 'v1.0', project: 'RAT', state: 'closed' });
  assert.equal(closed.state, 'closed');
  assert.notEqual(closed.closed_at, null);
  assert.equal(getIssue(wrapper, openIssue.id).status, 'open');
  assert.equal(getIssue(wrapper, doingIssue.id).status, 'doing');

  const reopened = updateMilestone(wrapper, { ref: 'v1.0', project: 'RAT', state: 'open' });
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.closed_at, null);
});

test('повторный close/reopen — no-op, updated_at не меняется', async (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });
  const closed = updateMilestone(wrapper, { ref: 'v1.0', project: 'RAT', state: 'closed' });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const again = updateMilestone(wrapper, { ref: 'v1.0', project: 'RAT', state: 'closed' });
  assert.equal(again.state, 'closed');
  assert.equal(again.updated_at, closed.updated_at);

  const reopened = updateMilestone(wrapper, { ref: 'v1.0', project: 'RAT', state: 'open' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reopenedAgain = updateMilestone(wrapper, { ref: 'v1.0', project: 'RAT', state: 'open' });
  assert.equal(reopenedAgain.updated_at, reopened.updated_at);
});

test('progress: floor(done*100/(total-cancelled)), пустой → 0', (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });
  const ids = [];
  for (let index = 1; index <= 4; index += 1) {
    ids.push(createIssue(wrapper, { title: `Задача ${index}`, milestone: 'v1.0' }).id);
  }
  changeStatus(wrapper, { ref: ids[0], status: 'done' });
  changeStatus(wrapper, { ref: ids[1], status: 'done' });
  changeStatus(wrapper, { ref: ids[2], status: 'cancelled' });

  const milestone = updateMilestone(wrapper, { ref: 'v1.0', project: 'RAT' });
  assert.deepEqual(milestone.progress, { total: 4, done: 2, cancelled: 1, percent: 66 });

  const empty = createMilestone(wrapper, { project: 'RAT', name: 'empty' });
  assert.deepEqual(empty.progress, { total: 0, done: 0, cancelled: 0, percent: 0 });
  assert.equal(Number.isNaN(empty.progress.percent), false);
});

test('переименование сохраняет привязки и обновляет имя у задач', (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });
  const issue = createIssue(wrapper, { title: 'Задача', milestone: 'v1.0' });
  const select = 'SELECT milestone_id FROM issues WHERE project_key = ? AND num = ?';
  const before = wrapper.db.prepare(select).get('RAT', 1);

  const renamed = updateMilestone(wrapper, { ref: 'v1.0', project: 'RAT', name: 'v2.0' });
  assert.equal(renamed.name, 'v2.0');

  const after = wrapper.db.prepare(select).get('RAT', 1);
  assert.equal(after.milestone_id, before.milestone_id);
  assert.equal(getIssue(wrapper, issue.id).milestone, 'v2.0');

  assert.throws(
    () => updateMilestone(wrapper, { ref: 'v1.0', project: 'RAT' }),
    (err) => err.code === 'milestone_not_found' && err.exitCode === 1,
  );
});

test('searchIssues({ milestone }): имя, none и регистронезависимость', (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'Beta' });
  const beta = createIssue(wrapper, { title: 'В бете', milestone: 'Beta' });
  const none = createIssue(wrapper, { title: 'Без милстоуна' });

  const byName = searchIssues(wrapper, { status: 'all', milestone: 'beta' });
  assert.deepEqual(byName.issues.map((issue) => issue.id), [beta.id]);

  const byRaw = searchIssues(wrapper, { status: 'all', milestone: 'Beta' });
  assert.deepEqual(byRaw.issues.map((issue) => issue.id), [beta.id]);

  const without = searchIssues(wrapper, { status: 'all', milestone: 'none' });
  assert.deepEqual(without.issues.map((issue) => issue.id), [none.id]);

  const all = searchIssues(wrapper, { status: 'all' });
  assert.equal(all.issues.length, 2);
});
