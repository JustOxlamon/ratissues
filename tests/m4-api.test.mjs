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
import { buildExport, exportJsonl } from '../src/core/export.mjs';
import { getStats, listLog, searchIssues } from '../src/core/query.mjs';
import { createSandbox, runCli } from './helpers.mjs';

const ISSUE_KEYS = [
  'id',
  'project',
  'num',
  'title',
  'body',
  'status',
  'priority',
  'labels',
  'assignee',
  'ref',
  'created_at',
  'updated_at',
  'closed_at',
  'close_reason',
  'meta',
];

const EVENT_KEYS = ['id', 'issue', 'project', 'ts', 'actor', 'kind', 'data'];

async function setup(t) {
  const box = createSandbox(t, 'rat-m4-api-');
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });
  createProject(wrapper, { key: 'OLD', name: 'Old' });

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
  const base = `http://127.0.0.1:${address.port}`;
  return { box, wrapper, server, base };
}

async function get(base, path, { accept } = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: accept ? { Accept: accept } : {},
  });
  const text = await res.text();
  let json = null;
  if (res.headers.get('content-type')?.includes('application/json')) {
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
    }
  }
  return { res, text, json };
}

function seed(wrapper) {
  const a = createIssue(wrapper, { project: 'AXEL', title: 'AXEL alpha', priority: 0, labels: 'backend' });
  const b = createIssue(wrapper, { title: 'RAT first', priority: 1, labels: 'ui,bug', body: 'body text' });
  const c = createIssue(wrapper, { title: 'RAT second', priority: 2 });
  addComment(wrapper, { ref: b.id, text: 'комментарий' });
  changeStatus(wrapper, { ref: b.id, status: 'doing', actor: 'me' });
  changeStatus(wrapper, { ref: c.id, status: 'done', reason: 'не нужно' });
  return { a, b, c };
}

test('GET /api/projects и фильтры all/archived', async (t) => {
  const { base, wrapper } = await setup(t);
  seed(wrapper);

  const normal = await get(base, '/api/projects');
  assert.equal(normal.res.status, 200);
  assert.equal(normal.res.headers.get('cache-control'), 'no-store');
  assert.ok(Array.isArray(normal.json.projects));
  assert.equal(normal.json.projects.length, 3);
  assert.deepEqual(Object.keys(normal.json.projects[0]).sort(), [
    'archived_at', 'color', 'counts', 'created_at', 'key', 'name', 'root_path',
  ]);
  assert.ok(normal.json.projects.some((p) => p.key === 'RAT'));

  const archived = await get(base, '/api/projects?archived=1');
  assert.equal(archived.json.projects.length, 0);

  const all = await get(base, '/api/projects?all=1');
  assert.equal(all.json.projects.length, 3);
});

test('GET /api/issues с фильтрами, cursor и сравнение с CLI-схемой', async (t) => {
  const { base, wrapper } = await setup(t);
  const { a, b } = seed(wrapper);

  const active = await get(base, '/api/issues?project=AXEL&status=active');
  assert.equal(active.res.status, 200);
  assert.equal(active.json.issues.length, 1);
  assert.equal(active.json.issues[0].id, a.id);
  assert.deepEqual(Object.keys(active.json.issues[0]), ISSUE_KEYS);

  const all = await get(base, '/api/issues?project=RAT&status=all&sort=updated');
  assert.equal(all.json.issues.length, 2);
  assert.deepEqual(all.json.issues.map((i) => i.id), ['RAT-2', b.id]);

  const q = await get(base, '/api/issues?project=RAT&q=first');
  assert.equal(q.json.issues.length, 1);
  assert.equal(q.json.issues[0].id, b.id);

  const label = await get(base, '/api/issues?project=RAT&label=bug');
  assert.equal(label.json.issues.length, 1);

  const first = await get(base, '/api/issues?status=all&limit=1');
  assert.equal(first.json.issues.length, 1);
  assert.equal(typeof first.json.next_cursor, 'string');
  const second = await get(base, `/api/issues?status=all&limit=1&cursor=${encodeURIComponent(first.json.next_cursor)}`);
  assert.equal(second.json.issues.length, 1);
  assert.notEqual(first.json.issues[0].id, second.json.issues[0].id);

  const same = searchIssues(wrapper, { project: 'RAT', status: 'all', sort: 'updated' });
  assert.deepEqual(all.json.issues.map((i) => i.id), same.issues.map((i) => i.id));
});

