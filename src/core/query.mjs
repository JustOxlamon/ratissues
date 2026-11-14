import path from 'node:path';

import {
  getSchemaVersion,
  NotFoundError,
  readMeta,
  unwrapDb,
  UsageError,
} from './db.mjs';
import { listEvents } from './events.mjs';

/** Ключ проекта: uppercase, 2–10 символов A-Z0-9 (PLAN §3). */
export const PROJECT_KEY_RE = /^[A-Z0-9]{2,10}$/;

/** Допустимые статусы задачи (PLAN §3). */
export const ISSUE_STATUSES = Object.freeze([
  'open',
  'doing',
  'blocked',
  'deferred',
  'done',
  'cancelled',
]);

/** Статусы, попадающие в `active`. `deferred` намеренно не входит (задача припаркована). */
export const ACTIVE_STATUSES = Object.freeze(['open', 'doing', 'blocked']);

/** Колонки задачи, которые нужны serializeIssue. */
export const ISSUE_SELECT = `
  SELECT i.id, i.project_key, i.num, i.title, i.body, i.status, i.priority,
         i.labels, i.assignee, i.ref, i.created_at, i.updated_at,
         i.closed_at, i.close_reason, i.meta
  FROM issues i`;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Нормализует ключ проекта: trim + uppercase, затем проверяет формат.
 * @param {string} value
 * @returns {string}
 * @throws {UsageError} если ключ пустой или не соответствует /^[A-Z0-9]{2,10}$/
 */
export function normalizeProjectKey(value) {
  if (typeof value !== 'string') {
    throw new UsageError('Ключ проекта должен быть строкой.', { code: 'invalid_project_key' });
  }
  const key = value.trim().toUpperCase();
  if (!PROJECT_KEY_RE.test(key)) {
    throw new UsageError(
      `Некорректный ключ проекта «${value}»: нужно 2–10 символов A-Z0-9 (например RAT).`,
      { code: 'invalid_project_key' },
    );
  }
  return key;
}

/**
 * Проект по ключу (без исключения, если не найден).
 * @param {{db: import('node:sqlite').DatabaseSync}|import('node:sqlite').DatabaseSync} wrapperOrDb
 * @param {string} key
 * @returns {{key:string,name:string,root_path:string|null,color:string,created_at:number,archived_at:number|null}|null}
 */
export function getProject(wrapperOrDb, key) {
  const db = unwrapDb(wrapperOrDb);
  const row = db
    .prepare(
      `SELECT key, name, root_path, color, created_at, archived_at
       FROM projects WHERE key = ?`,
    )
    .get(normalizeProjectKey(key));
  return row ?? null;
}

/**
 * Список проектов.
 * @param {{db: import('node:sqlite').DatabaseSync}|import('node:sqlite').DatabaseSync} wrapperOrDb
 * @param {{includeArchived?: boolean}} [options]
 * @returns {Array<{key:string,name:string,root_path:string|null,color:string,created_at:number,archived_at:number|null}>}
 */
export function listProjects(wrapperOrDb, { includeArchived = false } = {}) {
  const db = unwrapDb(wrapperOrDb);
  const where = includeArchived ? '' : 'WHERE archived_at IS NULL';
  return db
    .prepare(
      `SELECT key, name, root_path, color, created_at, archived_at
       FROM projects ${where} ORDER BY key`,
    )
    .all();
}

/**
 * Определяет проект по приоритету:
 * --project → $RAT_PROJECT → самый длинный root_path-префикс cwd → meta.default_project.
 * @param {{db: import('node:sqlite').DatabaseSync}|import('node:sqlite').DatabaseSync} wrapperOrDb
 * @param {{project?: string|null, cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{key:string,name:string,root_path:string|null,color:string,created_at:number,archived_at:number|null,source:'flag'|'env'|'root_path'|'default'}}
 * @throws {NotFoundError} если проект не удалось определить
 * @throws {UsageError} если задан некорректный ключ
 */
