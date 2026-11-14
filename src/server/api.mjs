import { URL } from 'node:url';

import {
  ConflictError,
  DbError,
  NotFoundError,
  RatError,
  UsageError,
} from '../core/db.mjs';
import { buildExport } from '../core/export.mjs';
import { listEvents, listEventsSinceId } from '../core/events.mjs';
import {
  getStats,
  listCanon,
  listLog,
  listMilestones,
  searchIssues,
  serializeEvent,
} from '../core/query.mjs';
import {
  addComment,
  createCanon,
  createIssue,
  createMilestone,
  createProject,
  getIssue,
  listProjectsWithCounts,
  reactivateCanon,
  repealCanon,
  updateCanon,
  updateIssue,
  updateMilestone,
} from '../core/store.mjs';

/**
 * api.mjs — тонкий слой эндпоинтов над core. Все ответы JSON, кроме
 * /api/export (md/jsonl как есть) и /api/stream (SSE).
 * Ошибки: {"error":{"code":"...","message":"...","hint":?"..."}}.
 */

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const BODY_LIMIT_BYTES = 1 * 1024 * 1024;

/**
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @returns {{handler: (req, res, url) => Promise<void>, close: () => void}}
 */
export function createApiHandler(wrapper) {
  const activeCleanups = new Set();

  async function handleApi(req, res, url) {
    const host = req.headers.host?.split(':')[0] ?? '';
    if (!ALLOWED_HOSTS.has(host) && !ALLOWED_HOSTS.has(url.hostname)) {
      sendError(res, new UsageError('API доступно только с loopback.', { code: 'forbidden' }), 403);
      return;
    }

    try {
      if (url.pathname === '/api/stream' && req.method === 'GET') {
        handleStream(wrapper, req, res, activeCleanups);
        return;
      }

      if (req.method === 'GET') {
        await routeGet(wrapper, req, res, url);
        return;
      }

      if (req.method === 'POST' || req.method === 'PATCH') {
        await routeWrite(wrapper, req, res, url);
        return;
      }

      sendError(
        res,
        new UsageError(`Метод ${req.method} не поддерживается.`, { code: 'method_not_allowed' }),
        405,
      );
    } catch (err) {
      if (err instanceof RatError) {
        const status =
          err instanceof UsageError ? 400 :
            err instanceof NotFoundError ? 404 :
              err instanceof ConflictError ? 409 :
                err instanceof DbError ? 500 : 500;
        sendError(res, err, status);
        return;
      }
      sendError(res, new DbError(err?.message ?? String(err), { code: 'internal_error' }), 500);
    }
  }

  function close() {
    for (const cleanup of activeCleanups) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
    activeCleanups.clear();
  }

  return { handler: handleApi, close };
}

// ---------------------------------------------------------------------------
// GET-эндпоинты
// ---------------------------------------------------------------------------

