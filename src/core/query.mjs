import path from 'node:path';

import {
  ensureSchemaCurrent,
  NotFoundError,
  readMeta,
  unwrapDb,
  UsageError,
} from './db.mjs';
import { listEvents } from './events.mjs';

/** Ключ проекта: uppercase, 2–10 символов A-Z0-9. */
export const PROJECT_KEY_RE = /^[A-Z0-9]{2,10}$/;

/** Допустимые статусы задачи. */
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

/** Допустимые состояния милстоуна. */
export const MILESTONE_STATES = Object.freeze(['open', 'closed']);

/** Максимальная длина имени милстоуна в символах. */
export const MAX_MILESTONE_NAME_LENGTH = 200;

/** Колонки задачи, которые нужны serializeIssue. */
export const ISSUE_SELECT = `
  SELECT i.id, i.project_key, i.num, i.title, i.body, i.status, i.priority,
         i.labels, i.assignee, i.ref,
         (SELECT m.name FROM milestones m WHERE m.id = i.milestone_id) AS milestone,
         i.created_at, i.updated_at,
         i.closed_at, i.close_reason, i.meta
  FROM issues i`;

/** Колонки милстоуна + агрегаты прогресса (без JOIN/GROUP BY). */
export const MILESTONE_SELECT = `
  SELECT m.id, m.project_key, m.name, m.name_key, m.body, m.due_at, m.state,
         m.created_at, m.updated_at, m.closed_at, m.meta,
         (SELECT COUNT(*) FROM issues i WHERE i.milestone_id = m.id) AS total,
         (SELECT COUNT(*) FROM issues i WHERE i.milestone_id = m.id AND i.status = 'done') AS done,
         (SELECT COUNT(*) FROM issues i WHERE i.milestone_id = m.id AND i.status = 'cancelled') AS cancelled
  FROM milestones m`;

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
  ensureSchemaCurrent(wrapperOrDb);

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
    milestone: row.milestone ?? null,
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
// Милстоуны: чтение

/**
 * Нормализует имя милстоуна: trim, непустое, не длиннее 200 символов.
 * @param {unknown} value
 * @returns {string}
 * @throws {UsageError} invalid_milestone_name
 */
export function normalizeMilestoneName(value) {
  if (typeof value !== 'string') {
    throw new UsageError('Имя милстоуна должно быть строкой.', {
      code: 'invalid_milestone_name',
    });
  }
  const name = value.trim();
  if (name === '') {
    throw new UsageError('Имя милстоуна не может быть пустым.', {
      code: 'invalid_milestone_name',
    });
  }
  if (name.length > MAX_MILESTONE_NAME_LENGTH) {
    throw new UsageError(
      `Имя милстоуна длиннее ${MAX_MILESTONE_NAME_LENGTH} символов (${name.length}).`,
      { code: 'invalid_milestone_name' },
    );
  }
  return name;
}

/**
 * Ключ имени для UNIQUE(project_key, name_key): trim + toLowerCase.
 * SQLite COLLATE NOCASE не понижает регистр кириллицы, поэтому нормализация
 * делается в JS.
 * @param {unknown} name
 * @returns {string}
 */
export function milestoneNameKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

/**
 * Строка milestones (+ агрегаты) → публичное представление.
 * @param {object} row
 * @returns {object}
 */
export function serializeMilestone(row) {
  const total = Number(row.total ?? 0);
  const done = Number(row.done ?? 0);
  const cancelled = Number(row.cancelled ?? 0);
  const denominator = total - cancelled;
  const percent = denominator > 0 ? Math.floor((done * 100) / denominator) : 0;
  return {
    project: row.project_key,
    name: row.name,
    body: row.body ?? '',
    due_at: row.due_at === null || row.due_at === undefined ? null : Number(row.due_at),
    state: row.state,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    closed_at: row.closed_at === null || row.closed_at === undefined ? null : Number(row.closed_at),
    progress: { total, done, cancelled, percent },
  };
}

