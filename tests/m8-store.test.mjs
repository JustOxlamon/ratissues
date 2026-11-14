import test from 'node:test';
import assert from 'node:assert/strict';

import { listCanon } from '../src/core/query.mjs';
import {
  createCanon,
  createIssue,
  createProject,
  getCanon,
  initDatabase,
  reactivateCanon,
  repealCanon,
  updateCanon,
} from '../src/core/store.mjs';
import { createSandbox } from './helpers.mjs';

/** Фиксированный порядок полей serializeCanon (публичный контракт). */
const CANON_KEYS = [
  'id',
  'project',
  'num',
  'title',
  'body',
  'status',
  'priority',
  'labels',
  'source_issue',
  'supersedes',
  'created_at',
  'updated_at',
  'repealed_at',
  'repeal_reason',
  'created_by',
  'repealed_by',
  'meta',
];

function setup(t) {
  const box = createSandbox(t, 'rat-m8-store-');
  const wrapper = box.open();
  initDatabase(wrapper);
  return { box, wrapper };
}

function eventCount(wrapper) {
  return Number(wrapper.db.prepare('SELECT COUNT(*) AS n FROM events').get().n);
}

test('createCanon: поля, нормализация, num RAT-C1, порядок полей', (t) => {
  const { wrapper } = setup(t);

  const rule = createCanon(wrapper, {
    project: 'RAT',
    title: '  Только node:*  ',
    body: 'Никаких npm-зависимостей',
    priority: '1',
    labels: ['Runtime', 'runtime', 'deps'],
    actor: 'tester',
  });

  assert.deepEqual(Object.keys(rule), CANON_KEYS);
  assert.equal(rule.id, 'RAT-C1');
  assert.equal(rule.project, 'RAT');
  assert.equal(rule.num, 1);
  assert.equal(rule.title, 'Только node:*');
  assert.equal(rule.body, 'Никаких npm-зависимостей');
  assert.equal(rule.status, 'active');
  assert.equal(rule.priority, 1);
  assert.deepEqual(rule.labels, ['deps', 'runtime']);
  assert.equal(rule.source_issue, null);
  assert.equal(rule.supersedes, null);
  assert.equal(rule.repealed_at, null);
  assert.equal(rule.repeal_reason, null);
  assert.equal(rule.created_by, 'tester');
  assert.equal(rule.repealed_by, null);

  const second = createCanon(wrapper, { project: 'RAT', title: 'Второе' });
  assert.equal(second.id, 'RAT-C2');
  assert.equal(second.num, 2);

  assert.equal(eventCount(wrapper), 0, 'канон не пишет событий');

  assert.throws(
    () => createCanon(wrapper, { project: 'RAT', title: 'bad', priority: 9 }),
    (err) => err.code === 'invalid_priority' && err.exitCode === 2,
  );
  assert.throws(
    () => createCanon(wrapper, { project: 'RAT', title: '   ' }),
    (err) => err.code === 'required_field' && err.exitCode === 2,
  );
});

test('createCanon: одинаковые номера в разных проектах допустимы', (t) => {
  const { wrapper } = setup(t);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });

  const rat = createCanon(wrapper, { project: 'RAT', title: 'Для RAT' });
  const axel = createCanon(wrapper, { project: 'AXEL', title: 'Для AXEL' });

  assert.equal(rat.id, 'RAT-C1');
  assert.equal(axel.id, 'AXEL-C1');
});

test('createCanon: source_issue — задача в проекте правила', (t) => {
  const { wrapper } = setup(t);
  const issue = createIssue(wrapper, { title: 'Развилка' });

  const withSource = createCanon(wrapper, {
    project: 'RAT',
    title: 'Из задачи',
    source: issue.id,
  });
  assert.equal(withSource.source_issue, 'RAT-1');

  assert.throws(
    () => createCanon(wrapper, { project: 'RAT', title: 'Несуществующая', source: 'RAT-99' }),
    (err) => err.code === 'source_issue_not_found' && err.exitCode === 1,
  );
  assert.throws(
    () => createCanon(wrapper, { project: 'RAT', title: 'Плохой формат', source: 'мум-мум' }),
    (err) => err.code === 'invalid_source' && err.exitCode === 2,
  );
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });
  assert.throws(
    () => createCanon(wrapper, { project: 'RAT', title: 'Чужой проект', source: 'AXEL-1' }),
    (err) => err.code === 'invalid_source' && err.exitCode === 2,
  );
});