async function routeGet(wrapper, req, res, url) {
  const pathname = url.pathname;

  if (pathname === '/api/projects') {
    const includeArchived = parseBoolean(url.searchParams.get('all'));
    const onlyArchived = parseBoolean(url.searchParams.get('archived'));
    let projects = listProjectsWithCounts(wrapper, { includeArchived: includeArchived || onlyArchived });
    if (onlyArchived) projects = projects.filter((project) => project.archived_at !== null);
    sendJson(res, { projects });
    return;
  }

  if (pathname === '/api/issues') {
    const result = searchIssues(wrapper, {
      project: url.searchParams.get('project') ?? null,
      status: url.searchParams.get('status') ?? 'active',
      label: url.searchParams.get('label') ?? null,
      q: url.searchParams.get('q') ?? null,
      priority: url.searchParams.get('priority') ?? null,
      milestone: url.searchParams.get('milestone') ?? null,
      limit: url.searchParams.get('limit') ?? 50,
      sort: url.searchParams.get('sort') ?? 'pri',
      cursor: url.searchParams.get('cursor') ?? null,
    });
    sendJson(res, { issues: result.issues, next_cursor: result.nextCursor });
    return;
  }

  if (pathname === '/api/milestones') {
    const milestones = listMilestones(wrapper, {
      project: url.searchParams.get('project') ?? null,
      state: url.searchParams.get('state') ?? 'open',
      includeArchived: parseBoolean(url.searchParams.get('all')),
    });
    sendJson(res, { milestones });
    return;
  }

  if (pathname === '/api/canon') {
    const canon = listCanon(wrapper, {
      project: url.searchParams.get('project') ?? null,
      state: url.searchParams.get('state') ?? 'active',
      label: url.searchParams.get('label') ?? null,
      q: url.searchParams.get('q') ?? null,
      includeArchived: parseBoolean(url.searchParams.get('all')),
    });
    sendJson(res, { canon });
    return;
  }

  if (pathname === '/api/stats') {
    sendJson(res, getStats(wrapper));
    return;
  }

  if (pathname === '/api/log') {
    const events = listLog(wrapper, {
      project: url.searchParams.get('project') ?? null,
      since: url.searchParams.get('since') ?? null,
      kind: url.searchParams.get('kind') ?? null,
      limit: url.searchParams.get('limit') ?? 50,
    });
    sendJson(res, { events });
    return;
  }

  if (pathname === '/api/export') {
    const format = url.searchParams.get('format') ?? 'md';
    const withEvents = parseBoolean(url.searchParams.get('events'));
    const project = url.searchParams.get('project') ?? null;
    const all = parseBoolean(url.searchParams.get('all'));
    const report = buildExport(wrapper, {
      format,
      project,
      all,
      events: withEvents,
      limit: url.searchParams.get('limit') ?? null,
    });
    const contentType = format === 'jsonl'
      ? 'application/x-ndjson; charset=utf-8'
      : 'text/markdown; charset=utf-8';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    res.end(report.content);
    return;
  }

  const issueMatch = /^\/api\/issues\/([^/]+)$/.exec(pathname);
  if (issueMatch) {
    const issue = getIssue(wrapper, issueMatch[1]);
    sendJson(res, issue);
    return;
  }

  const eventsMatch = /^\/api\/issues\/([^/]+)\/events$/.exec(pathname);
  if (eventsMatch) {
    const limitRaw = url.searchParams.get('limit') ?? '20';
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) {
      throw new UsageError('limit: ожидается целое число 0..10000.', { code: 'invalid_limit' });
    }
    const rows = listEvents(wrapper, { issueId: eventsMatch[1], limit });
    sendJson(res, { events: rows.map(serializeEvent) });
    return;
  }

  throw new NotFoundError(`Эндпоинт ${pathname} не найден.`, { code: 'not_found' });
}

// ---------------------------------------------------------------------------
// Write-эндпоинты
// ---------------------------------------------------------------------------

