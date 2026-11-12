import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { REPO_ROOT } from '../src/core/db.mjs';
import { createServer } from '../src/server/http.mjs';
import { initDatabase } from '../src/core/store.mjs';
import { createSandbox } from './helpers.mjs';

async function setup(t) {
  const box = createSandbox(t, 'rat-m5-sse-');
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

  const controllers = [];
  t.after(() => {
    for (const controller of controllers) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    server.close();
    box.close();
  });

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return { box, wrapper, server, base, controllers };
}

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function patch(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function parseSseEvent(text) {
  const lines = text.split('\n');
  const event = { id: null, event: null, data: null };
  for (const line of lines) {
    if (line.startsWith('id: ')) event.id = line.slice(4);
    else if (line.startsWith('event: ')) event.event = line.slice(7);
    else if (line.startsWith('data: ')) event.data = line.slice(6);
  }
  if (event.data) {
    try {
      event.data = JSON.parse(event.data);
    } catch {
      // оставляем строкой
    }
  }
  if (event.id === null && event.event === null && event.data === null) return null;
  return event;
}

async function* sseStream(response) {
  const reader = response.body.getReader();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += Buffer.from(value).toString('utf8');
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        if (!part.trim()) continue;
        const ev = parseSseEvent(part);
        if (ev) yield ev;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), ms));
}

async function nextEvent(stream, timeoutMs = 3000) {
  return Promise.race([stream.next().then((r) => r.value), sleep(timeoutMs)]);
}

test('SSE: создание и обновление задачи приходят как issue.created/issue.updated', async (t) => {
  const { base, controllers } = await setup(t);
  const controller = new AbortController();
  controllers.push(controller);

  const res = await fetch(`${base}/api/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const stream = sseStream(res);

  const issue = await post(base, '/api/issues', { project: 'RAT', title: 'SSE target' });
  const created = await nextEvent(stream, 3000);
  assert.equal(created.event, 'issue.created');
  assert.equal(created.data.issue, issue.id);
  assert.equal(created.data.project, 'RAT');
  assert.equal(created.data.kind, 'created');

  await patch(base, `/api/issues/${issue.id}`, { status: 'doing' });
  const updated = await nextEvent(stream, 3000);
  assert.equal(updated.event, 'issue.updated');
  assert.equal(updated.data.issue, issue.id);
  assert.equal(updated.data.kind, 'status');

  controller.abort();
});

test('SSE: Last-Event-ID не дублирует старые события', async (t) => {
  const { base, controllers } = await setup(t);

  // первое соединение: получаем id первого события
  const firstController = new AbortController();
  controllers.push(firstController);
  const firstRes = await fetch(`${base}/api/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal: firstController.signal,
  });
  const issue = await post(base, '/api/issues', { project: 'RAT', title: 'idem SSE' });
  const firstStream = sseStream(firstRes);
  const created = await nextEvent(firstStream, 3000);
  assert.equal(created.event, 'issue.created');
  const firstId = created.id;
  firstController.abort();

  // новое соединение с Last-Event-ID равным id первого события
  const secondController = new AbortController();
  controllers.push(secondController);
  const secondRes = await fetch(`${base}/api/stream`, {
    headers: {
      Accept: 'text/event-stream',
      'Last-Event-ID': String(firstId),
    },
    signal: secondController.signal,
  });
  const secondStream = sseStream(secondRes);
  try {
    await nextEvent(secondStream, 600);
    assert.fail('старое событие не должно приходить повторно');
  } catch (err) {
    assert.equal(err.message, 'SSE timeout');
  }
  secondController.abort();
});

test('SSE: поток не блокирует обычные API-запросы', async (t) => {
  const { base, controllers } = await setup(t);
  const controller = new AbortController();
  controllers.push(controller);

  const sseRes = await fetch(`${base}/api/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(sseRes.status, 200);

  const before = Date.now();
  const stats = await fetch(`${base}/api/stats`, { headers: { Accept: 'application/json' } });
  assert.equal(stats.status, 200);
  assert.ok(Date.now() - before < 1000, 'API-запрос не должен ждать SSE');

  controller.abort();
});