test('createCanon: --supersedes авто-repeal цели и обратная ссылка', (t) => {
  const { wrapper } = setup(t);
  const first = createCanon(wrapper, { project: 'RAT', title: 'Старое', actor: 'tester' });
  const second = createCanon(wrapper, {
    project: 'RAT',
    title: 'Новое',
    supersedes: first.id,
    actor: 'tester',
  });

  assert.equal(second.status, 'active');
  assert.equal(second.supersedes, first.id);

  const old = getCanon(wrapper, first.id);
  assert.equal(old.status, 'repealed');
  assert.equal(old.repeal_reason, `заменено правилом ${second.id}`);
  assert.equal(old.repealed_by, 'tester');
  assert.equal(old.meta.superseded_by, second.id);
  assert.notEqual(old.repealed_at, null);

  assert.equal(eventCount(wrapper), 0);
});

test('createCanon: --supersedes конфликты (не активное, чужой проект, нет цели)', (t) => {
  const { wrapper } = setup(t);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });
  const active = createCanon(wrapper, { project: 'RAT', title: 'Активное' });
  createCanon(wrapper, { project: 'AXEL', title: 'Чужое' });
  repealCanon(wrapper, { ref: active.id, reason: 'стоп' });

  assert.throws(
    () => createCanon(wrapper, { project: 'RAT', title: 'X', supersedes: active.id }),
    (err) => err.code === 'canon_not_active' && err.exitCode === 3,
  );
  assert.throws(
    () => createCanon(wrapper, { project: 'RAT', title: 'X', supersedes: 'AXEL-C1' }),
    (err) => err.code === 'invalid_supersedes' && err.exitCode === 2,
  );
  assert.throws(
    () => createCanon(wrapper, { project: 'RAT', title: 'X', supersedes: 'RAT-C9' }),
    (err) => err.code === 'canon_not_found' && err.exitCode === 1,
  );
});

test('updateCanon: поля меняются, no-op не трогает updated_at, событий нет', async (t) => {
  const { wrapper } = setup(t);
  const rule = createCanon(wrapper, { project: 'RAT', title: 'Сырое', labels: 'deps' });

  const edited = updateCanon(wrapper, {
    ref: rule.id,
    title: 'Готовое',
    body: 'Контекст',
    priority: 0,
    labels: { add: ['runtime'], remove: ['deps'] },
  });
  assert.equal(edited.title, 'Готовое');
  assert.equal(edited.body, 'Контекст');
  assert.equal(edited.priority, 0);
  assert.deepEqual(edited.labels, ['runtime']);
  assert.equal(eventCount(wrapper), 0);

  await new Promise((resolve) => setTimeout(resolve, 10));
  const noop = updateCanon(wrapper, {
    ref: rule.id,
    title: 'Готовое',
    body: 'Контекст',
    priority: 0,
    labels: ['runtime'],
  });
  assert.deepEqual(noop, edited, 'no-op возвращает текущее состояние');
  assert.equal(noop.updated_at, edited.updated_at);
});