async function routeWrite(wrapper, req, res, url) {
  const pathname = url.pathname;
  const method = req.method;
  const issueMatch = /^\/api\/issues\/([^/]+)$/.exec(pathname);
  const commentMatch = /^\/api\/issues\/([^/]+)\/comments$/.exec(pathname);
  const milestoneMatch = /^\/api\/milestones\/([^/]+)$/.exec(pathname);
  const canonMatch = /^\/api\/canon\/([^/]+)$/.exec(pathname);

  // POST /api/projects
  if (pathname === '/api/projects' && method === 'POST') {
    const body = await readJsonBody(req);
    const project = createProject(wrapper, {
      key: body.key,
      name: body.name,
      rootPath: body.root_path,
      color: body.color,
    });
    sendJson(res, project, 201);
    return;
  }

  // POST /api/milestones
  if (pathname === '/api/milestones' && method === 'POST') {
    const body = await readJsonBody(req);
    const milestone = createMilestone(wrapper, {
      project: body.project ?? null,
      name: body.name,
      body: body.body ?? '',
      dueAt: body.due_at ?? null,
    });
    sendJson(res, milestone, 201);
    return;
  }

  // POST /api/canon
  if (pathname === '/api/canon' && method === 'POST') {
    const body = await readJsonBody(req);
    const rule = createCanon(wrapper, {
      project: body.project ?? null,
      title: body.title,
      body: body.body ?? '',
      priority: body.priority ?? null,
      labels: body.labels ?? null,
      source: body.source ?? null,
      supersedes: body.supersedes ?? null,
      actor: body.actor ?? 'web',
    });
    sendJson(res, rule, 201);
    return;
  }

  // PATCH /api/canon/:ref?project  (state = repealed|active и/или правки полей)
  if (canonMatch && method === 'PATCH') {
    const body = await readJsonBody(req);
    const project = url.searchParams.get('project') ?? body.project;
    if (project === null || project === undefined || String(project).trim() === '') {
      throw new UsageError('PATCH /api/canon: нужен project (query или body).', {
        code: 'invalid_project',
      });
    }
    let ref;
    try {
      ref = decodeURIComponent(canonMatch[1]);
    } catch {
      throw new UsageError('Некорректное имя канон-правила в пути.', {
        code: 'invalid_canon_ref',
        hint: 'Посмотрите правила: rat canon ls',
      });
    }
    const scope = project;
    const actor = body.actor ?? 'web';
    const hasFields = ['title', 'body', 'priority', 'labels'].some(
      (field) => body[field] !== undefined,
    );
    const stateGiven = body.state !== undefined && body.state !== null && String(body.state).trim() !== '';

    let rule;
    if (stateGiven) {
      const state = String(body.state).trim().toLowerCase();
      if (state === 'repealed') {
        rule = repealCanon(wrapper, { ref, reason: body.reason ?? null, projectKey: scope, actor });
      } else if (state === 'active') {
        rule = reactivateCanon(wrapper, { ref, projectKey: scope, actor });
      } else {
        throw new UsageError(`Недопустимое состояние «${body.state}». Допустимо: active, repealed.`, {
          code: 'invalid_state',
        });
      }
      if (hasFields) {
        rule = updateCanon(wrapper, {
          ref,
          title: body.title,
          body: body.body,
          priority: body.priority,
          labels: body.labels,
          projectKey: scope,
          actor,
        });
      }
    } else {
      if (!hasFields) {
        throw new UsageError('PATCH /api/canon: нет изменений (state или поля).', {
          code: 'invalid_arguments',
        });
      }
      rule = updateCanon(wrapper, {
        ref,
        title: body.title,
        body: body.body,
        priority: body.priority,
        labels: body.labels,
        projectKey: scope,
        actor,
      });
    }
    sendJson(res, rule);
    return;
  }

  // PATCH /api/milestones/:ref
  if (milestoneMatch && method === 'PATCH') {
    const body = await readJsonBody(req);
    const project = url.searchParams.get('project') ?? body.project;
    if (project === null || project === undefined || String(project).trim() === '') {
      throw new UsageError('PATCH /api/milestones: нужен project (query или body).', {
        code: 'invalid_project',
      });
    }
    let ref;
    try {
      ref = decodeURIComponent(milestoneMatch[1]);
    } catch {
      throw new UsageError('Некорректное имя милстоуна в пути.', {
        code: 'invalid_milestone',
        hint: 'Посмотреть милстоуны: rat milestone ls',
      });
    }
    const milestone = updateMilestone(wrapper, {
      ref,
      project,
      name: body.name,
      body: body.body,
      dueAt: body.due_at,
      clearDue: Boolean(body.clear_due),
      state: body.state,
    });
    sendJson(res, milestone);
    return;
  }

  // POST /api/issues
  if (pathname === '/api/issues' && method === 'POST') {
    const body = await readJsonBody(req);
    const issue = createIssue(wrapper, {
      project: body.project ?? null,
      title: body.title,
      body: body.body ?? '',
      priority: body.priority ?? null,
      labels: body.labels ?? null,
      assignee: body.assignee ?? null,
      ref: body.ref ?? null,
      milestone: body.milestone ?? null,
      actor: body.actor ?? 'web',
      idem: body.idem ?? null,
    });
    sendJson(res, issue, issue.deduplicated ? 200 : 201);
    return;
  }

  // PATCH /api/issues/:id
  if (issueMatch && method === 'PATCH') {
    const body = await readJsonBody(req);
    const result = updateIssue(wrapper, {
      issueRef: issueMatch[1],
      status: body.status,
      title: body.title,
      body: body.body,
      priority: body.priority,
      labels: body.labels,
      assignee: body.assignee,
      ref: body.ref,
      milestone: body.milestone,
      reason: body.reason ?? null,
      actor: body.actor ?? 'web',
    });
    sendJson(res, result);
    return;
  }

  // POST /api/issues/:id/comments
  if (commentMatch && method === 'POST') {
    const body = await readJsonBody(req);
    const comment = addComment(wrapper, {
      ref: commentMatch[1],
      text: body.text,
      actor: body.actor ?? 'web',
      idem: body.idem ?? null,
    });
    const { deduplicated, ...event } = comment;
    sendJson(res, event, deduplicated ? 200 : 201);
    return;
  }

  // Существующий ресурс, но метод не поддерживается → 405.
  if (pathname === '/api/milestones' && method !== 'POST') {
    sendError(
      res,
      new UsageError(`Метод ${method} не поддерживается.`, { code: 'method_not_allowed' }),
      405,
    );
    return;
  }
  if (milestoneMatch && method !== 'PATCH') {
    sendError(
      res,
      new UsageError(`Метод ${method} не поддерживается.`, { code: 'method_not_allowed' }),
      405,
    );
    return;
  }
  if (pathname === '/api/canon' && method !== 'POST') {
    sendError(
      res,
      new UsageError(`Метод ${method} не поддерживается.`, { code: 'method_not_allowed' }),
      405,
    );
    return;
  }
  if (canonMatch && method !== 'PATCH') {
    sendError(
      res,
      new UsageError(`Метод ${method} не поддерживается.`, { code: 'method_not_allowed' }),
      405,
    );
    return;
  }
  if (pathname === '/api/issues' && method === 'PATCH') {
    sendError(
      res,
      new UsageError(`Метод ${method} не поддерживается.`, { code: 'method_not_allowed' }),
      405,
    );
    return;
  }
  if (issueMatch && method === 'POST') {
    sendError(
      res,
      new UsageError(`Метод ${method} не поддерживается.`, { code: 'method_not_allowed' }),
      405,
    );
    return;
  }
  if (commentMatch && method !== 'POST') {
    sendError(
      res,
      new UsageError(`Метод ${method} не поддерживается.`, { code: 'method_not_allowed' }),
      405,
    );
    return;
  }

  throw new NotFoundError(`Эндпоинт ${pathname} не найден.`, { code: 'not_found' });
}

