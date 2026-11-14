import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { REPO_ROOT } from '../src/core/db.mjs';
import { createServer } from '../src/server/http.mjs';
import {
  addComment,
  changeStatus,
  createIssue,
  createProject,
  initDatabase,
} from '../src/core/store.mjs';
import { createSandbox } from './helpers.mjs';

const ISSUE_KEYS = [
  'id', 'project', 'num', 'title', 'body', 'status', 'priority', 'labels',
  'assignee', 'ref', 'milestone', 'created_at', 'updated_at', 'closed_at', 'close_reason', 'meta',
];

const EVENT_KEYS = ['id', 'issue', 'project', 'ts', 'actor', 'kind', 'data'];

async function waitForServer(base, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/stats`, { headers: { Accept: 'application/json' } });
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw lastErr ?? new Error(`сервер не ответил за ${timeoutMs}мс`);
}

async function setup(t) {
  const box = createSandbox(t, 'rat-m5-api-');
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });

  const webDir = path.join(REPO_ROOT, 'web');
  const server = createServer({ wrapper, webDir, quiet: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  await waitForServer(base);

  t.after(() => {
    server.close();
    box.close();
  });

  return { box, wrapper, server, base };
}

async function get(base, path) {
  const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { res, text, json };
}

async function post(base, path, body, options = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    ...options,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { res, text, json };
}

async function patch(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { res, text, json };
}

test('POST /api/projects: создание и дубль', async (t) => {
  const { base } = await setup(t);

  const created = await post(base, '/api/projects', {
    key: 'new',
    name: 'New project',
    root_path: '/tmp/new',
    color: 'sky',
  });
  assert.equal(created.res.status, 201);
  assert.equal(created.res.headers.get('cache-control'), 'no-store');
  assert.equal(created.json.key, 'NEW');
  assert.equal(created.json.name, 'New project');
  assert.equal(created.json.color, 'sky');

  const dup = await post(base, '/api/projects', { key: 'new', name: 'Other' });
  assert.equal(dup.res.status, 409);
  assert.equal(dup.json.error.code, 'project_exists');
});

test('POST /api/issues: создание, actor=web по умолчанию, idem', async (t) => {
  const { base, wrapper } = await setup(t);

  const created = await post(base, '/api/issues', {
    project: 'RAT',
    title: 'Web issue',
    body: 'описание',
    priority: 1,
    labels: ['ui', 'bug'],
    ref: 'docs/readme',
  });
  assert.equal(created.res.status, 201);
  assert.equal(created.res.headers.get('cache-control'), 'no-store');
  assert.equal(created.json.project, 'RAT');
  assert.equal(created.json.title, 'Web issue');
  assert.equal(created.json.status, 'open');
  assert.equal(created.json.priority, 1);
  assert.deepEqual(created.json.labels, ['bug', 'ui']);
  assert.equal(created.json.ref, 'docs/readme');
  assert.equal(created.json.deduplicated, false);
  assert.deepEqual(Object.keys(created.json).slice(0, ISSUE_KEYS.length), ISSUE_KEYS);

  const events = await get(base, `/api/issues/${created.json.id}/events`);
  assert.equal(events.json.events[0].actor, 'web');
  assert.equal(events.json.events[0].kind, 'created');

  const idem = '11111111-1111-1111-1111-111111111111';
  const first = await post(base, '/api/issues', {
    project: 'RAT',
    title: 'idem test',
    idem,
  });
  assert.equal(first.res.status, 201);
  assert.equal(first.json.title, 'idem test');

  const second = await post(base, '/api/issues', {
    project: 'RAT',
    title: 'idem ignored',
    idem,
  });
  assert.equal(second.res.status, 200);
  assert.equal(second.json.deduplicated, true);
  assert.equal(second.json.title, 'idem test');
  assert.equal(second.json.id, first.json.id);
});

test('POST /api/issues: невалидность и неизвестный проект', async (t) => {
  const { base } = await setup(t);

  const noTitle = await post(base, '/api/issues', { project: 'RAT', body: 'x' });
  assert.equal(noTitle.res.status, 400);
  assert.equal(noTitle.json.error.code, 'required_field');

  const badProject = await post(base, '/api/issues', { project: 'ZZZ', title: 'x' });
  assert.equal(badProject.res.status, 404);
  assert.equal(badProject.json.error.code, 'project_not_found');

  const invalid = await post(base, '/api/issues', { project: 'RAT', title: 'x', priority: 7 });
  assert.equal(invalid.res.status, 400);
  assert.equal(invalid.json.error.code, 'invalid_priority');

  const notJson = await fetch(`${base}/api/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(notJson.status, 400);
  const notJsonBody = await notJson.json();
  assert.equal(notJsonBody.error.code, 'invalid_content_type');

  const badJson = await post(base, '/api/issues', '{', { body: '{', headers: { 'Content-Type': 'application/json' } });
  assert.equal(badJson.res.status, 400);
  assert.equal(badJson.json.error.code, 'invalid_json');
});