test('GET /api/issues/:id и /api/issues/:id/events', async (t) => {
  const { base, wrapper } = await setup(t);
  const { b } = seed(wrapper);

  const byPublic = await get(base, `/api/issues/${b.id}`);
  assert.equal(byPublic.res.status, 200);
  assert.deepEqual(Object.keys(byPublic.json), ISSUE_KEYS);
  assert.equal(byPublic.json.id, b.id);

  const byNum = await get(base, '/api/issues/1?project=AXEL');
  // query string не влияет на :id роут, но числовой id должен разрешиться
  assert.equal(byNum.json.id, 'AXEL-1');

  const events = await get(base, `/api/issues/${b.id}/events?limit=10`);
  assert.equal(events.res.status, 200);
  assert.ok(Array.isArray(events.json.events));
  assert.equal(events.json.events.length, 3);
  assert.deepEqual(Object.keys(events.json.events[0]), EVENT_KEYS);
  assert.equal(events.json.events[0].issue, b.id);
  assert.equal(events.json.events[0].project, 'RAT');
  assert.equal(typeof events.json.events[0].data, 'object');
  assert.equal(events.json.events.find((e) => e.kind === 'status').data.from, 'open');

  const missing = await get(base, '/api/issues/ZZZ-999');
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error.code, 'issue_not_found');
});

test('GET /api/log и /api/stats', async (t) => {
  const { base, wrapper } = await setup(t);
  seed(wrapper);

  const log = await get(base, '/api/log?limit=10');
  assert.equal(log.res.status, 200);
  assert.ok(Array.isArray(log.json.events));
  assert.ok(log.json.events.length > 0);
  assert.deepEqual(Object.keys(log.json.events[0]), EVENT_KEYS);

  const sameLog = listLog(wrapper, { limit: 10 });
  assert.deepEqual(log.json.events.map((e) => e.id), sameLog.map((e) => e.id));

  const stats = await get(base, '/api/stats');
  assert.equal(stats.res.status, 200);
  assert.deepEqual(Object.keys(stats.json).sort(), ['projects', 'totals', 'week']);
  assert.equal(stats.json.totals.total, 3);

  const sameStats = getStats(wrapper);
  assert.deepEqual(stats.json.projects, sameStats.projects);
});

test('GET /api/export md/jsonl и поле data — объект', async (t) => {
  const { base, wrapper } = await setup(t);
  seed(wrapper);

  const md = await get(base, '/api/export?format=md&project=RAT');
  assert.equal(md.res.status, 200);
  assert.equal(md.res.headers.get('cache-control'), 'no-store');
  assert.equal(md.res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.ok(md.text.startsWith('# RAT'));
  assert.equal(md.text, buildExport(wrapper, { format: 'md', project: 'RAT' }).content);

  const jsonl = await get(base, '/api/export?format=jsonl&project=RAT&events=1');
  assert.equal(jsonl.res.status, 200);
  assert.equal(jsonl.res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  const lines = jsonl.text.split('\n').filter((l) => l !== '');
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const event = JSON.parse(line);
    assert.deepEqual(Object.keys(event), EVENT_KEYS);
    assert.equal(typeof event.data, 'object', 'data в jsonl-экспорте должно быть объектом');
  }

  const statusEvent = JSON.parse(lines.find((l) => JSON.parse(l).kind === 'status'));
  assert.equal(statusEvent.data.from, 'open');
  assert.equal(jsonl.text, exportJsonl(wrapper, { project: 'RAT', events: true }));
});

test('API: 404 JSON для неизвестного /api/*, 405 для POST, path traversal', async (t) => {
  const { base } = await setup(t);

  const unknown = await get(base, '/api/unknown');
  assert.equal(unknown.res.status, 404);
  assert.equal(unknown.json.error.code, 'not_found');
  assert.equal(unknown.res.headers.get('cache-control'), 'no-store');

  const post = await fetch(`${base}/api/issues/1`, { method: 'POST', body: '{}' });
  assert.equal(post.status, 405);
  const postJson = await post.json();
  assert.equal(postJson.error.code, 'method_not_allowed');

  const traversal = await get(base, '/../package.json');
  assert.equal(traversal.res.status, 404);
});

test('Статика: /, /app.js, /app.css с правильными Content-Type', async (t) => {
  const { base } = await setup(t);

  const index = await get(base, '/');
  assert.equal(index.res.status, 200);
  assert.equal(index.res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.ok(index.text.includes('<title>RatIssues</title>'));

  const css = await get(base, '/app.css');
  assert.equal(css.res.status, 200);
  assert.equal(css.res.headers.get('content-type'), 'text/css; charset=utf-8');

  const js = await get(base, '/app.js');
  assert.equal(js.res.status, 200);
  assert.equal(js.res.headers.get('content-type'), 'application/javascript; charset=utf-8');
});

test('CLI: serve --host 0.0.0.0 → exit 2', async (t) => {
  const box = createSandbox(t, 'rat-m4-cli-');
  t.after(() => box.close());

  const result = runCli(['serve', '--host', '0.0.0.0', '--port', '0'], { dbPath: box.dbPath });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /0\.0\.0\.0/);
});