export function resolveProject(wrapperOrDb, { project = null, cwd = process.cwd(), env = process.env } = {}) {
  const db = unwrapDb(wrapperOrDb);
  if (getSchemaVersion(wrapperOrDb) === 0) {
    throw new NotFoundError('База не инициализирована.', {
      code: 'db_not_initialized',
      hint: 'Выполните: rat init',
    });
  }

  if (project !== null && project !== undefined && String(project).trim() !== '') {
    const key = normalizeProjectKey(String(project));
    return requireProject(db, key, 'flag');
  }

  const fromEnv = env?.RAT_PROJECT;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return requireProject(db, normalizeProjectKey(fromEnv), 'env');
  }

  const root = normalizeFsPath(cwd);
  const candidates = db
    .prepare(
      `SELECT key, name, root_path, color, created_at, archived_at
       FROM projects
       WHERE root_path IS NOT NULL AND root_path <> '' AND archived_at IS NULL`,
    )
    .all();

  let best = null;
  let bestLength = -1;
  for (const candidate of candidates) {
    const candidateRoot = normalizeFsPath(candidate.root_path);
    if (!isPathPrefix(candidateRoot, root)) continue;
    if (candidateRoot.length > bestLength) {
      best = candidate;
      bestLength = candidateRoot.length;
    }
  }
  if (best) return { ...best, source: 'root_path' };

  const defaultKey = readMeta(db, 'default_project');
  if (defaultKey) {
    const row = getProject(db, defaultKey);
    if (row) return { ...row, source: 'default' };
  }

  throw new NotFoundError('Не удалось определить проект.', {
    code: 'project_not_found',
    hint: 'Укажите --project KEY или создайте проект: rat project add KEY --name "..."',
  });
}

/**
 * Публичный идентификатор задачи: KEY-NUM.
 * @param {{project_key:string, num:number}} issue
 * @returns {string}
 */
export function formatIssueId(issue) {
  if (!issue || typeof issue.project_key !== 'string' || !Number.isInteger(Number(issue.num))) {
    throw new UsageError('Некорректная запись задачи: нет project_key/num.', {
      code: 'invalid_issue',
    });
  }
  return `${issue.project_key}-${Number(issue.num)}`;
}

/**
 * Разбирает ссылку на задачу: RAT-12 или число (внутренний id).
 * @param {string|number} ref
 * @returns {{kind:'id', id:number}|{kind:'public', projectKey:string, num:number}}
 * @throws {UsageError}
 */
export function parseIssueRef(ref) {
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref) || ref <= 0) {
      throw new UsageError(`Некорректный идентификатор задачи: ${ref}`, { code: 'invalid_issue_ref' });
    }
    return { kind: 'id', id: ref };
  }
  if (typeof ref !== 'string') {
    throw new UsageError('Идентификатор задачи должен быть строкой или числом.', {
      code: 'invalid_issue_ref',
    });
  }
  const value = ref.trim();
  if (/^\d+$/.test(value)) {
    const id = Number(value);
    if (id <= 0) throw new UsageError(`Некорректный идентификатор задачи: ${ref}`, { code: 'invalid_issue_ref' });
    return { kind: 'id', id };
  }
  const match = /^([A-Za-z0-9]{2,10})-(\d+)$/.exec(value);
  if (!match) {
    throw new UsageError(
      `Некорректный идентификатор задачи «${ref}»: ожидается RAT-7 или 7.`,
      { code: 'invalid_issue_ref' },
    );
  }
  const num = Number(match[2]);
  if (num <= 0) throw new UsageError(`Некорректный идентификатор задачи: ${ref}`, { code: 'invalid_issue_ref' });
  return { kind: 'public', projectKey: normalizeProjectKey(match[1]), num };
}