test('PATCH /api/issues/:id: частичный апдейт и статус', async (t) => {
  const { base, wrapper } = await setup(t);
  const issue = createIssue(wrapper, { project: 'RAT', title: 'patch me', priority: 2 });

  const titlePatch = await patch(base, `/api/issues/${issue.id}`, { title: 'new title' });
  assert.equal(titlePatch.res.status, 200);
  assert.equal(titlePatch.json.issue.title, 'new title');
  assert.equal(titlePatch.json.events.length, 1);
  assert.equal(titlePatch.json.events[0].kind, 'edit');
  assert.equal(titlePatch.json.events[0].data.field, 'title');
  assert.equal(titlePatch.res.headers.get('cache-control'), 'no-store');

  const statusPatch = await patch(base, `/api/issues/${issue.id}`, { status: 'doing' });
  assert.equal(statusPatch.res.status, 200);
  assert.equal(statusPatch.json.issue.status, 'doing');
  assert.equal(statusPatch.json.issue.assignee, 'web');
  const statusEvent = statusPatch.json.events.find((e) => e.kind === 'status');
  assert.ok(statusEvent);
  assert.equal(statusEvent.data.from, 'open');
  assert.equal(statusEvent.data.to, 'doing');

  const combined = await patch(base, `/api/issues/${issue.id}`, {
    status: 'blocked',
    assignee: 'human',
    labels: ['backend'],
  });
  assert.equal(combined.res.status, 200);
  assert.equal(combined.json.issue.status, 'blocked');
  assert.equal(combined.json.issue.assignee, 'human');
  assert.deepEqual(combined.json.issue.labels, ['backend']);
  const kinds = combined.json.events.map((e) => e.kind);
  assert.ok(kinds.includes('status'));
  assert.ok(kinds.includes('edit'));
  const assignEvent = combined.json.events.find((e) => e.kind === 'edit' && e.data.field === 'assignee');
  assert.ok(assignEvent);
});

test('PATCH /api/issues/:id: конфликт из done/cancelled и 404', async (t) => {
  const { base, wrapper } = await setup(t);
  const issue = createIssue(wrapper, { project: 'RAT', title: 'closed' });
  changeStatus(wrapper, { ref: issue.id, status: 'done', reason: 'готово' });

  const conflict = await patch(base, `/api/issues/${issue.id}`, { status: 'doing' });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.json.error.code, 'issue_closed');

  const reopen = await patch(base, `/api/issues/${issue.id}`, { status: 'open' });
  assert.equal(reopen.res.status, 200);
  assert.equal(reopen.json.issue.status, 'open');
  assert.equal(reopen.json.issue.closed_at, null);

  const missing = await patch(base, '/api/issues/ZZZ-999', { status: 'open' });
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error.code, 'issue_not_found');
});

test('POST /api/issues/:id/comments: создание, пустой текст, idem', async (t) => {
  const { base, wrapper } = await setup(t);
  const issue = createIssue(wrapper, { project: 'RAT', title: 'comment target' });

  const empty = await post(base, `/api/issues/${issue.id}/comments`, { text: '   ' });
  assert.equal(empty.res.status, 400);
  assert.equal(empty.json.error.code, 'empty_comment');

  const created = await post(base, `/api/issues/${issue.id}/comments`, { text: 'первый' });
  assert.equal(created.res.status, 201);
  assert.equal(created.res.headers.get('cache-control'), 'no-store');
  assert.equal(created.json.kind, 'comment');
  assert.equal(created.json.actor, 'web');
  assert.deepEqual(Object.keys(created.json), EVENT_KEYS);

  const idem = '22222222-2222-2222-2222-222222222222';
  const first = await post(base, `/api/issues/${issue.id}/comments`, { text: 'idem comment', idem });
  assert.equal(first.res.status, 201);
  assert.deepEqual(Object.keys(first.json), EVENT_KEYS);
  const second = await post(base, `/api/issues/${issue.id}/comments`, { text: 'ignored', idem });
  assert.equal(second.res.status, 200);
  assert.equal(second.json.data.text, 'idem comment');
});

test('PATCH /api/issues/:id обновляет счётчики в /api/stats и /api/projects', async (t) => {
  const { base, wrapper } = await setup(t);
  const issue = createIssue(wrapper, { project: 'RAT', title: 'counter test' });

  const beforeStats = await get(base, '/api/stats');
  assert.equal(beforeStats.json.totals.byStatus.open, 1);
  assert.equal(beforeStats.json.totals.byStatus.doing, 0);
  const beforeProjects = await get(base, '/api/projects');
  const ratBefore = beforeProjects.json.projects.find((p) => p.key === 'RAT');
  assert.equal(ratBefore.counts.open, 1);
  assert.equal(ratBefore.counts.doing, 0);

  const patchRes = await patch(base, `/api/issues/${issue.id}`, { status: 'doing' });
  assert.equal(patchRes.res.status, 200);

  const afterStats = await get(base, '/api/stats');
  assert.equal(afterStats.json.totals.byStatus.open, 0);
  assert.equal(afterStats.json.totals.byStatus.doing, 1);
  const afterProjects = await get(base, '/api/projects');
  const ratAfter = afterProjects.json.projects.find((p) => p.key === 'RAT');
  assert.equal(ratAfter.counts.open, 0);
  assert.equal(ratAfter.counts.doing, 1);
});

test('SSE: множественные обрывы соединения не роняют сервер', async (t) => {
  const { base } = await setup(t);

  for (let i = 0; i < 5; i += 1) {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    controller.abort();
  }

  const stats = await get(base, '/api/stats');
  assert.equal(stats.res.status, 200);
});
