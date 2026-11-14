import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createApiHandler } from '../src/server/api.mjs';
import { createServer } from '../src/server/http.mjs';
import { createCanon, createIssue, initDatabase } from '../src/core/store.mjs';
import { createSandbox, REPO_ROOT } from './helpers.mjs';

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

async function setup(t) {
  const box = createSandbox(t, 'rat-m8-api-');
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

async function request(base, method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
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

function get(base, pathname) {
  return request(base, 'GET', pathname);
}

function post(base, pathname, body) {
  return request(base, 'POST', pathname, body);
}

function patch(base, pathname, body) {
  return request(base, 'PATCH', pathname, body);
}

test('POST /api/canon: 201, поля, порядок полей, no-store', async (t) => {
  const { base, wrapper } = await setup(t);
  createIssue(wrapper, { title: 'Развилка' });

  const created = await post(base, '/api/canon', {
    project: 'RAT',
    title: 'Только node:*',
    body: 'Никаких npm',
    priority: 1,
    labels: ['runtime', 'deps'],
    source: 'RAT-1',
    actor: 'tester',
  });
  assert.equal(created.res.status, 201);
  assert.equal(created.res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(created.json), CANON_KEYS);
  assert.equal(created.json.id, 'RAT-C1');
  assert.equal(created.json.status, 'active');
  assert.deepEqual(created.json.labels, ['deps', 'runtime']);
  assert.equal(created.json.source_issue, 'RAT-1');
  assert.equal(created.json.created_by, 'tester');
});

test('GET /api/canon: project/state/label/q и порядок', async (t) => {
  const { base, wrapper } = await setup(t);
  const c1 = createCanon(wrapper, { project: 'RAT', title: 'Низкий', priority: 2, labels: 'deps' });
  const c2 = createCanon(wrapper, { project: 'RAT', title: 'Важное', priority: 0, labels: 'runtime' });
  createCanon(wrapper, { project: 'RAT', title: 'Отменённое', priority: 1 });
  const closed = await patch(base, '/api/canon/RAT-C3?project=RAT', { state: 'repealed', reason: 'нет' });
  assert.equal(closed.res.status, 200);

  const active = await get(base, '/api/canon?project=RAT');
  assert.equal(active.res.status, 200);
  assert.deepEqual(active.json.canon.map((rule) => rule.id), [c2.id, c1.id]);

  const all = await get(base, '/api/canon?project=RAT&state=all');
  assert.deepEqual(all.json.canon.map((rule) => rule.id), [c2.id, c1.id, 'RAT-C3']);

  const repealed = await get(base, '/api/canon?project=RAT&state=repealed');
  assert.deepEqual(repealed.json.canon.map((rule) => rule.id), ['RAT-C3']);

  const byLabel = await get(base, '/api/canon?project=RAT&state=all&label=deps');
  assert.deepEqual(byLabel.json.canon.map((rule) => rule.id), [c1.id]);

  const byQ = await get(base, '/api/canon?project=RAT&state=all&q=важное');
  assert.deepEqual(byQ.json.canon.map((rule) => rule.id), [c2.id]);
});

test('PATCH /api/canon/:ref: right fields и state; project из query и body', async (t) => {
  const { base, wrapper } = await setup(t);
  createCanon(wrapper, { project: 'RAT', title: 'Правило', labels: 'deps' });

  const edited = await patch(base, '/api/canon/RAT-C1?project=RAT', {
    title: 'Готовое',
    priority: 0,
    labels: { add: ['runtime'], remove: ['deps'] },
  });
  assert.equal(edited.res.status, 200);
  assert.equal(edited.json.title, 'Готовое');
  assert.equal(edited.json.priority, 0);
  assert.deepEqual(edited.json.labels, ['runtime']);

  // project из body + state через скоуп-ссылку C1
  const repealed = await patch(base, '/api/canon/C1', { state: 'repealed', reason: 'устарело', project: 'RAT' });
  assert.equal(repealed.res.status, 200);
  assert.equal(repealed.json.status, 'repealed');
  assert.equal(repealed.json.repeal_reason, 'устарело');

  const active = await patch(base, '/api/canon/C1?project=RAT', { state: 'active' });
  assert.equal(active.json.status, 'active');
  assert.equal(active.json.repealed_at, null);
});

test('PATCH /api/canon: project обязателен, состояние валидно, нет изменений → ошибки', async (t) => {
  const { base, wrapper } = await setup(t);
  createCanon(wrapper, { project: 'RAT', title: 'Правило' });

  const noProject = await patch(base, '/api/canon/RAT-C1', { title: 'X' });
  assert.equal(noProject.res.status, 400);
  assert.equal(noProject.json.error.code, 'invalid_project');

  const badState = await patch(base, '/api/canon/RAT-C1?project=RAT', { state: 'nope' });
  assert.equal(badState.res.status, 400);
  assert.equal(badState.json.error.code, 'invalid_state');

  const noChanges = await patch(base, '/api/canon/RAT-C1?project=RAT', {});
  assert.equal(noChanges.res.status, 400);
  assert.equal(noChanges.json.error.code, 'invalid_arguments');

  const notFound = await patch(base, '/api/canon/RAT-C9?project=RAT', { title: 'X' });
  assert.equal(notFound.res.status, 404);
  assert.equal(notFound.json.error.code, 'canon_not_found');
});

test('POST /api/canon: —supersedes авто-repeal; конфликты 409/404', async (t) => {
  const { base, wrapper } = await setup(t);
  const first = createCanon(wrapper, { project: 'RAT', title: 'Старое', actor: 'tester' });

  const created = await post(base, '/api/canon', {
    project: 'RAT',
    title: 'Новое',
    supersedes: first.id,
    actor: 'tester',
  });
  assert.equal(created.res.status, 201);
  assert.equal(created.json.supersedes, first.id);

  const old = await get(base, '/api/canon?project=RAT&state=all');
  const oldRule = old.json.canon.find((rule) => rule.id === first.id);
  assert.equal(oldRule.status, 'repealed');
  assert.equal(oldRule.meta.superseded_by, created.json.id);

  const conflict = await post(base, '/api/canon', {
    project: 'RAT',
    title: 'Ещё',
    supersedes: first.id,
  });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.json.error.code, 'canon_not_active');

  const missing = await post(base, '/api/canon', {
    project: 'RAT',
    title: 'Ещё',
    supersedes: 'RAT-C9',
  });
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error.code, 'canon_not_found');
});

test('405 и 404 для /api/canon', async (t) => {
  const { base, wrapper } = await setup(t);
  createCanon(wrapper, { project: 'RAT', title: 'Правило' });

  const deleteRule = await request(base, 'DELETE', '/api/canon/RAT-C1?project=RAT');
  assert.equal(deleteRule.res.status, 405);
  assert.equal(deleteRule.json.error.code, 'method_not_allowed');

  const patchCollection = await patch(base, '/api/canon?project=RAT', { title: 'X' });
  assert.equal(patchCollection.res.status, 405);

  const unknown = await get(base, '/api/canon/RAT-C1');
  assert.equal(unknown.res.status, 404);
  assert.equal(unknown.json.error.code, 'not_found');
});