test('repeal/reactivate: переходы, no-op, повторные вызовы не меняют updated_at', async (t) => {
  const { wrapper } = setup(t);
  const rule = createCanon(wrapper, { project: 'RAT', title: 'Правило', actor: 'tester' });

  const repealed = repealCanon(wrapper, { ref: rule.id, reason: 'устарело', actor: 'tester' });
  assert.equal(repealed.status, 'repealed');
  assert.notEqual(repealed.repealed_at, null);
  assert.equal(repealed.repeal_reason, 'устарело');
  assert.equal(repealed.repealed_by, 'tester');

  await new Promise((resolve) => setTimeout(resolve, 10));
  const again = repealCanon(wrapper, { ref: rule.id, reason: 'другое' });
  assert.equal(again.status, 'repealed');
  assert.equal(again.updated_at, repealed.updated_at, 'повторный repeal — no-op');
  assert.equal(again.repeal_reason, 'устарело');

  const active = reactivateCanon(wrapper, { ref: rule.id, actor: 'tester' });
  assert.equal(active.status, 'active');
  assert.equal(active.repealed_at, null);
  assert.equal(active.repeal_reason, null);
  assert.equal(active.repealed_by, null);

  await new Promise((resolve) => setTimeout(resolve, 10));
  const againActive = reactivateCanon(wrapper, { ref: rule.id });
  assert.equal(againActive.updated_at, active.updated_at, 'повторный reactivate — no-op');

  assert.equal(eventCount(wrapper), 0);
});

test('правка отменённого правила разрешена и сохраняется после reactivate', (t) => {
  const { wrapper } = setup(t);
  const rule = createCanon(wrapper, { project: 'RAT', title: 'Старое' });
  repealCanon(wrapper, { ref: rule.id, reason: 'переформулируем' });

  const edited = updateCanon(wrapper, { ref: rule.id, title: 'Переформулировано' });
  assert.equal(edited.status, 'repealed');
  assert.equal(edited.title, 'Переформулировано');

  const active = reactivateCanon(wrapper, { ref: rule.id });
  assert.equal(active.status, 'active');
  assert.equal(active.title, 'Переформулировано');
});

test('listCanon: state, label, q, сортировка active → priority → created_at', (t) => {
  const { wrapper } = setup(t);
  const c1 = createCanon(wrapper, { project: 'RAT', title: 'Низкий приоритет', priority: 2, labels: 'deps' });
  const c2 = createCanon(wrapper, { project: 'RAT', title: 'Важное правильно', priority: 0, labels: 'runtime' });
  const c3 = createCanon(wrapper, { project: 'RAT', title: 'Отменённое', priority: 1 });
  repealCanon(wrapper, { ref: c3.id, reason: 'нет' });

  const active = listCanon(wrapper, { project: 'RAT' });
  assert.deepEqual(active.map((rule) => rule.id), [c2.id, c1.id], 'active: priority asc');

  const all = listCanon(wrapper, { project: 'RAT', state: 'all' });
  assert.deepEqual(all.map((rule) => rule.id), [c2.id, c1.id, c3.id]);

  const repealed = listCanon(wrapper, { project: 'RAT', state: 'repealed' });
  assert.deepEqual(repealed.map((rule) => rule.id), [c3.id]);

  const byLabel = listCanon(wrapper, { project: 'RAT', label: 'deps' });
  assert.deepEqual(byLabel.map((rule) => rule.id), [c1.id]);

  const byQ = listCanon(wrapper, { project: 'RAT', q: 'важное' });
  assert.deepEqual(byQ.map((rule) => rule.id), [c2.id]);

  const crossProject = listCanon(wrapper, { state: 'all' });
  assert.ok(crossProject.some((rule) => rule.id === c1.id));
});

test('getCanon: KEY-C1, C1 и голое число в scope проекта', (t) => {
  const { wrapper } = setup(t);
  const rule = createCanon(wrapper, { project: 'RAT', title: 'Правило' });

  assert.equal(getCanon(wrapper, rule.id).title, 'Правило');
  assert.equal(getCanon(wrapper, 'C1', { projectKey: 'RAT' }).id, 'RAT-C1');
  assert.equal(getCanon(wrapper, '1', { projectKey: 'RAT' }).id, 'RAT-C1');
  assert.throws(
    () => getCanon(wrapper, 'RAT-C9'),
    (err) => err.code === 'canon_not_found' && err.exitCode === 1,
  );
  assert.throws(
    () => getCanon(wrapper, 'мусор'),
    (err) => err.code === 'invalid_canon_ref' && err.exitCode === 2,
  );
});