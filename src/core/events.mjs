import { unwrapDb, UsageError } from './db.mjs';
import { formatIssueId, normalizeProjectKey, resolveIssue } from './query.mjs';

/** Допустимые типы событий (PLAN §3). */
export const EVENT_KINDS = Object.freeze(['created', 'status', 'comment', 'edit', 'link', 'claim']);

/** Автор по умолчанию, если не заданы --actor и RAT_ACTOR. */
export const DEFAULT_ACTOR = 'cli';

/**
 * Автор события: явный --actor → $RAT_ACTOR → 'cli'.
 * @param {string|undefined|null} explicit
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveActor(explicit, env = process.env) {
  for (const value of [explicit, env?.RAT_ACTOR]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return DEFAULT_ACTOR;
}

/**
 * Добавляет событие в append-only ленту. Низкоуровневый писатель: вызывать
 * только из store.mjs (единственный доменный писатель). Сам по себе не меняет
 * issues.updated_at — это делает store в той же транзакции.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{issueId: string|number, kind: string, data?: object, actor?: string, ts?: number}} input
 * @returns {{id:number, issue_id:number, project_key:string, public_id:string, ts:number, actor:string, kind:string, data:object}}
 * @throws {UsageError} при неизвестном kind или неверном data/ts
 * @throws {NotFoundError} если задача не найдена
 */
export function appendEvent(wrapper, { issueId, kind, data = {}, actor, ts } = {}) {
  const db = unwrapDb(wrapper);
  if (!EVENT_KINDS.includes(kind)) {
    throw new UsageError(
      `Неизвестный тип события «${kind}». Допустимо: ${EVENT_KINDS.join(', ')}.`,
      { code: 'invalid_event_kind' },
    );
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new UsageError('Поле data события должно быть JSON-объектом.', {
      code: 'invalid_event_data',
    });
  }
  const time = ts === undefined || ts === null ? Date.now() : ts;
  if (!Number.isInteger(time) || time < 0) {
    throw new UsageError('Время события (ts) должно быть целым числом epoch ms.', {
      code: 'invalid_event_ts',
    });
  }
  const resolvedActor = resolveActor(actor);
  const issue = resolveIssue(wrapper, issueId);

  const info = db
    .prepare('INSERT INTO events(issue_id, ts, actor, kind, data) VALUES (?, ?, ?, ?, ?)')
    .run(issue.id, time, resolvedActor, kind, JSON.stringify(data));

  return {
    id: Number(info.lastInsertRowid),
    issue_id: Number(issue.id),
    project_key: issue.project_key,
    public_id: formatIssueId(issue),
    ts: time,
    actor: resolvedActor,
    kind,
    data,
  };
}

/**
 * Читает события (chronological, по возрастанию ts/id) с JOIN issues для project.
 * Возвращаются последние `limit` подходящих событий.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{issueId?: string|number|null, projectKey?: string|null, since?: number|string|null, kind?: string|null, limit?: number}} [options]
 * @returns {Array<{id:number, issue_id:number, public_id:string, project_key:string, ts:number, actor:string, kind:string, data:object|null}>}
 * @throws {UsageError} при неизвестном kind или неверном since/limit
 */
export function listEvents(wrapper, {
  issueId = null,
  projectKey = null,
  since = null,
  kind = null,
  limit = 100,
} = {}) {
  const db = unwrapDb(wrapper);
  if (kind !== null && kind !== undefined && !EVENT_KINDS.includes(kind)) {
    throw new UsageError(
      `Неизвестный тип события «${kind}». Допустимо: ${EVENT_KINDS.join(', ')}.`,
      { code: 'invalid_event_kind' },
    );
  }

  const where = [];
  const params = [];

  if (issueId !== null && issueId !== undefined) {
    const issue = resolveIssue(wrapper, issueId);
    where.push('e.issue_id = ?');
    params.push(issue.id);
  }
  if (projectKey !== null && projectKey !== undefined && String(projectKey).trim() !== '') {
    where.push('i.project_key = ?');
    params.push(normalizeProjectKey(String(projectKey)));
  }
  const sinceTs = parseSince(since);
  if (sinceTs !== null) {
    where.push('e.ts >= ?');
    params.push(sinceTs);
  }
  if (kind) {
    where.push('e.kind = ?');
    params.push(kind);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT e.id, e.issue_id, e.ts, e.actor, e.kind, e.data, i.project_key, i.num
         FROM events e
         JOIN issues i ON i.id = e.issue_id
         ${whereSql}
         ORDER BY e.ts DESC, e.id DESC
         LIMIT ?
       ) ORDER BY ts ASC, id ASC`,
    )
    .all(...params, normalizeLimit(limit));

  return rows.map((row) => ({
    id: Number(row.id),
    issue_id: Number(row.issue_id),
    public_id: formatIssueId(row),
    project_key: row.project_key,
    ts: Number(row.ts),
    actor: row.actor,
    kind: row.kind,
    data: parseJsonOrNull(row.data),
  }));
}

/**
 * Приводит --since к epoch ms. Принимает epoch ms, «1d»/«2h»/«30m»/«1w»,
 * ISO-дату или числовую строку.
 * @param {number|string|null|undefined} since
 * @returns {number|null}
 * @throws {UsageError}
 */
export function parseSince(since) {
  if (since === null || since === undefined || since === '') return null;
  if (typeof since === 'number') {
    if (!Number.isInteger(since) || since < 0) {
      throw new UsageError('since: ожидается epoch ms.', { code: 'invalid_since' });
    }
    return since;
  }
  if (typeof since !== 'string') {
    throw new UsageError('since: ожидается число, «1d» или ISO-дата.', { code: 'invalid_since' });
  }
  const value = since.trim();
  const relative = /^(\d+)\s*(m|h|d|w)$/i.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
    return Date.now() - amount * unitMs;
  }
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new UsageError(`since: не удалось разобрать «${since}».`, { code: 'invalid_since' });
  }
  return parsed;
}

/**
 * Читает события с id больше заданного (для SSE /api/stream).
 * Порядок — по возрастанию id (хронологический в рамках append-only ленты).
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{afterId?: number|string, limit?: number}} [options]
 * @returns {Array<{id:number, issue_id:number, public_id:string, project_key:string, ts:number, actor:string, kind:string, data:object}>}
 */
export function listEventsSinceId(wrapper, { afterId = 0, limit = 1000 } = {}) {
  const db = unwrapDb(wrapper);
  const after = Number(afterId) || 0;
  const rows = db
    .prepare(
      `SELECT e.id, e.issue_id, e.ts, e.actor, e.kind, e.data, i.project_key, i.num
       FROM events e
       JOIN issues i ON i.id = e.issue_id
       WHERE e.id > ?
       ORDER BY e.id ASC
       LIMIT ?`,
    )
    .all(after, normalizeLimit(limit));

  return rows.map((row) => ({
    id: Number(row.id),
    issue_id: Number(row.issue_id),
    public_id: formatIssueId(row),
    project_key: row.project_key,
    ts: Number(row.ts),
    actor: row.actor,
    kind: row.kind,
    data: parseJsonOrNull(row.data) ?? {},
  }));
}

function normalizeLimit(limit) {
  if (limit === null || limit === undefined) return 100;
  const value = Number(limit);
  if (!Number.isInteger(value) || value <= 0 || value > 10_000) {
    throw new UsageError('limit: ожидается целое число 1..10000.', { code: 'invalid_limit' });
  }
  return value;
}

function parseJsonOrNull(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
