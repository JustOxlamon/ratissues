import path from 'node:path';

import {
  ConflictError,
  DbError,
  ensureSchemaCurrent,
  getSchemaVersion,
  migrate,
  NotFoundError,
  readMeta,
  REPO_ROOT,
  SCHEMA_VERSION,
  tableExists,
  transaction,
  unwrapDb,
  UsageError,
} from './db.mjs';
import { appendEvent, listEvents, resolveActor } from './events.mjs';
import {
  formatIssueId,
  getProject,
  ISSUE_SELECT,
  ISSUE_STATUSES,
  milestoneNameKey,
  MILESTONE_STATES,
  normalizeMilestoneName,
  normalizeProjectKey,
  resolveIssue,
  resolveMilestone,
  resolveProject,
  serializeEvent,
  serializeIssue,
  serializeMilestone,
} from './query.mjs';

export { ISSUE_STATUSES };

/** Проект, который создаётся при `rat init`. */
export const DEFAULT_PROJECT_KEY = 'RAT';
export const DEFAULT_PROJECT_NAME = 'RatIssues';

/** Закрытые статусы: выход только через reopen. */
export const CLOSED_STATUSES = Object.freeze(['done', 'cancelled']);

/** Приоритет по умолчанию (PLAN §3). */
export const DEFAULT_PRIORITY = 2;

/** Предел размера title/body в байтах (PLAN §3: «до ~64 КБ»). */
export const MAX_TEXT_BYTES = 64 * 1024;

/*
 * store.mjs — единственный доменный писатель в БД. CLI и HTTP API вызывают
 * только его функции, а не SQL напрямую.
 *
 * M0: initDatabase, doctor.
 * M1: createProject, listProjectsWithCounts, createIssue, getIssue,
 * getIssueDetail, changeStatus, claimIssue, addComment. Все изменения пишут
 * событие через events.appendEvent в той же транзакции, что и строку issues.
 * M2: editIssue (одно событие kind=edit на изменённое поле), archiveProject.
 * Чтение M2 (searchIssues, nextIssue, listLog, getStats) живёт в query.mjs.
 */

/**
 * Создаёт/догоняет схему и гарантирует проект RAT по умолчанию.
 * Идемпотентна: повторный вызов не меняет schema_version и не дублирует проект.
 * @param {{db: import('node:sqlite').DatabaseSync, path?: string}} wrapper
 * @returns {{path: string|null, schemaVersion: number, hasFts5: boolean, defaultProject: string|null, projectCreated: boolean}}
 * @throws {DbError} при ошибке миграции
 */
