import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { appendEvent, listEvents, parseSince, resolveActor } from '../src/core/events.mjs';
import {
  getProject,
  normalizeProjectKey,
  resolveIssue,
  resolveProject,
} from '../src/core/query.mjs';
import { initDatabase } from '../src/core/store.mjs';
import { createSandbox, REPO_ROOT, seedIssue } from './helpers.mjs';

test('resolveActor: --actor → $RAT_ACTOR → cli', () => {
  assert.equal(resolveActor('agent:claude', { RAT_ACTOR: 'env' }), 'agent:claude');
  assert.equal(resolveActor(undefined, { RAT_ACTOR: 'env' }), 'env');
  assert.equal(resolveActor('', { RAT_ACTOR: 'env' }), 'env');
  assert.equal(resolveActor(undefined, {}), 'cli');
});

test('normalizeProjectKey: uppercase и проверка формата', () => {
  assert.equal(normalizeProjectKey(' rat '), 'RAT');
  assert.equal(normalizeProjectKey('axel3'), 'AXEL3');
  assert.throws(() => normalizeProjectKey('A'), /2–10/);
  assert.throws(() => normalizeProjectKey('RAT!'), /2–10/);
  assert.throws(() => normalizeProjectKey('СЛИШКОМДЛИННЫЙ'), /2–10/);
});