/**
 * Сырая строка milestones (+ агрегаты) по имени в проекте.
 * @param {{db: import('node:sqlite').DatabaseSync}|import('node:sqlite').DatabaseSync} wrapperOrDb
 * @param {{ref: string, projectKey: string}} input
 * @returns {object}
 * @throws {UsageError} invalid_milestone
 * @throws {NotFoundError} milestone_not_found
 */
export function resolveMilestone(wrapperOrDb, { ref, projectKey } = {}) {
  const db = unwrapDb(wrapperOrDb);
  const name = typeof ref === 'string' ? ref.trim() : '';
  const scope = typeof projectKey === 'string' ? projectKey.trim() : '';
  if (name === '' || scope === '') {
    throw new UsageError('Не задан милстоун (имя) или проект.', {
      code: 'invalid_milestone',
      hint: 'Посмотрите милстоуны: rat milestone ls',
    });
  }
  const row = db
    .prepare(`${MILESTONE_SELECT} WHERE m.project_key = ? AND m.name_key = ?`)
    .get(normalizeProjectKey(scope), milestoneNameKey(name));
  if (!row) {
    throw new NotFoundError(`Милстоун «${name}» не найден в проекте ${normalizeProjectKey(scope)}.`, {
      code: 'milestone_not_found',
      hint: 'Посмотрите милстоуны: rat milestone ls',
    });
  }
  return row;
}

/**
 * Публичное представление одного милстоуна.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{ref: string, project?: string|null, projectKey?: string|null, cwd?: string, env?: NodeJS.ProcessEnv}} input
 * @returns {object}
 */