/**
 * Находит задачу по RAT-7 или по внутреннему id. Если задан projectKey,
 * число трактуется как num внутри этого проекта.
 * @param {{db: import('node:sqlite').DatabaseSync}|import('node:sqlite').DatabaseSync} wrapperOrDb
 * @param {string|number} ref
 * @param {{projectKey?: string|null}} [options]
 * @returns {object} строка issues (snake_case поля)
 * @throws {NotFoundError} если задача не найдена
 */
export function resolveIssue(wrapperOrDb, ref, { projectKey = null } = {}) {
  const db = unwrapDb(wrapperOrDb);
  const parsed = parseIssueRef(ref);
  const scope = projectKey === null || projectKey === undefined ? null : normalizeProjectKey(projectKey);

  let row;
  if (parsed.kind === 'public') {
    if (scope && scope !== parsed.projectKey) {
      throw new NotFoundError(`Задача ${formatRef(parsed)} не найдена в проекте ${scope}.`, {
        code: 'issue_not_found',
      });
    }
    row = db.prepare(`${ISSUE_SELECT} WHERE i.project_key = ? AND i.num = ?`).get(parsed.projectKey, parsed.num);
  } else if (scope) {
    row = db.prepare(`${ISSUE_SELECT} WHERE i.project_key = ? AND i.num = ?`).get(scope, parsed.id);
  } else {
    row = db.prepare(`${ISSUE_SELECT} WHERE i.id = ?`).get(parsed.id);
  }

  if (!row) {
    throw new NotFoundError(`Задача ${ref} не найдена.`, {
      code: 'issue_not_found',
      hint: 'Посмотрите список: rat ls',
    });
  }
  return row;
}

/**
 * Публичное представление задачи (без внутреннего issues.id).
 * @param {object} row строка issues
 * @returns {object}
 */
export function serializeIssue(row) {
  return {
    id: formatIssueId(row),
    project: row.project_key,
    num: Number(row.num),
    title: row.title,
    body: row.body ?? '',
    status: row.status,
    priority: Number(row.priority),
    labels: parseLabelsJson(row.labels),
    assignee: row.assignee ?? null,
    ref: row.ref ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    closed_at: row.closed_at === null || row.closed_at === undefined ? null : Number(row.closed_at),
    close_reason: row.close_reason ?? null,
    meta: parseMetaJson(row.meta),
  };
}

/**
 * Публичное представление события: публичный id задачи вместо внутренних.
 * @param {object|null} event событие из events.listEvents / appendEvent
 * @returns {{id:number, issue:string|null, project:string|null, ts:number, actor:string, kind:string, data:object}|null}
 */
export function serializeEvent(event) {
  if (!event) return null;
  const project = event.project_key ?? null;
  const num = event.num === undefined || event.num === null ? null : Number(event.num);
  const issue = event.public_id ?? (project !== null && num !== null ? `${project}-${num}` : null);
  let data = event.data ?? {};
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }
  return {
    id: Number(event.id),
    issue,
    project,
    ts: Number(event.ts),
    actor: event.actor,
    kind: event.kind,
    data,
  };
}

// ---------------------------------------------------------------------------
// Чтение M2: поиск/списки, next, лента, статистика

/**
 * Поиск задач с фильтрами и курсорной пагинацией.
 *
 * `project = null` — все НЕархивные проекты; явный проект ищется даже в архиве.
 * `status` — одно значение, `active` (open+doing+blocked) или `all`.
 * `q` — FTS5 (BM25 не используется, порядок задаёт sort); если FTS5 нет или
 * запрос синтаксически невалиден — прозрачный фолбэк на LIKE.
 *
 * @param {{db: import('node:sqlite').DatabaseSync, hasFts5?: boolean}} wrapper
 * @param {{
 *   project?: string|null,
 *   status?: string,
 *   label?: string|null,
 *   q?: string|null,
 *   priority?: number|string|null,
 *   limit?: number|string,
 *   sort?: 'pri'|'updated',
 *   cursor?: string|null
 * }} [options]
 * @returns {{issues: object[], nextCursor: string|null}}
 * @throws {UsageError|NotFoundError}
 */