export function initDatabase(wrapper) {
  const db = unwrapDb(wrapper);
  const migration = migrate(wrapper);

  let projectCreated = false;
  try {
    transaction(db, () => {
      const projectCount = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
      if (Number(projectCount) === 0) {
        db.prepare(
          `INSERT INTO projects(key, name, root_path, color, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(DEFAULT_PROJECT_KEY, DEFAULT_PROJECT_NAME, REPO_ROOT, 'lime', Date.now());
        projectCreated = true;
      }
      if (!readMeta(db, 'default_project')) {
        const fallback =
          db.prepare("SELECT key FROM projects WHERE key = 'RAT'").get() ??
          db.prepare('SELECT key FROM projects ORDER BY created_at, key LIMIT 1').get();
        if (fallback) {
          db.prepare(
            'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          ).run('default_project', fallback.key);
        }
      }
    }, 'IMMEDIATE');
  } catch (err) {
    if (err instanceof DbError) throw err;
    throw new DbError(`Не удалось подготовить проект по умолчанию: ${err?.message ?? err}`, {
      code: 'init_failed',
      cause: err,
    });
  }

  return {
    path: wrapper?.path ?? null,
    schemaVersion: migration.schemaVersion,
    hasFts5: migration.hasFts5,
    defaultProject: readMeta(db, 'default_project'),
    projectCreated,
  };
}

/**
 * Создаёт проект. Ключ нормализуется (uppercase, /^[A-Z0-9]{2,10}$/),
 * дубль → ConflictError. Если проектов ещё не было, новый ключ становится
 * meta.default_project.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{key:string, name:string, rootPath?:string|null, color?:string|null, cwd?:string}} input
 * @returns {{key:string,name:string,root_path:string|null,color:string,created_at:number,archived_at:number|null}}
 * @throws {UsageError|ConflictError|NotFoundError}
 */
export function createProject(wrapper, { key, name, rootPath = null, color = null, cwd } = {}) {
  ensureInitialized(wrapper);
  const projectKey = normalizeProjectKey(key);
  const projectName = requireNonEmptyString(name, 'Имя проекта');
  const root = normalizeRootPath(rootPath, cwd ?? process.cwd());
  const projectColor = normalizeColor(color);
  const db = unwrapDb(wrapper);

  return transaction(wrapper, () => {
    if (getProject(db, projectKey)) {
      throw new ConflictError(`Проект ${projectKey} уже существует.`, {
        code: 'project_exists',
        hint: `Посмотреть проекты: rat project ls`,
      });
    }

    const hadProjects = Number(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n) > 0;
    const now = Date.now();
    db.prepare(
      `INSERT INTO projects(key, name, root_path, color, created_at, archived_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(projectKey, projectName, root, projectColor, now);

    if (!hadProjects || !readMeta(db, 'default_project')) {
      writeMetaValue(db, 'default_project', projectKey);
    }

    return getProject(db, projectKey);
  });
}

/**
 * Проекты со счётчиками по статусам. Стабильная сортировка по key.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{includeArchived?: boolean}} [options]
 * @returns {Array<{key:string,name:string,root_path:string|null,color:string,created_at:number,archived_at:number|null,counts:{open:number,doing:number,blocked:number,deferred:number,done:number,cancelled:number,total:number}}>}
 */
export function listProjectsWithCounts(wrapper, { includeArchived = false } = {}) {
  ensureInitialized(wrapper);
  const db = unwrapDb(wrapper);
  const where = includeArchived ? '' : 'WHERE p.archived_at IS NULL';
  const rows = db
    .prepare(
      `SELECT p.key, p.name, p.root_path, p.color, p.created_at, p.archived_at,
              COALESCE(SUM(CASE WHEN i.status = 'open' THEN 1 ELSE 0 END), 0) AS open_count,
              COALESCE(SUM(CASE WHEN i.status = 'doing' THEN 1 ELSE 0 END), 0) AS doing_count,
              COALESCE(SUM(CASE WHEN i.status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked_count,
               COALESCE(SUM(CASE WHEN i.status = 'deferred' THEN 1 ELSE 0 END), 0) AS deferred_count,
              COALESCE(SUM(CASE WHEN i.status = 'done' THEN 1 ELSE 0 END), 0) AS done_count,
              COALESCE(SUM(CASE WHEN i.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count,
              COUNT(i.id) AS total
       FROM projects p
       LEFT JOIN issues i ON i.project_key = p.key
       ${where}
       GROUP BY p.key
       ORDER BY p.key`,
    )
    .all();

  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    root_path: row.root_path,
    color: row.color,
    created_at: Number(row.created_at),
    archived_at: row.archived_at === null ? null : Number(row.archived_at),
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
}

/**
 * Создаёт задачу: BEGIN IMMEDIATE → max(num)+1 по проекту → insert → событие
 * created → commit. При повторном --idem возвращает существующую задачу.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{
 *   project?: string|null,
 *   projectKey?: string|null,
 *   title: string,
 *   body?: string,
 *   priority?: number|string|null,
 *   labels?: string[]|string|null,
 *   assignee?: string|null,
 *   ref?: string|null,
 *   milestone?: string|null,
 *   actor?: string,
 *   idem?: string|null,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv
 * }} input
 * @returns {object} публичное представление задачи + deduplicated:boolean
 * @throws {UsageError|NotFoundError|ConflictError}
 */
export function createIssue(wrapper, {
  project = null,
  projectKey = null,
  title,
  body = '',
  priority = null,
  labels = null,
  assignee = null,
  ref = null,
  milestone = null,
  actor,
  idem = null,
  cwd,
  env = process.env,
} = {}) {
  ensureInitialized(wrapper);
  const issueTitle = normalizeTitle(title);
  const issueBody = normalizeBody(body);
  const issuePriority = normalizePriority(priority);
  const issueLabels = normalizeLabels(labels);
  const issueAssignee = normalizeOptionalText(assignee, 'Исполнитель');
  const issueRef = normalizeOptionalText(ref, 'Ссылка');
  const idemValue = normalizeIdem(idem);
  const eventActor = resolveActor(actor, env);
  const requestedProject = projectKey ?? projectKeyOf(project);
  const db = unwrapDb(wrapper);

  return transaction(wrapper, () => {
    if (idemValue) {
      const existing = findEventByIdem(db, 'created', idemValue);
      if (existing) {
        return { ...serializeIssue(resolveIssue(db, existing.issue_id)), deduplicated: true };
      }
    }

    const projectRow = resolveProject(db, {
      project: requestedProject,
      cwd: cwd ?? process.cwd(),
      env,
    });

    const attach = resolveMilestoneForIssue(db, projectRow.key, milestone);

    const maxRow = db
      .prepare('SELECT MAX(num) AS max_num FROM issues WHERE project_key = ?')
      .get(projectRow.key);
    const num = Number(maxRow?.max_num ?? 0) + 1;
    const now = Date.now();

    const info = db
      .prepare(
        `INSERT INTO issues(
           project_key, num, title, body, status, priority, labels,
           assignee, ref, milestone_id, created_at, updated_at, closed_at, close_reason, meta
         ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '{}')`,
      )
      .run(
        projectRow.key,
        num,
        issueTitle,
        issueBody,
        issuePriority,
        JSON.stringify(issueLabels),
        issueAssignee,
        issueRef,
        attach?.id ?? null,
        now,
        now,
      );

    const issueRow = db.prepare(`${ISSUE_SELECT} WHERE i.id = ?`).get(Number(info.lastInsertRowid));
    const createdData = {};
    if (idemValue) createdData.idem = idemValue;
    if (attach) createdData.milestone = attach.name;
    appendEvent(db, {
      issueId: issueRow.id,
      kind: 'created',
      data: createdData,
      actor: eventActor,
      ts: now,
    });

    return { ...serializeIssue(issueRow), deduplicated: false };
  });
}

/**
 * Задача по публичному KEY-NUM или внутреннему числовому id.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {string|number} ref
 * @param {{projectKey?: string|null}} [options]
 * @returns {object} публичное представление (без внутреннего issues.id)
 * @throws {NotFoundError|UsageError}
 */
export function getIssue(wrapper, ref, { projectKey = null } = {}) {
  ensureInitialized(wrapper);
  return serializeIssue(resolveIssue(wrapper, ref, { projectKey }));
}

/**
 * Задача + последние N событий одним вызовом (для `rat show --json`).
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{ref: string|number, events?: number}} input
 * @returns {{issue: object, events: Array<object>}}
 */
export function getIssueDetail(wrapper, { ref, events = 20 } = {}) {
  ensureInitialized(wrapper);
  const limit = normalizeEventLimit(events);
  const issueRow = resolveIssue(wrapper, ref);
  const eventRows = limit === 0 ? [] : listEvents(wrapper, { issueId: issueRow.id, limit });
  return {
    issue: serializeIssue(issueRow),
    events: eventRows.map(serializeEvent),
  };
}

/**
 * Смена статуса. Из done/cancelled — только в open (reopen), иначе
 * ConflictError с подсказкой `rat reopen`. done/cancelled выставляют
 * closed_at/close_reason; любой другой статус их очищает. doing без
 * assignee ставит actor.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{ref:string|number, status:string, reason?:string|null, actor?:string, assignee?:string|null, env?:NodeJS.ProcessEnv}} input
 * @returns {{issue: object, event: object}}
 * @throws {UsageError|NotFoundError|ConflictError}
 */
export function changeStatus(wrapper, {
  ref,
  status,
  reason = null,
  actor,
  assignee,
  env = process.env,
} = {}) {
  ensureInitialized(wrapper);
  const targetStatus = normalizeStatus(status);
  const closeReason = normalizeOptionalText(reason, 'Причина');
  const explicitAssignee = assignee === undefined ? undefined : normalizeOptionalText(assignee, 'Исполнитель');
  const eventActor = resolveActor(actor, env);
  const db = unwrapDb(wrapper);

  return transaction(wrapper, () => {
    const issueRow = resolveIssue(wrapper, ref);
    const fromStatus = issueRow.status;
    assertTransitionAllowed(issueRow, targetStatus);

    const now = Date.now();
    let nextAssignee = explicitAssignee === undefined ? issueRow.assignee : explicitAssignee;
    if (targetStatus === 'doing' && (nextAssignee === null || nextAssignee === '')) {
      nextAssignee = eventActor;
    }
    const isClosed = CLOSED_STATUSES.includes(targetStatus);
    const closedAt = isClosed ? now : null;
    const finalReason = isClosed ? closeReason : null;

    db.prepare(
      `UPDATE issues
       SET status = ?, assignee = ?, updated_at = ?, closed_at = ?, close_reason = ?
       WHERE id = ?`,
    ).run(targetStatus, nextAssignee, now, closedAt, finalReason, issueRow.id);

    const event = appendEvent(db, {
      issueId: issueRow.id,
      kind: 'status',
      data: { from: fromStatus, to: targetStatus, reason: finalReason },
      actor: eventActor,
      ts: now,
    });

    return {
      issue: serializeIssue(resolveIssue(db, issueRow.id)),
      event: serializeEvent(event),
    };
  });
}

/**
 * Взять задачу в работу: status=doing, assignee=actor, событие kind=claim
 * (вместо события status — в PLAN claim отдельный kind).
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{ref:string|number, actor?:string, env?:NodeJS.ProcessEnv}} input
 * @returns {{issue: object, event: object}}
 * @throws {NotFoundError|ConflictError}
 */
export function claimIssue(wrapper, { ref, actor, env = process.env } = {}) {
  ensureInitialized(wrapper);
  const eventActor = resolveActor(actor, env);
  const db = unwrapDb(wrapper);

  return transaction(wrapper, () => {
    const issueRow = resolveIssue(wrapper, ref);
    assertTransitionAllowed(issueRow, 'doing');
    const fromStatus = issueRow.status;
    const now = Date.now();

    db.prepare(
      `UPDATE issues
       SET status = 'doing', assignee = ?, updated_at = ?, closed_at = NULL, close_reason = NULL
       WHERE id = ?`,
    ).run(eventActor, now, issueRow.id);

    const event = appendEvent(db, {
      issueId: issueRow.id,
      kind: 'claim',
      data: { from: fromStatus, to: 'doing', assignee: eventActor },
      actor: eventActor,
      ts: now,
    });

    return {
      issue: serializeIssue(resolveIssue(db, issueRow.id)),
      event: serializeEvent(event),
    };
  });
}

/**
 * Добавляет неизменяемый комментарий и обновляет issues.updated_at.
 * При повторе --idem в рамках той же задачи возвращает существующий
 * комментарий без дубля.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{ref:string|number, text:string, actor?:string, idem?:string|null, env?:NodeJS.ProcessEnv}} input
 * @returns {object} публичное событие-комментарий + deduplicated:boolean
 * @throws {UsageError|NotFoundError}
 */
export function addComment(wrapper, { ref, text, actor, idem = null, env = process.env } = {}) {
  ensureInitialized(wrapper);
  if (typeof text !== 'string' || text.trim() === '') {
    throw new UsageError('Текст комментария не может быть пустым.', { code: 'empty_comment' });
  }
  assertTextSize(text, 'Комментарий');
  const idemValue = normalizeIdem(idem);
  const eventActor = resolveActor(actor, env);
  const db = unwrapDb(wrapper);

  return transaction(wrapper, () => {
    const issueRow = resolveIssue(wrapper, ref);

    if (idemValue) {
      const existing = findEventByIdem(db, 'comment', idemValue, issueRow.id);
      if (existing) return { ...serializeEvent(existing), deduplicated: true };
    }

    const now = Date.now();
    const event = appendEvent(db, {
      issueId: issueRow.id,
      kind: 'comment',
      data: idemValue ? { text, idem: idemValue } : { text },
      actor: eventActor,
      ts: now,
    });
    db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now, issueRow.id);

    return { ...serializeEvent(event), deduplicated: false };
  });
}

/**
 * Правит поля задачи одной транзакцией. На каждое реально изменённое поле
 * пишется отдельное событие kind=edit с data `{field, from, to}`; все события
 * получают один ts, он же становится issues.updated_at. Пустые изменения
 * (или значения, совпавшие с текущими) не пишут ни строку, ни события.
 *
 * `changes.labels` принимает:
 *  - массив / строку «a,b» — полная замена набора;
 *  - объект `{add: string[], remove: string[]}` — инкрементально (remove
 *    применяется первым, затем add; итог нормализуется: lowercase, sorted).
 *
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{
 *   ref: string|number,
 *   changes?: {title?: string, body?: string, priority?: number|string, labels?: string[]|string|{add?:string[],remove?:string[]}, assignee?: string|null, ref?: string|null, milestone?: string|null},
 *   actor?: string,
 *   env?: NodeJS.ProcessEnv
 * }} input
 * @returns {{issue: object, events: object[]}}
 * @throws {UsageError|NotFoundError|ConflictError}
 */
export function editIssue(wrapper, { ref, changes = {}, actor, env = process.env } = {}) {
  ensureInitialized(wrapper);
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new UsageError('edit: изменения должны быть объектом.', { code: 'invalid_changes' });
  }
  const allowedFields = ['title', 'body', 'priority', 'labels', 'assignee', 'ref', 'milestone'];
  for (const field of Object.keys(changes)) {
    if (!allowedFields.includes(field)) {
      throw new UsageError(
        `edit: неизвестное поле «${field}». Допустимо: ${allowedFields.join(', ')}.`,
        { code: 'invalid_field' },
      );
    }
  }

  const eventActor = resolveActor(actor, env);
  const db = unwrapDb(wrapper);

  return transaction(wrapper, () => {
    const issueRow = resolveIssue(wrapper, ref);
    const current = serializeIssue(issueRow);
    const updates = [];

    if (changes.title !== undefined) {
      const next = normalizeTitle(changes.title);
      if (next !== current.title) updates.push({ field: 'title', from: current.title, to: next });
    }
    if (changes.body !== undefined) {
      const next = normalizeBody(changes.body);
      if (next !== current.body) updates.push({ field: 'body', from: current.body, to: next });
    }
    if (changes.priority !== undefined) {
      const next = normalizePriority(changes.priority);
      if (next !== current.priority) {
        updates.push({ field: 'priority', from: current.priority, to: next });
      }
    }
    if (changes.assignee !== undefined) {
      const next = normalizeOptionalText(changes.assignee, 'Исполнитель');
      if (next !== current.assignee) {
        updates.push({ field: 'assignee', from: current.assignee, to: next });
      }
    }
    if (changes.ref !== undefined) {
      const next = normalizeOptionalText(changes.ref, 'Ссылка');
      if (next !== current.ref) updates.push({ field: 'ref', from: current.ref, to: next });
    }
    if (changes.labels !== undefined) {
      const next = applyLabelChange(current.labels, changes.labels);
      if (!sameStringArray(next, current.labels)) {
        updates.push({ field: 'labels', from: current.labels, to: next });
      }
    }
    if (changes.milestone !== undefined) {
      const attach = resolveMilestoneForIssue(db, current.project, changes.milestone);
      const nextName = attach?.name ?? null;
      if (nextName !== current.milestone) {
        updates.push({
          field: 'milestone',
          column: 'milestone_id',
          from: current.milestone,
          to: nextName,
          value: attach?.id ?? null,
        });
      }
    }

    if (updates.length === 0) {
      return { issue: current, events: [] };
    }

    const ts = Date.now();
    const setSql = updates.map((update) => `${update.column ?? update.field} = ?`).join(', ');
    const values = updates.map((update) =>
      update.value !== undefined
        ? update.value
        : update.field === 'labels'
          ? JSON.stringify(update.to)
          : update.to,
    );
    db.prepare(`UPDATE issues SET ${setSql}, updated_at = ? WHERE id = ?`).run(
      ...values,
      ts,
      issueRow.id,
    );

    const events = updates.map((update) =>
      serializeEvent(
        appendEvent(db, {
          issueId: issueRow.id,
          kind: 'edit',
          data: { field: update.field, from: update.from, to: update.to },
          actor: eventActor,
          ts,
        }),
      ),
    );

    return { issue: serializeIssue(resolveIssue(db, issueRow.id)), events };
  });
}

/**
 * Комбинированное обновление задачи: статус + поля в одной транзакции.
 * На статус пишется одно событие kind=status; на каждое изменённое поле —
 * событие kind=edit. Все события получают один ts, он же становится
 * issues.updated_at. Пустой PATCH (нет изменений) возвращает задачу без событий.
 *
 * `labels` принимает массив / строку «a,b» (полная замена) либо объект
 * `{add, remove}` (инкрементально), как в editIssue.
 *
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{
 *   issueRef: string|number,
 *   status?: string,
 *   title?: string,
 *   body?: string,
 *   priority?: number|string,
 *   labels?: string[]|string|{add?:string[],remove?:string[]},
 *   assignee?: string|null,
 *   ref?: string|null,
 *   milestone?: string|null,
 *   reason?: string|null,
 *   actor?: string,
 *   env?: NodeJS.ProcessEnv
 * }} input
 * @returns {{issue: object, events: object[]}}
 * @throws {UsageError|NotFoundError|ConflictError}
 */
export function updateIssue(wrapper, {
  issueRef,
  status,
  title,
  body,
  priority,
  labels,
  assignee,
  ref,
  milestone,
  reason = null,
  actor,
  env = process.env,
} = {}) {
  ensureInitialized(wrapper);
  const eventActor = resolveActor(actor, env);
  const db = unwrapDb(wrapper);

  return transaction(wrapper, () => {
    const issueRow = resolveIssue(wrapper, issueRef);
    const ts = Date.now();
    const original = serializeIssue(issueRow);
    let current = original;
    const events = [];

    // 1. Статус (если передан и реально меняется).
    if (status !== undefined && status !== null && status !== '') {
      const targetStatus = normalizeStatus(status);
      assertTransitionAllowed(issueRow, targetStatus);
      if (targetStatus !== current.status) {
        const closeReason = normalizeOptionalText(reason, 'Причина');
        const explicitAssignee = assignee === undefined
          ? undefined
          : normalizeOptionalText(assignee, 'Исполнитель');
        let nextAssignee = explicitAssignee === undefined ? current.assignee : explicitAssignee;
        if (targetStatus === 'doing' && (nextAssignee === null || nextAssignee === '')) {
          nextAssignee = eventActor;
        }
        const isClosed = CLOSED_STATUSES.includes(targetStatus);
        const closedAt = isClosed ? ts : null;
        const finalReason = isClosed ? closeReason : null;

        db.prepare(
          `UPDATE issues
           SET status = ?, assignee = ?, updated_at = ?, closed_at = ?, close_reason = ?
           WHERE id = ?`,
        ).run(targetStatus, nextAssignee, ts, closedAt, finalReason, issueRow.id);

        events.push(
          serializeEvent(
            appendEvent(db, {
              issueId: issueRow.id,
              kind: 'status',
              data: { from: current.status, to: targetStatus, reason: finalReason },
              actor: eventActor,
              ts,
            }),
          ),
        );
        current = serializeIssue(resolveIssue(db, issueRow.id));
      }
    }

    // 2. Поля (сравниваем с исходным состоянием до статуса, чтобы явные
    //    изменения фиксировались отдельными событиями kind=edit).
    const edits = [];
    if (title !== undefined) {
      const next = normalizeTitle(title);
      if (next !== original.title) edits.push({ field: 'title', from: original.title, to: next });
    }
    if (body !== undefined) {
      const next = normalizeBody(body);
      if (next !== original.body) edits.push({ field: 'body', from: original.body, to: next });
    }
    if (priority !== undefined) {
      const next = normalizePriority(priority);
      if (next !== original.priority) edits.push({ field: 'priority', from: original.priority, to: next });
    }
    if (assignee !== undefined) {
      const next = normalizeOptionalText(assignee, 'Исполнитель');
      if (next !== original.assignee) edits.push({ field: 'assignee', from: original.assignee, to: next });
    }
    if (ref !== undefined) {
      const next = normalizeOptionalText(ref, 'Ссылка');
      if (next !== original.ref) edits.push({ field: 'ref', from: original.ref, to: next });
    }
    if (labels !== undefined) {
      const next = applyLabelChange(original.labels, labels);
      if (!sameStringArray(next, original.labels)) {
        edits.push({ field: 'labels', from: original.labels, to: next });
      }
    }
    if (milestone !== undefined) {
      const attach = resolveMilestoneForIssue(db, original.project, milestone);
      const nextName = attach?.name ?? null;
      if (nextName !== original.milestone) {
        edits.push({
          field: 'milestone',
          column: 'milestone_id',
          from: original.milestone,
          to: nextName,
          value: attach?.id ?? null,
        });
      }
    }

    if (edits.length > 0) {
      const setSql = edits.map((update) => `${update.column ?? update.field} = ?`).join(', ');
      const values = edits.map((update) =>
        update.value !== undefined
          ? update.value
          : update.field === 'labels'
            ? JSON.stringify(update.to)
            : update.to,
      );
      db.prepare(`UPDATE issues SET ${setSql}, updated_at = ? WHERE id = ?`).run(
        ...values,
        ts,
        issueRow.id,
      );

      for (const update of edits) {
        events.push(
          serializeEvent(
            appendEvent(db, {
              issueId: issueRow.id,
              kind: 'edit',
              data: { field: update.field, from: update.from, to: update.to },
              actor: eventActor,
              ts,
            }),
          ),
        );
      }
      current = serializeIssue(resolveIssue(db, issueRow.id));
    }

    return { issue: current, events };
  });
}

/**
 * Создаёт милстоун в проекте (PLAN §13). События не пишутся: милстоун —
 * атрибут проектного уровня, как и сам проект. Дубль имени (по name_key)
 * в проекте → ConflictError milestone_exists.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{
 *   project?: string|null,
 *   projectKey?: string|null,
 *   name: string,
 *   body?: string,
 *   due?: string|number|null,
 *   dueAt?: string|number|null,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv
 * }} input
 * @returns {object} публичное представление (§3.1), progress нулевой
 * @throws {UsageError|ConflictError|NotFoundError}
 */
export function createMilestone(wrapper, {
  project = null,
  projectKey = null,
  name,
  body = '',
  due = null,
  dueAt = null,
  cwd,
  env = process.env,
} = {}) {
  ensureInitialized(wrapper);
  const milestoneName = normalizeMilestoneName(name);
  const milestoneBody = normalizeBody(body);
  const dueValue = normalizeDueAt(dueAt ?? due);
  const db = unwrapDb(wrapper);

  return transaction(wrapper, () => {
    const projectRow = resolveProject(db, {
      project: projectKey ?? project,
      cwd: cwd ?? process.cwd(),
      env,
    });
    const nameKey = milestoneNameKey(milestoneName);
    const existing = db
      .prepare('SELECT id FROM milestones WHERE project_key = ? AND name_key = ?')
      .get(projectRow.key, nameKey);
    if (existing) {
      throw new ConflictError(
        `Милстоун «${milestoneName}» уже существует в проекте ${projectRow.key}.`,
        { code: 'milestone_exists', hint: 'Посмотреть милстоуны: rat milestone ls' },
      );
    }

    const now = Date.now();
    db.prepare(
      `INSERT INTO milestones(
         project_key, name, name_key, body, due_at, state,
         created_at, updated_at, closed_at, meta
       ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL, '{}')`,
    ).run(projectRow.key, milestoneName, nameKey, milestoneBody, dueValue, now, now);

    return serializeMilestone(
      resolveMilestone(db, { ref: milestoneName, projectKey: projectRow.key }),
    );
  });
}

/**
 * Изменяет имя/описание/срок/состояние милстоуна. Все поля опциональны;
 * отсутствующие не меняются. Пустой вызов возвращает текущее состояние.
 * `clearDue` очищает срок; одновременная передача срока и `clearDue` —
 * UsageError invalid_arguments.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{
 *   ref: string,
 *   project?: string|null,
 *   projectKey?: string|null,
 *   name?: string,
 *   body?: string,
 *   due?: string|number|null,
 *   dueAt?: string|number|null,
 *   clearDue?: boolean,
 *   state?: 'open'|'closed',
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv
 * }} input
 * @returns {object} публичное представление (§3.1)
 * @throws {UsageError|ConflictError|NotFoundError}
 */
export function updateMilestone(wrapper, {
  ref,
  project = null,
  projectKey = null,
  name,
  body,
  due = null,
  dueAt = null,
  clearDue = false,
  state,
  cwd,
  env = process.env,
} = {}) {
  ensureInitialized(wrapper);
  const db = unwrapDb(wrapper);

  return transaction(wrapper, () => {
    const projectRow = resolveProject(db, {
      project: projectKey ?? project,
      cwd: cwd ?? process.cwd(),
      env,
    });
    const currentRow = resolveMilestone(db, { ref, projectKey: projectRow.key });
    const current = serializeMilestone(currentRow);
    const now = Date.now();
    const sets = [];
    const params = [];

    let nextName = current.name;
    if (name !== undefined) {
      nextName = normalizeMilestoneName(name);
      if (nextName !== current.name) {
        const nextKey = milestoneNameKey(nextName);
        const duplicate = db
          .prepare(
            `SELECT id FROM milestones
             WHERE project_key = ? AND name_key = ? AND id <> ?`,
          )
          .get(projectRow.key, nextKey, currentRow.id);
        if (duplicate) {
          throw new ConflictError(
            `Милстоун «${nextName}» уже существует в проекте ${projectRow.key}.`,
            { code: 'milestone_exists', hint: 'Посмотреть милстоуны: rat milestone ls' },
          );
        }
        sets.push('name = ?', 'name_key = ?');
        params.push(nextName, nextKey);
      }
    }

    if (body !== undefined) {
      const nextBody = normalizeBody(body);
      if (nextBody !== current.body) {
        sets.push('body = ?');
        params.push(nextBody);
      }
    }

    const dueGiven = due !== null && due !== undefined;
    const dueAtGiven = dueAt !== null && dueAt !== undefined;
    if (clearDue && (dueGiven || dueAtGiven)) {
      throw new UsageError('Нельзя одновременно задать срок и --clear-due.', {
        code: 'invalid_arguments',
      });
    }

    if (clearDue) {
      if (current.due_at !== null) {
        sets.push('due_at = ?');
        params.push(null);
      }
    } else if (dueAtGiven || dueGiven) {
      const nextDue = normalizeDueAt(dueAtGiven ? dueAt : due);
      if (nextDue !== current.due_at) {
        sets.push('due_at = ?');
        params.push(nextDue);
      }
    }

    if (state !== undefined && state !== null && state !== '') {
      const nextState = String(state).trim().toLowerCase();
      if (!MILESTONE_STATES.includes(nextState)) {
        throw new UsageError(
          `Недопустимое состояние «${state}». Допустимо: ${MILESTONE_STATES.join(', ')}.`,
          { code: 'invalid_state' },
        );
      }
      if (nextState !== current.state) {
        sets.push('state = ?', 'closed_at = ?');
        params.push(nextState, nextState === 'closed' ? now : null);
      }
    }

    if (sets.length === 0) return current;

    sets.push('updated_at = ?');
    params.push(now, currentRow.id);
    db.prepare(`UPDATE milestones SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    return serializeMilestone(
      resolveMilestone(db, { ref: nextName, projectKey: projectRow.key }),
    );
  });
}

/**
 * Архивирует проект (archived_at). Задачи проекта не трогаются: архив только
 * прячет проект из дефолтных списков. Повторная архивация → ConflictError.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{key: string}} input
 * @returns {{key:string,name:string,root_path:string|null,color:string,created_at:number,archived_at:number|null}}
 * @throws {UsageError|NotFoundError|ConflictError}
 */
export function archiveProject(wrapper, { key } = {}) {
  ensureInitialized(wrapper);
  const projectKey = normalizeProjectKey(key);
  const db = unwrapDb(wrapper);

  return transaction(wrapper, () => {
    const project = getProject(db, projectKey);
    if (!project) {
      throw new NotFoundError(`Проект ${projectKey} не найден.`, {
        code: 'project_not_found',
        hint: `Создайте проект: rat project add ${projectKey} --name "..."`,
      });
    }
    if (project.archived_at !== null) {
      throw new ConflictError(`Проект ${projectKey} уже в архиве.`, {
        code: 'project_archived',
      });
    }

    db.prepare('UPDATE projects SET archived_at = ? WHERE key = ?').run(Date.now(), projectKey);
    return getProject(db, projectKey);
  });
}

/**
 * Нормализует метки: массив или строка «a,b» → lowercase, trim, dedup, sorted.
 * @param {string[]|string|null|undefined} value
 * @returns {string[]}
 * @throws {UsageError}
 */
export function normalizeLabels(value) {
  if (value === null || value === undefined) return [];
  let items;
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = [value];
  else {
    throw new UsageError('Метки: ожидается массив или строка «a,b».', { code: 'invalid_labels' });
  }

  const result = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== 'string') {
      throw new UsageError('Метки должны быть строками.', { code: 'invalid_labels' });
    }
    for (const part of item.split(',')) {
      const label = part.trim().toLowerCase();
      if (label === '' || seen.has(label)) continue;
      seen.add(label);
      result.push(label);
    }
  }
  result.sort();
  return result;
}

/**
 * Применяет labels-изменение к текущему набору: полная замена либо {add,remove}.
 * @param {string[]} current
 * @param {string[]|string|{add?:string[],remove?:string[]}} value
 * @returns {string[]}
 * @throws {UsageError}
 */
function applyLabelChange(current, value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const allowed = ['add', 'remove'];
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        throw new UsageError(`labels: неизвестный ключ «${key}». Допустимо: add, remove.`, {
          code: 'invalid_labels',
        });
      }
    }
    const toRemove = new Set(normalizeLabels(value.remove ?? []));
    const toAdd = normalizeLabels(value.add ?? []);
    const merged = current.filter((label) => !toRemove.has(label));
    for (const label of toAdd) {
      if (!merged.includes(label)) merged.push(label);
    }
    merged.sort();
    return merged;
  }
  return normalizeLabels(value);
}

function sameStringArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ---------------------------------------------------------------------------
// Внутренние помощники M1

function ensureInitialized(wrapper) {
  ensureSchemaCurrent(wrapper);
}

function findEventByIdem(db, kind, idem, issueId = null) {
  const scope = issueId === null || issueId === undefined ? '' : 'AND e.issue_id = ?';
  const params = issueId === null || issueId === undefined ? [kind, idem] : [kind, idem, issueId];
  return db
    .prepare(
      `SELECT e.id, e.issue_id, e.ts, e.actor, e.kind, e.data, i.project_key, i.num
       FROM events e
       JOIN issues i ON i.id = e.issue_id
       WHERE e.kind = ?
         AND CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.idem') END = ?
         ${scope}
       ORDER BY e.id ASC
       LIMIT 1`,
    )
    .get(...params);
}

function assertTransitionAllowed(issueRow, targetStatus) {
  const fromStatus = issueRow.status;
  if (!CLOSED_STATUSES.includes(fromStatus)) return;
  if (targetStatus === 'open') return;
  const publicId = formatIssueId(issueRow);
  throw new ConflictError(
    `Задача ${publicId} закрыта (${fromStatus}); смена статуса доступна только через reopen.`,
    { code: 'issue_closed', hint: `rat reopen ${publicId}` },
  );
}

function normalizeTitle(value) {
  const title = requireNonEmptyString(value, 'Заголовок');
  assertTextSize(title, 'Заголовок');
  return title;
}

function normalizeBody(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') {
    throw new UsageError('Тело задачи должно быть строкой.', { code: 'invalid_body' });
  }
  assertTextSize(value, 'Тело задачи');
  return value;
}

function normalizeStatus(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError('Статус должен быть строкой.', { code: 'invalid_status' });
  }
  const status = value.trim().toLowerCase();
  if (!ISSUE_STATUSES.includes(status)) {
    throw new UsageError(
      `Недопустимый статус «${value}». Допустимо: ${ISSUE_STATUSES.join(', ')}.`,
      { code: 'invalid_status' },
    );
  }
  return status;
}

function normalizePriority(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_PRIORITY;
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
    throw new UsageError('Приоритет: ожидается целое число 0..3.', { code: 'invalid_priority' });
  }
  return priority;
}

function normalizeOptionalText(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new UsageError(`${field}: ожидается строка.`, { code: 'invalid_text' });
  }
  const text = value.trim();
  return text === '' ? null : text;
}

/**
 * 'YYYY-MM-DD' → 00:00 UTC epoch ms; число → как есть; null → null.
 * @param {unknown} value
 * @returns {number|null}
 * @throws {UsageError} invalid_due
 */
function normalizeDueAt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new UsageError('Срок: ожидается дата YYYY-MM-DD.', { code: 'invalid_due' });
    }
    return Math.trunc(value);
  }
  if (typeof value !== 'string') {
    throw new UsageError('Срок: ожидается дата YYYY-MM-DD.', { code: 'invalid_due' });
  }
  const text = value.trim();
  if (text === '') return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new UsageError(`Срок «${value}»: ожидается дата YYYY-MM-DD.`, {
      code: 'invalid_due',
    });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ts = Date.UTC(year, month - 1, day);
  const date = new Date(ts);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new UsageError(`Срок «${value}»: такой даты не существует.`, {
      code: 'invalid_due',
    });
  }
  return ts;
}

/**
 * Привязка для задачи: значение `milestone` → {id, name} или null.
 * null/''/'-'/'none' — отвязка. Имя ищется только в проекте задачи.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} projectKey
 * @param {unknown} value
 * @returns {{id:number, name:string}|null}
 * @throws {UsageError} invalid_milestone
 * @throws {ConflictError} milestone_closed
 */
function resolveMilestoneForIssue(db, projectKey, value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new UsageError('Милстоун: ожидается имя, «-» или «none».', {
      code: 'invalid_milestone',
      hint: 'Посмотреть милстоуны: rat milestone ls',
    });
  }
  const text = value.trim();
  const key = milestoneNameKey(text);
  if (key === '' || key === '-' || key === 'none') return null;

  const row = db
    .prepare('SELECT id, name, state FROM milestones WHERE project_key = ? AND name_key = ?')
    .get(projectKey, key);
  if (!row) {
    throw new UsageError(`Милстоун «${text}» не найден в проекте ${projectKey}.`, {
      code: 'invalid_milestone',
      hint: 'Посмотреть милстоуны: rat milestone ls',
    });
  }
  if (row.state !== 'open') {
    throw new ConflictError(`Милстоун «${row.name}» закрыт — назначить его нельзя.`, {
      code: 'milestone_closed',
      hint: 'Открыть милстоун: rat milestone reopen',
    });
  }
  return { id: Number(row.id), name: row.name };
}

function normalizeIdem(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new UsageError('--idem: ожидается строка (uuid).', { code: 'invalid_idem' });
  }
  const idem = value.trim();
  if (idem === '') return null;
  if (idem.length > 200) {
    throw new UsageError('--idem: строка длиннее 200 символов.', { code: 'invalid_idem' });
  }
  return idem;
}

function normalizeEventLimit(value) {
  if (value === null || value === undefined) return 20;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) {
    throw new UsageError('--events: ожидается целое число 0..10000.', { code: 'invalid_limit' });
  }
  return limit;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`${field} не может быть пустым.`, { code: 'required_field' });
  }
  return value.trim();
}

function assertTextSize(value, field) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_TEXT_BYTES) {
    throw new UsageError(`${field}: ${bytes} байт, максимум ${MAX_TEXT_BYTES}.`, {
      code: 'text_too_large',
    });
  }
}

function normalizeRootPath(value, cwd) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new UsageError('--path: ожидается строка.', { code: 'invalid_path' });
  }
  const raw = value.trim();
  if (raw === '') return null;
  return path.resolve(cwd, raw);
}

function normalizeColor(value) {
  if (value === null || value === undefined) return 'zinc';
  if (typeof value !== 'string') {
    throw new UsageError('--color: ожидается строка.', { code: 'invalid_color' });
  }
  const color = value.trim();
  return color === '' ? 'zinc' : color;
}

function projectKeyOf(project) {
  if (project === null || project === undefined) return null;
  if (typeof project === 'object' && typeof project.key === 'string') return project.key;
  return String(project);
}

function writeMetaValue(db, key, value) {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

/**
 * Диагностика базы: версия схемы, journal_mode, FTS5, целостность
 * (сиротские задачи, битый JSON в labels/meta/events.data), права на запись.
 * @param {{db: import('node:sqlite').DatabaseSync, path?: string, hasFts5?: boolean}} wrapper
 * @returns {{
 *   ok: boolean,
 *   path: string|null,
 *   schemaVersion: number|null,
 *   journalMode: string|null,
 *   hasFts5: boolean,
 *   counts: {projects:number, issues:number, events:number},
 *   checks: Array<{id:string, ok:boolean, message:string, details?: object}>
 * }}
 */
export function doctor(wrapper) {
  const db = unwrapDb(wrapper);
  const checks = [];
  const counts = { projects: 0, issues: 0, events: 0 };

  const schemaVersion = getSchemaVersion(wrapper);
  const requiredTables = ['meta', 'projects', 'issues', 'events'];
  const missingTables = requiredTables.filter((name) => {
    try {
      return !tableExists(db, name);
    } catch {
      return true;
    }
  });
  const initialized = schemaVersion > 0 && missingTables.length === 0;

  if (!initialized) {
    checks.push({
      id: 'schema',
      ok: false,
      message:
        schemaVersion === 0
          ? 'Схема не инициализирована — выполните rat init'
          : `Отсутствуют таблицы: ${missingTables.join(', ')}`,
      details: { schemaVersion, missingTables },
    });
  } else if (schemaVersion > SCHEMA_VERSION) {
    checks.push({
      id: 'schema',
      ok: false,
      message: `Версия схемы ${schemaVersion} новее поддерживаемой ${SCHEMA_VERSION}`,
      details: { schemaVersion, supportedVersion: SCHEMA_VERSION },
    });
  } else if (schemaVersion < SCHEMA_VERSION) {
    checks.push({
      id: 'schema',
      ok: false,
      message: `Схема v${schemaVersion} устарела — нужна v${SCHEMA_VERSION}; выполните rat init`,
      details: { schemaVersion, supportedVersion: SCHEMA_VERSION },
    });
  } else {
    checks.push({ id: 'schema', ok: true, message: `Схема v${schemaVersion}` });
  }

  let journalMode = null;
  try {
    journalMode = db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? null;
  } catch (err) {
    journalMode = null;
    checks.push({
      id: 'journal_mode',
      ok: false,
      message: `Не удалось прочитать journal_mode: ${err?.message ?? err}`,
    });
  }
  if (journalMode !== null) {
    const isMemory = wrapper?.path === ':memory:';
    checks.push({
      id: 'journal_mode',
      ok: journalMode === 'wal' || isMemory,
      message:
        journalMode === 'wal'
          ? 'journal_mode=WAL'
          : isMemory
            ? 'journal_mode=memory (in-memory база)'
            : `journal_mode=${journalMode} — ожидается WAL`,
    });
  }

  const ftsTablePresent = safeTableExists(db, 'issues_fts');
  const ftsTriggers = ['issues_fts_ai', 'issues_fts_ad', 'issues_fts_au'].filter((name) =>
    safeTriggerExists(db, name),
  );
  if (!ftsTablePresent) {
    if (wrapper?.hasFts5 !== false) {
      checks.push({
        id: 'fts5',
        ok: false,
        message: 'FTS5 доступен, но issues_fts не создана — выполните rat init',
      });
    } else {
      checks.push({
        id: 'fts5',
        ok: true,
        message: 'FTS5 недоступен в этой сборке — поиск через LIKE',
      });
    }
  } else {
    const ok = ftsTriggers.length === 3;
    checks.push({
      id: 'fts5',
      ok,
      message: ok
        ? 'FTS5: issues_fts + 3 триггера'
        : `FTS5: issues_fts есть, но триггеров ${ftsTriggers.length}/3`,
      ...(ok ? {} : { details: { triggers: ftsTriggers } }),
    });
  }

  const milestonesTable = safeTableExists(db, 'milestones');
  if (!milestonesTable) {
    checks.push({
      id: 'milestones',
      ok: false,
      message: 'Нет таблицы milestones — выполните rat init',
    });
  } else if (!columnExists(db, 'issues', 'milestone_id')) {
    checks.push({
      id: 'milestones',
      ok: false,
      message: 'В таблице issues нет колонки milestone_id — выполните rat init',
    });
  } else {
    try {
      const total = Number(db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n);
      const open = Number(
        db.prepare("SELECT COUNT(*) AS n FROM milestones WHERE state = 'open'").get().n,
      );
      checks.push({
        id: 'milestones',
        ok: true,
        message: `Милстоуны: ${total} (open ${open})`,
      });
    } catch (err) {
      checks.push({
        id: 'milestones',
        ok: false,
        message: `Не удалось проверить милстоуны: ${err?.message ?? err}`,
      });
    }
  }

  if (initialized) {
    try {
      const orphanIssues = db
        .prepare(
          `SELECT i.project_key, i.num
           FROM issues i
           LEFT JOIN projects p ON p.key = i.project_key
           WHERE p.key IS NULL`,
        )
        .all();
      const brokenJson = findBrokenJson(db);
      const ok = orphanIssues.length === 0 && brokenJson.length === 0;
      const parts = [];
      if (orphanIssues.length) parts.push(`задач без проекта: ${orphanIssues.length}`);
      if (brokenJson.length) parts.push(`записей с битым JSON: ${brokenJson.length}`);
      checks.push({
        id: 'integrity',
        ok,
        message: ok ? 'Целостность: нарушений нет' : `Целостность: ${parts.join('; ')}`,
        details: {
          orphan_count: orphanIssues.length,
          orphan_issues: orphanIssues.slice(0, 10).map(toPublicIssue),
          broken_json_count: brokenJson.length,
          broken_json: brokenJson.slice(0, 10),
        },
      });
    } catch (err) {
      checks.push({
        id: 'integrity',
        ok: false,
        message: `Не удалось проверить целостность: ${err?.message ?? err}`,
      });
    }
  }

  checks.push(checkWriteAccess(db));

  try {
    counts.projects = countRows(db, 'projects');
    counts.issues = countRows(db, 'issues');
    counts.events = countRows(db, 'events');
  } catch {
    // таблиц может не быть — оставляем нули
  }

  return {
    ok: checks.every((check) => check.ok),
    path: wrapper?.path ?? null,
    schemaVersion: schemaVersion > 0 ? schemaVersion : null,
    journalMode,
    hasFts5: Boolean(wrapper?.hasFts5),
    counts,
    checks,
  };
}

// ---------------------------------------------------------------------------

function findBrokenJson(db) {
  const broken = [];

  for (const row of db.prepare('SELECT project_key, num, labels, meta FROM issues').all()) {
    for (const field of ['labels', 'meta']) {
      const problem = jsonProblem(row[field], field === 'labels' ? 'array' : 'object');
      if (problem) {
        broken.push({
          table: 'issues',
          public_id: `${row.project_key}-${Number(row.num)}`,
          field,
          problem,
          value: preview(row[field]),
        });
      }
    }
  }

  const events = db
    .prepare(
      `SELECT e.id AS event_id, e.data, i.project_key, i.num
       FROM events e
       LEFT JOIN issues i ON i.id = e.issue_id`,
    )
    .all();
  for (const row of events) {
    const problem = jsonProblem(row.data, 'object');
    if (problem) {
      broken.push({
        table: 'events',
        event_id: Number(row.event_id),
        public_id: row.project_key ? `${row.project_key}-${Number(row.num)}` : null,
        field: 'data',
        problem,
        value: preview(row.data),
      });
    }
  }

  return broken;
}

function checkWriteAccess(db) {
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO meta(key, value) VALUES ('__rat_doctor_probe', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(Date.now()));
      db.exec('ROLLBACK');
      return { id: 'write', ok: true, message: 'Запись в базу доступна' };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // транзакция уже откатилась
      }
      return {
        id: 'write',
        ok: false,
        message: `Запись недоступна: ${err?.message ?? err}`,
      };
    }
  } catch (err) {
    return {
      id: 'write',
      ok: false,
      message: `Запись недоступна: ${err?.message ?? err}`,
    };
  }
}

function jsonProblem(raw, expected) {
  if (typeof raw !== 'string') return 'значение не является строкой';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'не разбирается как JSON';
  }
  if (expected === 'array') {
    return Array.isArray(parsed) ? null : 'ожидался JSON-массив';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'ожидался JSON-объект';
  }
  return null;
}

function safeTableExists(db, name) {
  try {
    return tableExists(db, name);
  } catch {
    return false;
  }
}

/** Колонка таблицы через PRAGMA table_info (локально, без экспорта из db.mjs). */
function columnExists(db, table, column) {
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((row) => row.name === column);
  } catch {
    return false;
  }
}

function safeTriggerExists(db, name) {
  try {
    return Boolean(
      db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name),
    );
  } catch {
    return false;
  }
}

function countRows(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}

function toPublicIssue(row) {
  return {
    project_key: row.project_key,
    num: Number(row.num),
    public_id: `${row.project_key}-${Number(row.num)}`,
  };
}

function preview(value, max = 120) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
