import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createApiHandler } from '../src/server/api.mjs';
import { createServer } from '../src/server/http.mjs';
import { createIssue, createMilestone, initDatabase } from '../src/core/store.mjs';
import { createSandbox, REPO_ROOT } from './helpers.mjs';

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

async function setup(t) {
  const box = createSandbox(t, 'rat-m7-api-');
  const wrapper = box.open();
  initDatabase(wrapper);

  const webDir = path.join(REPO_ROOT, 'web');
  const server = createServer({ wrapper, webDir, quiet: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  t.after(() => {
    server.close();
    box.close();
  });

  const address = server.address();
  return { box, wrapper, server, base: `http://127.0.0.1:${address.port}` };
}

async function request(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }
  return { res, text, json };
}

function get(base, path) {
  return request(base, 'GET', path);
}

function post(base, path, body) {
  return request(base, 'POST', path, body);
}

function patch(base, path, body) {
  return request(base, 'PATCH', path, body);
}

test('POST /api/milestones: 201, поля, progress и due_at из YYYY-MM-DD', async (t) => {
  const { base } = await setup(t);

  const created = await post(base, '/api/milestones', {
    project: 'RAT',
    name: 'v1.0',
    body: 'Релиз',
    due_at: '2026-12-31',
  });
  assert.equal(created.res.status, 201);
  assert.equal(created.res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(created.json).sort(), MILESTONE_KEYS);
  assert.equal(created.json.name, 'v1.0');
  assert.equal(created.json.body, 'Релиз');
  assert.equal(created.json.due_at, Date.UTC(2026, 11, 31));
  assert.equal(created.json.state, 'open');
  assert.deepEqual(created.json.progress, { total: 0, done: 0, cancelled: 0, percent: 0 });

  const epoch = await post(base, '/api/milestones', { name: 'v1.1', due_at: 1_800_000_000_000 });
  assert.equal(epoch.res.status, 201);
  assert.equal(epoch.json.due_at, 1_800_000_000_000);
});

test('GET /api/milestones: project/state/all и порядок', async (t) => {
  const { base, wrapper } = await setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0', due: '2026-01-01' });
  createMilestone(wrapper, { project: 'RAT', name: 'v2.0' });
  createMilestone(wrapper, { project: 'RAT', name: 'v0.9', due: '2025-01-01' });
  const closed = await patch(base, '/api/milestones/v0.9?project=RAT', { state: 'closed' });
  assert.equal(closed.res.status, 200);

  const open = await get(base, '/api/milestones?project=RAT');
  assert.equal(open.res.status, 200);
  assert.equal(open.res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(open.json.milestones.map((milestone) => milestone.name), ['v1.0', 'v2.0']);

  const all = await get(base, '/api/milestones?project=RAT&state=all');
  assert.deepEqual(
    all.json.milestones.map((milestone) => milestone.name),
    ['v1.0', 'v2.0', 'v0.9'],
  );

  const withoutProject = await get(base, '/api/milestones?state=all');
  assert.equal(withoutProject.json.milestones.length, 3);
});

test('PATCH /api/milestones/:ref: имя/срок/state, project обязателен, percent-encoding', async (t) => {
  const { base, wrapper } = await setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'Релиз 1.0', due: '2026-01-01' });

  const encoded = encodeURIComponent('Релиз 1.0');
  const renamed = await patch(base, `/api/milestones/${encoded}?project=RAT`, {
    name: 'Релиз 2.0',
    due_at: '2027-03-04',
  });
  assert.equal(renamed.res.status, 200);
  assert.equal(renamed.json.name, 'Релиз 2.0');
  assert.equal(renamed.json.due_at, Date.UTC(2027, 2, 4));

  const cleared = await patch(base, `/api/milestones/${encodeURIComponent('Релиз 2.0')}`, {
    project: 'RAT',
    clear_due: true,
  });
  assert.equal(cleared.res.status, 200);
  assert.equal(cleared.json.due_at, null);

  const closed = await patch(base, `/api/milestones/${encodeURIComponent('Релиз 2.0')}?project=RAT`, {
    state: 'closed',
  });
  assert.equal(closed.res.status, 200);
  assert.equal(closed.json.state, 'closed');
  assert.notEqual(closed.json.closed_at, null);

  const noProject = await patch(base, '/api/milestones/v1.0', { state: 'open' });
  assert.equal(noProject.res.status, 400);
  assert.equal(noProject.json.error.code, 'invalid_project');
});

test('GET /api/issues?milestone=NAME|none', async (t) => {
  const { base, wrapper } = await setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'Beta' });
  const inBeta = createIssue(wrapper, { title: 'В бете', milestone: 'Beta' });
  const without = createIssue(wrapper, { title: 'Без милстоуна' });

  const byName = await get(base, '/api/issues?status=all&milestone=beta');
  assert.equal(byName.res.status, 200);
  assert.deepEqual(byName.json.issues.map((issue) => issue.id), [inBeta.id]);

  const byNone = await get(base, '/api/issues?status=all&milestone=none');
  assert.deepEqual(byNone.json.issues.map((issue) => issue.id), [without.id]);
});

test('POST/PATCH /api/issues пробрасывают milestone, ответ содержит имя', async (t) => {
  const { base, wrapper } = await setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });

  const created = await post(base, '/api/issues', { title: 'В релиз', milestone: 'v1.0' });
  assert.equal(created.res.status, 201);
  assert.equal(created.json.milestone, 'v1.0');

  const plain = await post(base, '/api/issues', { title: 'Без' });
  assert.equal(plain.json.milestone, null);

  const attached = await patch(base, `/api/issues/${plain.json.id}`, { milestone: 'v1.0' });
  assert.equal(attached.res.status, 200);
  assert.equal(attached.json.issue.milestone, 'v1.0');

  const detached = await patch(base, `/api/issues/${plain.json.id}`, { milestone: null });
  assert.equal(detached.json.issue.milestone, null);
});

test('закрытый милстоун → 409 milestone_closed', async (t) => {
  const { base, wrapper } = await setup(t);
  createMilestone(wrapper, { project: 'RAT', name: 'v1.0' });
  await patch(base, '/api/milestones/v1.0?project=RAT', { state: 'closed' });

  const created = await post(base, '/api/issues', { title: 'Поздняя', milestone: 'v1.0' });
  assert.equal(created.res.status, 409);
  assert.equal(created.json.error.code, 'milestone_closed');

  const issue = createIssue(wrapper, { title: 'Обычная' });
  const patched = await patch(base, `/api/issues/${issue.id}`, { milestone: 'v1.0' });
  assert.equal(patched.res.status, 409);
  assert.equal(patched.json.error.code, 'milestone_closed');
});

test('405 на неподдерживаемые методы милстоунов, 404 на /api/milestones/x', async (t) => {
  const { base } = await setup(t);

  const patchCollection = await patch(base, '/api/milestones', { name: 'x' });
  assert.equal(patchCollection.res.status, 405);
  assert.equal(patchCollection.json.error.code, 'method_not_allowed');

  const postItem = await post(base, '/api/milestones/v1.0', { name: 'x' });
  assert.equal(postItem.res.status, 405);
  assert.equal(postItem.json.error.code, 'method_not_allowed');

  const missing = await get(base, '/api/milestones/x');
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error.code, 'not_found');
});

// Импорт нужен только чтобы убедиться, что handler экспортируется (как в m4/m5).
assert.equal(typeof createApiHandler, 'function');