export function searchIssues(wrapper, {
  project = null,
  status = 'active',
  label = null,
  q = null,
  priority = null,
  limit = 50,
  sort = 'pri',
  cursor = null,
} = {}) {
  ensureReady(wrapper);
  const db = unwrapDb(wrapper);
  const sortMode = normalizeSort(sort);
  const limitValue = normalizeSearchLimit(limit);
  const statusFilter = normalizeStatusFilter(status);
  const projectKey = isEmpty(project) ? null : requireExistingProject(db, project);
  const labelValue = isEmpty(label) ? null : normalizeLabel(label);
  const priorityRange = parsePriorityFilter(priority);
  const queryText = normalizeQueryText(q);
  const cursorValue = decodeCursor(cursor, sortMode);

  const baseWhere = [];
  const baseParams = [];

  if (projectKey === null) {
    baseWhere.push('i.project_key IN (SELECT key FROM projects WHERE archived_at IS NULL)');
  } else {
    baseWhere.push('i.project_key = ?');
    baseParams.push(projectKey);
  }

  if (statusFilter === 'active') {
    baseWhere.push(`i.status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})`);
    baseParams.push(...ACTIVE_STATUSES);
  } else if (statusFilter !== 'all') {
    baseWhere.push('i.status = ?');
    baseParams.push(statusFilter);
  }

  if (labelValue !== null) {
    baseWhere.push(
      `EXISTS (
         SELECT 1 FROM json_each(
           CASE WHEN json_valid(i.labels) THEN i.labels ELSE '[]' END
         ) WHERE json_each.value = ?
       )`,
    );
    baseParams.push(labelValue);
  }

  if (priorityRange !== null) {
    if (priorityRange.min === priorityRange.max) {
      baseWhere.push('i.priority = ?');
      baseParams.push(priorityRange.min);
    } else {
      baseWhere.push('i.priority BETWEEN ? AND ?');
      baseParams.push(priorityRange.min, priorityRange.max);
    }
  }

  const orderSql = sortMode === 'updated'
    ? 'i.updated_at DESC, i.id DESC'
    : 'i.priority ASC, i.updated_at ASC, i.id ASC';

  const ftsQuery = queryText === null ? null : buildFtsQuery(queryText);
  const tryFtsFirst = ftsQuery !== null && ftsAvailable(wrapper);

  const execute = (useFts) => {
    const where = [...baseWhere];
    const params = [...baseParams];

    if (queryText !== null) {
      if (useFts) {
        where.push('i.id IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?)');
        params.push(ftsQuery);
      } else {
        const terms = buildLikeTerms(queryText);
        const columns = ['i.title', 'i.body', 'i.labels'];
        const clauses = terms.map(
          () =>
            `(${columns
              .map((column) => `rat_lower(${column}) LIKE ? ESCAPE '\\'`)
              .join(' OR ')})`,
        );
        where.push(`(${clauses.join(' AND ')})`);
        for (const term of terms) {
          const pattern = `%${escapeLike(term)}%`;
          params.push(pattern, pattern, pattern);
        }
      }
    }

    if (cursorValue !== null) {
      if (sortMode === 'updated') {
        where.push('(i.updated_at < ? OR (i.updated_at = ? AND i.id < ?))');
        params.push(cursorValue.updatedAt, cursorValue.updatedAt, cursorValue.id);
      } else {
        where.push(
          `(i.priority > ? OR (i.priority = ? AND
             (i.updated_at > ? OR (i.updated_at = ? AND i.id > ?))))`,
        );
        params.push(
          cursorValue.priority,
          cursorValue.priority,
          cursorValue.updatedAt,
          cursorValue.updatedAt,
          cursorValue.id,
        );
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db
      .prepare(`${ISSUE_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ?`)
      .all(...params, limitValue + 1);
  };

  ensureLowerFunction(db);
  let rows;
  if (tryFtsFirst) {
    try {
      rows = execute(true);
    } catch {
      // синтаксическая ошибка/поломка FTS — прозрачно повторяем через LIKE
      rows = execute(false);
    }
  } else {
    rows = execute(false);
  }

  const issues = rows.slice(0, limitValue).map(serializeIssue);
  const nextCursor = rows.length > limitValue
    ? encodeCursor(sortMode, rows[limitValue - 1])
    : null;

  return { issues, nextCursor };
}

/**
 * Следующая задача: status=open → priority asc → updated_at asc → id asc.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{project?: string|null, label?: string|null}} [options]
 * @returns {object|null} публичная задача или null
 * @throws {UsageError|NotFoundError}
 */
export function nextIssue(wrapper, { project = null, label = null } = {}) {
  ensureReady(wrapper);
  const db = unwrapDb(wrapper);
  const projectKey = isEmpty(project) ? null : requireExistingProject(db, project);
  const labelValue = isEmpty(label) ? null : normalizeLabel(label);

  const where = ["i.status = 'open'"];
  const params = [];

  if (projectKey === null) {
    where.push('i.project_key IN (SELECT key FROM projects WHERE archived_at IS NULL)');
  } else {
    where.push('i.project_key = ?');
    params.push(projectKey);
  }

  if (labelValue !== null) {
    where.push(
      `EXISTS (
         SELECT 1 FROM json_each(
           CASE WHEN json_valid(i.labels) THEN i.labels ELSE '[]' END
         ) WHERE json_each.value = ?
       )`,
    );
    params.push(labelValue);
  }

  const row = db
    .prepare(
      `${ISSUE_SELECT} WHERE ${where.join(' AND ')}
       ORDER BY i.priority ASC, i.updated_at ASC, i.id ASC LIMIT 1`,
    )
    .get(...params);

  return row ? serializeIssue(row) : null;
}

/**
 * Лента событий с публичными id. Обёртка над events.listEvents.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{project?: string|null, since?: number|string|null, kind?: string|null, limit?: number}} [options]
 * @returns {Array<{id:number, issue:string|null, project:string|null, ts:number, actor:string, kind:string, data:object}>}
 * @throws {UsageError|NotFoundError}
 */
export function listLog(wrapper, { project = null, since = null, kind = null, limit = 50 } = {}) {
  ensureReady(wrapper);
  const db = unwrapDb(wrapper);
  const projectKey = isEmpty(project) ? null : requireExistingProject(db, project);
  return listEvents(wrapper, { projectKey, since, kind, limit }).map(serializeEvent);
}

/**
 * Сводка: счётчики по проектам, итоги по статусам/приоритетам и активность
 * за последние 7 суток (created — issues.created_at, closed — closed_at,
 * comments — события kind=comment).
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{now?: number}} [options]
 * @returns {{
 *   projects: Array<{key:string, name:string, counts:Record<string,number>}>,
 *   totals: {byStatus:Record<string,number>, byPriority:Record<string,number>, total:number},
 *   week: {created:number, closed:number, comments:number}
 * }}
 */
export function getStats(wrapper, { now = Date.now() } = {}) {
  ensureReady(wrapper);
  const db = unwrapDb(wrapper);

  const projectRows = db
    .prepare(
      `SELECT p.key, p.name,
              COALESCE(SUM(CASE WHEN i.status = 'open' THEN 1 ELSE 0 END), 0) AS open_count,
              COALESCE(SUM(CASE WHEN i.status = 'doing' THEN 1 ELSE 0 END), 0) AS doing_count,
              COALESCE(SUM(CASE WHEN i.status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked_count,
              COALESCE(SUM(CASE WHEN i.status = 'deferred' THEN 1 ELSE 0 END), 0) AS deferred_count,
              COALESCE(SUM(CASE WHEN i.status = 'done' THEN 1 ELSE 0 END), 0) AS done_count,
              COALESCE(SUM(CASE WHEN i.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count,
              COUNT(i.id) AS total
       FROM projects p
       LEFT JOIN issues i ON i.project_key = p.key
       GROUP BY p.key
       ORDER BY p.key`,
    )
    .all();

  const projects = projectRows.map((row) => ({
    key: row.key,
    name: row.name,
    counts: {
      open: Number(row.open_count),
      doing: Number(row.doing_count),
      blocked: Number(row.blocked_count),
      deferred: Number(row.deferred_count),
      done: Number(row.done_count),
      cancelled: Number(row.cancelled_count),
      total: Number(row.total),
    },
  }));

  const byStatus = Object.fromEntries(ISSUE_STATUSES.map((status) => [status, 0]));
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM issues GROUP BY status').all()) {
    if (Object.hasOwn(byStatus, row.status)) byStatus[row.status] = Number(row.n);
  }

  const byPriority = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const row of db.prepare('SELECT priority, COUNT(*) AS n FROM issues GROUP BY priority').all()) {
    byPriority[Number(row.priority)] = Number(row.n);
  }

  const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0);
  const cutoff = Number(now) - WEEK_MS;

  const week = {
    created: Number(
      db.prepare('SELECT COUNT(*) AS n FROM issues WHERE created_at >= ?').get(cutoff).n,
    ),
    closed: Number(
      db
        .prepare('SELECT COUNT(*) AS n FROM issues WHERE closed_at IS NOT NULL AND closed_at >= ?')
        .get(cutoff).n,
    ),
    comments: Number(
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'comment' AND ts >= ?").get(cutoff).n,
    ),
  };

  return { projects, totals: { byStatus, byPriority, total }, week };
}