// ---------------------------------------------------------------------------
// SSE /api/stream
// ---------------------------------------------------------------------------

function handleStream(wrapper, req, res, activeCleanups) {
  const headerId = req.headers['last-event-id'];
  const queryId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('lastEventId');
  let lastSentId = Number(headerId ?? queryId ?? 0);
  if (!Number.isInteger(lastSentId) || lastSentId < 0) lastSentId = 0;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  const sendSince = (afterId) => {
    const rows = listEventsSinceId(wrapper, { afterId, limit: 1000 });
    for (const row of rows) {
      const eventName = row.kind === 'created' ? 'issue.created' : 'issue.updated';
      const data = JSON.stringify({
        issue: row.public_id,
        project: row.project_key,
        ts: row.ts,
        actor: row.actor,
        kind: row.kind,
        data: row.data,
      });
      res.write(`id: ${row.id}\nevent: ${eventName}\ndata: ${data}\n\n`);
    }
    return rows.length ? rows[rows.length - 1].id : afterId;
  };

  lastSentId = sendSince(lastSentId);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 20_000);

  const poll = setInterval(() => {
    lastSentId = sendSince(lastSentId);
  }, 500);

  const cleanup = () => {
    clearInterval(heartbeat);
    clearInterval(poll);
    activeCleanups.delete(cleanup);
  };

  activeCleanups.add(cleanup);
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);
}

// ---------------------------------------------------------------------------
// Помощники
// ---------------------------------------------------------------------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      reject(new UsageError('Content-Type должен быть application/json.', {
        code: 'invalid_content_type',
      }));
      return;
    }

    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new UsageError('Тело запроса превышает 1 МБ.', { code: 'payload_too_large' }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

async function readJsonBody(req) {
  let text;
  try {
    text = await readBody(req, BODY_LIMIT_BYTES);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError('Не удалось прочитать тело запроса.', { code: 'invalid_body' });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError('Не удалось разобрать JSON.', { code: 'invalid_json' });
  }
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

function sendError(res, err, status) {
  const body = JSON.stringify(errorPayload(err));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

function errorPayload(err) {
  const known = err instanceof RatError;
  const payload = {
    error: {
      code: known ? err.code : 'internal_error',
      message: err?.message ?? String(err),
    },
  };
  if (known && err.hint) payload.error.hint = err.hint;
  return payload;
}

function parseBoolean(value) {
  if (value === null || value === undefined) return false;
  return /^(1|true|yes|on)$/i.test(String(value));
}