test('resolveProject: --project → $RAT_PROJECT → root_path → default', (t) => {
  const box = createSandbox(t, 'rat-query-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const byDefault = resolveProject(wrapper, { cwd: box.dir, env: {} });
  assert.equal(byDefault.key, 'RAT');
  assert.equal(byDefault.source, 'default');

  const byEnv = resolveProject(wrapper, { cwd: box.dir, env: { RAT_PROJECT: 'rat' } });
  assert.equal(byEnv.key, 'RAT');
  assert.equal(byEnv.source, 'env');

  const byFlag = resolveProject(wrapper, { project: 'RAT', cwd: box.dir, env: { RAT_PROJECT: 'ZZZ' } });
  assert.equal(byFlag.source, 'flag');

  const inRepo = resolveProject(wrapper, { cwd: path.join(REPO_ROOT, 'src'), env: {} });
  assert.equal(inRepo.key, 'RAT');
  assert.equal(inRepo.source, 'root_path');

  assert.throws(
    () => resolveProject(wrapper, { project: 'ZZZ', env: {} }),
    (err) => err.code === 'project_not_found' && err.exitCode === 1 && /rat project add/.test(err.hint),
  );
});

test('resolveProject: самый длинный root_path-префикс cwd', (t) => {
  const box = createSandbox(t, 'rat-query-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const now = Date.now();
  const insert = wrapper.db.prepare(
    'INSERT INTO projects(key, name, root_path, color, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run('WIDE', 'Широкий', box.dir, 'sky', now);
  insert.run('NARROW', 'Узкий', path.join(box.dir, 'sub'), 'amber', now);

  const resolved = resolveProject(wrapper, { cwd: path.join(box.dir, 'sub', 'deep'), env: {} });
  assert.equal(resolved.key, 'NARROW');
  assert.equal(resolved.source, 'root_path');

  const wide = resolveProject(wrapper, { cwd: path.join(box.dir, 'other'), env: {} });
  assert.equal(wide.key, 'WIDE');
});

test('getProject / resolveIssue работают с публичным id', (t) => {
  const box = createSandbox(t, 'rat-query-');
  const wrapper = box.open();
  initDatabase(wrapper);
  const id = seedIssue(wrapper.db, { num: 7, title: 'Седьмая' });

  assert.equal(getProject(wrapper, 'rat').key, 'RAT');
  assert.equal(getProject(wrapper, 'ZZZ'), null);

  const byPublicId = resolveIssue(wrapper, 'rat-7');
  assert.equal(Number(byPublicId.id), id);
  assert.equal(Number(resolveIssue(wrapper, 7, { projectKey: 'RAT' }).id), id);
  assert.throws(() => resolveIssue(wrapper, 'RAT-8'), (err) => err.code === 'issue_not_found');
});

test('appendEvent пишет событие с актором и публичным id', (t) => {
  const box = createSandbox(t, 'rat-events-');
  const wrapper = box.open();
  initDatabase(wrapper);
  const id = seedIssue(wrapper.db, { num: 1, title: 'Первая' });

  const created = appendEvent(wrapper, {
    issueId: 'RAT-1',
    kind: 'created',
    data: { title: 'Первая' },
    actor: 'agent:test',
    ts: 1000,
  });
  assert.equal(created.public_id, 'RAT-1');
  assert.equal(created.issue_id, id);
  assert.equal(created.actor, 'agent:test');
  assert.equal(created.ts, 1000);
  assert.equal(created.data.title, 'Первая');
  assert.equal(typeof created.id, 'number');

  const comment = appendEvent(wrapper, {
    issueId: id,
    kind: 'comment',
    data: { text: 'готово' },
    ts: 2000,
  });
  assert.equal(comment.actor, 'cli');
  assert.equal(comment.public_id, 'RAT-1');
});

test('appendEvent валидирует kind, data и существование задачи', (t) => {
  const box = createSandbox(t, 'rat-events-');
  const wrapper = box.open();
  initDatabase(wrapper);
  seedIssue(wrapper.db, { num: 1 });

  assert.throws(
    () => appendEvent(wrapper, { issueId: 'RAT-1', kind: 'unknown', data: {} }),
    (err) => err.code === 'invalid_event_kind' && err.exitCode === 2,
  );
  assert.throws(
    () => appendEvent(wrapper, { issueId: 'RAT-1', kind: 'comment', data: [] }),
    (err) => err.code === 'invalid_event_data',
  );
  assert.throws(
    () => appendEvent(wrapper, { issueId: 'RAT-99', kind: 'comment', data: {} }),
    (err) => err.code === 'issue_not_found' && err.exitCode === 1,
  );
});

test('listEvents: фильтры по задаче, проекту, since, kind, limit', (t) => {
  const box = createSandbox(t, 'rat-events-');
  const wrapper = box.open();
  initDatabase(wrapper);
  seedIssue(wrapper.db, { num: 1, title: 'Первая' });

  appendEvent(wrapper, { issueId: 'RAT-1', kind: 'created', data: {}, ts: 1000 });
  appendEvent(wrapper, { issueId: 'RAT-1', kind: 'comment', data: { text: 'a' }, ts: 2000 });
  appendEvent(wrapper, { issueId: 'RAT-1', kind: 'status', data: { from: 'open', to: 'doing' }, ts: 3000 });

  const all = listEvents(wrapper, { issueId: 'RAT-1' });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((event) => event.ts), [1000, 2000, 3000]);

  assert.equal(listEvents(wrapper, { projectKey: 'rat' }).length, 3);
  assert.equal(listEvents(wrapper, { since: 1500 }).length, 2);
  assert.equal(listEvents(wrapper, { kind: 'comment' }).length, 1);

  const limited = listEvents(wrapper, { limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].ts, 3000);

  assert.throws(
    () => listEvents(wrapper, { kind: 'nope' }),
    (err) => err.code === 'invalid_event_kind',
  );
});

test('parseSince понимает epoch ms, относительное время и ISO', () => {
  assert.equal(parseSince(null), null);
  assert.equal(parseSince(1234), 1234);
  const dayAgo = parseSince('1d');
  assert.ok(Math.abs(dayAgo - (Date.now() - 86_400_000)) < 5000);
  assert.equal(parseSince('2000-01-01T00:00:00.000Z'), Date.parse('2000-01-01T00:00:00.000Z'));
  assert.throws(() => parseSince('вчера'), (err) => err.code === 'invalid_since');
});