// ---------------------------------------------------------------------------
// Внутренние помощники M2

function ensureReady(wrapper) {
  if (getSchemaVersion(wrapper) === 0) {
    throw new NotFoundError('База не инициализирована.', {
      code: 'db_not_initialized',
      hint: 'Выполните: rat init',
    });
  }
}

function requireExistingProject(db, value) {
  const key = normalizeProjectKey(String(value));
  const row = getProject(db, key);
  if (!row) {
    throw new NotFoundError(`Проект ${key} не найден.`, {
      code: 'project_not_found',
      hint: `Создайте проект: rat project add ${key} --name "..."`,
    });
  }
  return key;
}

function normalizeStatusFilter(value) {
  if (value === null || value === undefined || value === '') return 'active';
  if (typeof value !== 'string') {
    throw new UsageError('Статус: ожидается строка.', { code: 'invalid_status' });
  }
  const status = value.trim().toLowerCase();
  if (status === 'all' || status === 'active') return status;
  if (!ISSUE_STATUSES.includes(status)) {
    throw new UsageError(
      `Недопустимый статус «${value}». Допустимо: ${[...ISSUE_STATUSES, 'active', 'all'].join(', ')}.`,
      { code: 'invalid_status' },
    );
  }
  return status;
}

function normalizeLabel(value) {
  if (typeof value !== 'string') {
    throw new UsageError('--label: ожидается строка.', { code: 'invalid_labels' });
  }
  return value.trim().toLowerCase();
}