export function getMilestone(wrapper, {
  ref,
  project = null,
  projectKey = null,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const db = unwrapDb(wrapper);
  const projectRow = resolveProject(db, { project: projectKey ?? project, cwd, env });
  return serializeMilestone(resolveMilestone(db, { ref, projectKey: projectRow.key }));
}

/**
 * Список милстоунов с прогрессом.
 * `project = null` → все неархивные проекты; явный проект ищется и в архиве.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{project?: string|null, state?: 'open'|'closed'|'all', includeArchived?: boolean, cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 */
export function listMilestones(wrapper, {
  project = null,
  state = 'open',
  includeArchived = false,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  ensureReady(wrapper);
  const db = unwrapDb(wrapper);
  const stateFilter = normalizeMilestoneState(state);

  const where = [];
  const params = [];
  const hasProject = project !== null && project !== undefined && String(project).trim() !== '';
  if (hasProject) {
    const projectRow = resolveProject(db, { project, cwd, env });
    where.push('m.project_key = ?');
    params.push(projectRow.key);
  } else if (!includeArchived) {
    where.push('m.project_key IN (SELECT key FROM projects WHERE archived_at IS NULL)');
  }

  if (stateFilter !== 'all') {
    where.push('m.state = ?');
    params.push(stateFilter);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql =
    "ORDER BY CASE m.state WHEN 'open' THEN 0 ELSE 1 END, (m.due_at IS NULL), m.due_at ASC, m.name_key ASC";

  return db
    .prepare(`${MILESTONE_SELECT} ${whereSql} ${orderSql}`)
    .all(...params)
    .map(serializeMilestone);
}

// ---------------------------------------------------------------------------
// Канон: чтение

/** Допустимые состояния канон-правила. */
export const CANON_STATES = Object.freeze(['active', 'repealed']);

/** Колонки канон-правила + публичная ссылка на заменённое правило (KEY-Cn). */
export const CANON_SELECT = `
  SELECT c.id, c.project_key, c.num, c.title, c.body, c.status, c.priority,
         c.labels, c.source_issue, c.supersedes_id,
         (SELECT c2.project_key || '-C' || c2.num
          FROM canon c2 WHERE c2.id = c.supersedes_id) AS supersedes,
         c.created_at, c.updated_at, c.repealed_at, c.repeal_reason,
         c.created_by, c.repealed_by, c.meta
  FROM canon c`;

/**
 * Публичный идентификатор канон-правила: KEY-C1.
 * @param {{project_key:string, num:number}} rule
 * @returns {string}
 */
export function formatCanonId(rule) {
  return `${rule.project_key}-C${Number(rule.num)}`;
}

/**
 * Разбирает ссылку на канон-правило: RAT-C1, C1 или голое число — num внутри
 * переданного projectKey (scope), как у задач с числовым id.
 * @param {string|number} ref
 * @param {{projectKey?: string|null}} [options]
 * @returns {{projectKey:string, num:number}}
 * @throws {UsageError} invalid_canon_ref
 */
export function parseCanonRef(ref, { projectKey = null } = {}) {
  if (typeof ref !== 'string' && typeof ref !== 'number') {
    throw new UsageError('Идентификатор канон-правила должен быть строкой или числом.', {
      code: 'invalid_canon_ref',
    });
  }
  const value = String(ref).trim();
  const full = /^([A-Za-z0-9]{2,10})-C(\d+)$/i.exec(value);
  if (full) {
    const num = Number(full[2]);
    if (num > 0) return { projectKey: normalizeProjectKey(full[1]), num };
  }
  const scope = projectKey === null || projectKey === undefined ? null : normalizeProjectKey(projectKey);
  if (scope) {
    const scoped = /^C(\d+)$/i.exec(value);
    const bare = /^(\d+)$/.exec(value);
    const num = scoped ? Number(scoped[1]) : bare ? Number(bare[1]) : null;
    if (num !== null && num > 0) return { projectKey: scope, num };
  }
  throw new UsageError(
    `Некорректный идентификатор канон-правила «${ref}»: ожидается RAT-C1${scope ? ' или C1' : ''}.`,
    { code: 'invalid_canon_ref' },
  );
}

/**
 * Сырая строка canon по ссылке. projectKey (scope) нужен для C1 / голого числа.
 * @param {{db: import('node:sqlite').DatabaseSync}|import('node:sqlite').DatabaseSync} wrapperOrDb
 * @param {{ref: string|number, projectKey?: string|null}} [input]
 * @returns {object}
 * @throws {UsageError} invalid_canon_ref
 * @throws {NotFoundError} canon_not_found
 */
export function resolveCanon(wrapperOrDb, { ref, projectKey = null } = {}) {
  const db = unwrapDb(wrapperOrDb);
  const parsed = parseCanonRef(ref, { projectKey });
  const row = db
    .prepare(`${CANON_SELECT} WHERE c.project_key = ? AND c.num = ?`)
    .get(parsed.projectKey, parsed.num);
  if (!row) {
    throw new NotFoundError(`Канон-правило ${formatCanonId(parsed)} не найдено.`, {
      code: 'canon_not_found',
      hint: 'Посмотрите правила: rat canon ls',
    });
  }
  return row;
}

/**
 * Строка canon → публичное представление. Порядок полей фиксирован (контракт,
 * его фиксируют тесты и экспорт jsonl: type, id, project, ...).
 * @param {object} row
 * @returns {object}
 */
export function serializeCanon(row) {
  return {
    id: formatCanonId(row),
    project: row.project_key,
    num: Number(row.num),
    title: row.title,
    body: row.body ?? '',
    status: row.status,
    priority: Number(row.priority),
    labels: parseLabelsJson(row.labels),
    source_issue: row.source_issue ?? null,
    supersedes: row.supersedes ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    repealed_at: row.repealed_at === null || row.repealed_at === undefined ? null : Number(row.repealed_at),
    repeal_reason: row.repeal_reason ?? null,
    created_by: row.created_by,
    repealed_by: row.repealed_by ?? null,
    meta: parseMetaJson(row.meta),
  };
}

/**
 * Список канон-правил. По умолчанию — только активные («актуальные решения»).
 * project = null → все неархивные проекты. Сортировка: active первыми → priority
 * asc → created_at asc → id asc. `q` — дешёвый LIKE по title/body (без FTS).
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{project?: string|null, state?: 'active'|'repealed'|'all', label?: string|null, q?: string|null, includeArchived?: boolean, cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {object[]}
 * @throws {UsageError|NotFoundError}
 */
export function listCanon(wrapper, {
  project = null,
  state = 'active',
  label = null,
  q = null,
  includeArchived = false,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  ensureReady(wrapper);
  const db = unwrapDb(wrapper);
  const stateFilter = normalizeCanonState(state);
  const labelValue = isEmpty(label) ? null : normalizeLabel(label);
  const queryText = isEmpty(q) ? null : String(q).trim();

  const where = [];
  const params = [];

  if (project !== null && project !== undefined && !isEmpty(project)) {
    const projectRow = resolveProject(db, { project, cwd, env });
    where.push('c.project_key = ?');
    params.push(projectRow.key);
  } else if (!includeArchived) {
    where.push('c.project_key IN (SELECT key FROM projects WHERE archived_at IS NULL)');
  }

  if (stateFilter !== 'all') {
    where.push('c.status = ?');
    params.push(stateFilter);
  }

  if (labelValue !== null) {
    where.push(
      `EXISTS (
         SELECT 1 FROM json_each(
           CASE WHEN json_valid(c.labels) THEN c.labels ELSE '[]' END
         ) WHERE json_each.value = ?
       )`,
    );
    params.push(labelValue);
  }

  if (queryText !== null) {
    ensureLowerFunction(db);
    const pattern = `%${escapeLike(queryText.toLowerCase())}%`;
    where.push(
      `(rat_lower(c.title) LIKE ? ESCAPE '\\' OR rat_lower(c.body) LIKE ? ESCAPE '\\')`,
    );
    params.push(pattern, pattern);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql =
    "ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END, c.priority ASC, c.created_at ASC, c.id ASC";

  return db
    .prepare(`${CANON_SELECT} ${whereSql} ${orderSql}`)
    .all(...params)
    .map(serializeCanon);
}

/** Нормализует состояние канон-правила для фильтра: active|repealed|all. */
function normalizeCanonState(value) {
  if (value === null || value === undefined || value === '') return 'active';
  if (typeof value !== 'string') {
    throw new UsageError('Состояние канон-правила: ожидается строка.', { code: 'invalid_state' });
  }
  const state = value.trim().toLowerCase();
  if (state === 'all' || CANON_STATES.includes(state)) return state;
  throw new UsageError(
    `Недопустимое состояние «${value}». Допустимо: ${[...CANON_STATES, 'all'].join(', ')}.`,
    { code: 'invalid_state' },
  );
}

// ---------------------------------------------------------------------------
// Чтение: поиск/списки, next, лента, статистика

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
 *   milestone?: string|null,
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
  milestone = null,
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

  const milestoneFilter = isEmpty(milestone) ? null : milestoneNameKey(milestone);
  if (milestoneFilter === 'none') {
    baseWhere.push('i.milestone_id IS NULL');
  } else if (milestoneFilter !== null) {
    baseWhere.push('i.milestone_id IN (SELECT id FROM milestones WHERE name_key = ?)');
    baseParams.push(milestoneFilter);
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
// Внутренние помощники

function ensureReady(wrapper) {
  ensureSchemaCurrent(wrapper);
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

function normalizeMilestoneState(value) {
  if (value === null || value === undefined || value === '') return 'open';
  if (typeof value !== 'string') {
    throw new UsageError('Состояние милстоуна: ожидается строка.', {
      code: 'invalid_state',
    });
  }
  const state = value.trim().toLowerCase();
  if (state === 'all' || MILESTONE_STATES.includes(state)) return state;
  throw new UsageError(
    `Недопустимое состояние «${value}». Допустимо: ${[...MILESTONE_STATES, 'all'].join(', ')}.`,
    { code: 'invalid_state' },
  );
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