function normalizeQueryText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new UsageError('-q: ожидается строка.', { code: 'invalid_query' });
  }
  const text = value.trim();
  return text === '' ? null : text;
}

function normalizeSort(value) {
  const sort = value === null || value === undefined ? 'pri' : String(value).trim().toLowerCase();
  if (sort !== 'pri' && sort !== 'updated') {
    throw new UsageError(`Сортировка «${value}»: допустимо pri или updated.`, {
      code: 'invalid_sort',
    });
  }
  return sort;
}

function normalizeSearchLimit(value) {
  if (value === null || value === undefined || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new UsageError('--limit: ожидается целое число 1..10000.', { code: 'invalid_limit' });
  }
  return limit;
}

function parsePriorityFilter(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 3) {
      throw new UsageError('Приоритет: ожидается целое число 0..3.', { code: 'invalid_priority' });
    }
    return { min: value, max: value };
  }
  const text = String(value).trim().toLowerCase();
  const range = /^([0-3])\s*\.\.\s*([0-3])$/.exec(text);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const prefixed = /^p([0-3])$/.exec(text);
  if (prefixed) {
    const priority = Number(prefixed[1]);
    return { min: priority, max: priority };
  }
  if (/^[0-3]$/.test(text)) {
    const priority = Number(text);
    return { min: priority, max: priority };
  }
  throw new UsageError(
    `Приоритет «${value}»: допустимо 0..3, p0..p3 или диапазон 0..1.`,
    { code: 'invalid_priority' },
  );
}

/** FTS5 доступен только если рантайм-флаг не false И таблица реально есть. */
function ftsAvailable(wrapper) {
  const holder = wrapper && typeof wrapper === 'object' && wrapper.db ? wrapper : null;
  if (holder && holder.hasFts5 === false) return false;
  const db = unwrapDb(wrapper);
  try {
    return Boolean(
      db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'issues_fts'")
        .get(),
    );
  } catch {
    return false;
  }
}

/** Безопасный MATCH: только буквы/цифры/_ в кавычках. */
function buildFtsQuery(text) {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ');
}

function buildLikeTerms(text) {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (tokens && tokens.length > 0) return tokens;
  return [text.toLowerCase()];
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const LOWER_REGISTERED = new WeakSet();

/** UDF rat_lower: SQLite lower() не умеет кириллицу, а LIKE в тестах должен. */
function ensureLowerFunction(db) {
  if (LOWER_REGISTERED.has(db)) return;
  try {
    db.function('rat_lower', { deterministic: true }, (value) =>
      typeof value === 'string' ? value.toLowerCase() : value,
    );
  } catch {
    // уже зарегистрирована на этом коннекте (например, другим вызовом)
  }
  LOWER_REGISTERED.add(db);
}

function encodeCursor(sort, row) {
  const payload = {
    v: 1,
    sort,
    p: Number(row.priority),
    u: Number(row.updated_at),
    i: Number(row.id),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor, sort) {
  if (isEmpty(cursor)) return null;
  if (typeof cursor !== 'string') {
    throw new UsageError('Курсор: ожидается строка.', { code: 'invalid_cursor' });
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new UsageError('Курсор: не удалось разобрать.', { code: 'invalid_cursor' });
  }
  const valid =
    parsed !== null &&
    typeof parsed === 'object' &&
    parsed.v === 1 &&
    Number.isInteger(parsed.i) &&
    parsed.i > 0 &&
    Number.isInteger(parsed.u) &&
    parsed.u >= 0 &&
    Number.isInteger(parsed.p) &&
    parsed.p >= 0 &&
    parsed.p <= 3 &&
    parsed.sort === sort;
  if (!valid) {
    throw new UsageError('Курсор: неверный формат или не та сортировка.', {
      code: 'invalid_cursor',
    });
  }
  return { priority: parsed.p, updatedAt: parsed.u, id: parsed.i };
}

function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function parseLabelsJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseMetaJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requireProject(db, key, source) {
  const row = getProject(db, key);
  if (!row) {
    throw new NotFoundError(`Проект ${key} не найден.`, {
      code: 'project_not_found',
      hint: `Создайте проект: rat project add ${key} --name "..."`,
    });
  }
  return { ...row, source };
}

function normalizeFsPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathPrefix(parent, child) {
  if (parent === child) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

function formatRef(parsed) {
  return `${parsed.projectKey}-${parsed.num}`;
}
