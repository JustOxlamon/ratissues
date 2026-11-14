import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DbError, ensureSchemaCurrent, NotFoundError, REPO_ROOT, unwrapDb, UsageError } from './db.mjs';
import { listEvents } from './events.mjs';
import {
  ACTIVE_STATUSES,
  getProject,
  ISSUE_SELECT,
  ISSUE_STATUSES,
  listMilestones,
  listProjects,
  normalizeProjectKey,
  resolveProject,
  serializeEvent,
  serializeIssue,
} from './query.mjs';

/*
 * export.mjs — только чтение. Экспорт никогда не пишет в базу: задачи берутся
 * через query.mjs (ISSUE_SELECT/serializeIssue), события — через events.listEvents
 * либо read-only JOIN. Записывается только файл-снапшот (writeExportFile).
 */

/** Поддерживаемые форматы экспорта. */
export const EXPORT_FORMATS = Object.freeze(['md', 'jsonl']);

/** Каталог снапшотов: всегда от корня репозитория, а не от cwd. */
export const EXPORTS_DIR = path.join(REPO_ROOT, 'exports');

/** В md показываем последние N событий каждой задачи (PLAN §8). */
export const MAX_EVENTS_PER_ISSUE = 10;

const COMMENT_PREVIEW_CHARS = 200;

/**
 * Полный прогон экспорта: контент + счётчики для `--json`.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{
 *   format?: 'md'|'jsonl',
 *   project?: string|null,
 *   all?: boolean,
 *   events?: boolean,
 *   limit?: number|string|null,
 *   now?: number,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv
 * }} [options]
 * @returns {{format:'md'|'jsonl', content:string, projects:number, issues:number, events:number}}
 * @throws {UsageError|NotFoundError|DbError}
 */
export function buildExport(wrapper, {
  format = 'md',
  project = null,
  all = false,
  events = false,
  limit = null,
  // now намеренно не влияет на вывод: снапшот должен диффаться в git без шума.
  now: _now = Date.now(),
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const exportFormat = normalizeFormat(format);
  if (events && exportFormat !== 'jsonl') {
    throw new UsageError('--events доступен только с --format jsonl.', {
      code: 'invalid_arguments',
      hint: 'rat export --format jsonl --events --out -',
    });
  }
  ensureSchemaCurrent(wrapper);
  const normalizedLimit = normalizeLimit(limit);
  const scope = resolveScope(wrapper, {
    project,
    all,
    mode: exportFormat,
    cwd,
    env,
  });

  const result = exportFormat === 'md'
    ? buildMarkdown(wrapper, scope)
    : buildJsonl(wrapper, scope, { events: Boolean(events), limit: normalizedLimit });

  return { format: exportFormat, ...result };
}

/**
 * Markdown-снапшот проекта (или всех проектов при all=true).
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{project?: string|null, all?: boolean, now?: number, cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 * @throws {UsageError|NotFoundError|DbError}
 */
export function exportMarkdown(wrapper, options = {}) {
  return buildExport(wrapper, { ...options, format: 'md', events: false, limit: null }).content;
}

/**
 * JSONL-снапшот: строка на задачу либо (events=true) на событие.
 * Порядок записей стабилен: задачи — project ASC, num ASC; события —
 * ts ASC, id ASC. Непустой вывод всегда заканчивается переводом строки.
 * @param {{db: import('node:sqlite').DatabaseSync}} wrapper
 * @param {{project?: string|null, all?: boolean, events?: boolean, limit?: number|string|null, cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 * @throws {UsageError|NotFoundError|DbError}
 */
export function exportJsonl(wrapper, options = {}) {
  return buildExport(wrapper, { ...options, format: 'jsonl' }).content;
}

/**
 * Путь снапшота по умолчанию (всегда внутри EXPORTS_DIR, то есть от корня
 * репозитория). md — `exports/<KEY>.md`, для --all — `exports/all.md`;
 * jsonl — `exports/<KEY>.jsonl` для проекта, иначе `exports/all.jsonl`.
 * @param {{format?: 'md'|'jsonl', projectKey?: string|null, all?: boolean}} [options]
 * @returns {string} абсолютный путь
 * @throws {UsageError} для md без проекта и без --all
 */
export function defaultExportPath({ format = 'md', projectKey = null, all = false } = {}) {
  const exportFormat = normalizeFormat(format);
  const key = projectKey === null || projectKey === undefined || String(projectKey).trim() === ''
    ? null
    : normalizeProjectKey(String(projectKey));

  if (exportFormat === 'md') {
    if (all) return path.join(EXPORTS_DIR, 'all.md');
    if (key === null) {
      throw new UsageError('Для md-экспорта нужен проект или --all.', {
        code: 'invalid_arguments',
        hint: 'rat export [project] или rat export --all',
      });
    }
    return path.join(EXPORTS_DIR, `${key}.md`);
  }

  if (all || key === null) return path.join(EXPORTS_DIR, 'all.jsonl');
  return path.join(EXPORTS_DIR, `${key}.jsonl`);
}

/**
 * Пишет снапшот: создаёт каталог, пишет во временный файл и переименовывает
 * (атомарная замена на POSIX и Windows). `-` обрабатывает CLI как stdout.
 * @param {string} filePath
 * @param {string} content
 * @returns {{path:string, bytes:number}}
 * @throws {UsageError|DbError}
 */
export function writeExportFile(filePath, content) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new UsageError('Не задан путь для экспорта.', { code: 'invalid_path' });
  }
  if (filePath === '-') {
    throw new UsageError('«-» означает stdout — его обрабатывает CLI.', { code: 'invalid_path' });
  }

  const target = path.resolve(filePath);
  const text = String(content ?? '');
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // временный файл мог не создаться — не мешает основной ошибке
    }
    throw new DbError(`Не удалось записать экспорт в «${target}»: ${err?.message ?? err}`, {
      code: 'export_write_failed',
      cause: err,
      hint: 'Проверьте права на каталог и свободное место.',
    });
  }

  return { path: target, bytes: Buffer.byteLength(text, 'utf8') };
}

// ---------------------------------------------------------------------------
// Markdown

function buildMarkdown(wrapper, scope) {
  const db = unwrapDb(wrapper);
  const sections = [];
  let issues = 0;
  let events = 0;

  for (const project of scope.projects) {
    const active = db
      .prepare(
        `${ISSUE_SELECT}
         WHERE i.project_key = ? AND i.status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})
         ORDER BY i.priority ASC, i.updated_at ASC, i.id ASC`,
      )
      .all(project.key, ...ACTIVE_STATUSES);
    const deferred = db
      .prepare(
        `${ISSUE_SELECT}
         WHERE i.project_key = ? AND i.status = 'deferred'
         ORDER BY i.updated_at ASC, i.id ASC`,
      )
      .all(project.key);
    const closed = db
      .prepare(
        `${ISSUE_SELECT}
         WHERE i.project_key = ? AND i.status IN ('done', 'cancelled')
         ORDER BY COALESCE(i.closed_at, i.updated_at) DESC, i.id DESC`,
      )
      .all(project.key);

    issues += active.length + deferred.length + closed.length;
    const rendered = renderProject(wrapper, project, active, deferred, closed);
    events += rendered.events;
    sections.push(rendered.content);
  }

  const body = sections.length === 0
    ? '# Экспорт\n\n_Проектов нет._'
    : sections.join('\n\n');

  return {
    content: `${body}\n`,
    projects: scope.projects.length,
    issues,
    events,
  };
}

function renderProject(wrapper, project, activeRows, deferredRows, closedRows) {
  const counts = Object.fromEntries(ISSUE_STATUSES.map((status) => [status, 0]));
  for (const row of [...activeRows, ...deferredRows, ...closedRows]) {
    if (Object.hasOwn(counts, row.status)) counts[row.status] += 1;
  }
  const total = activeRows.length + deferredRows.length + closedRows.length;
  const archived = project.archived_at === null || project.archived_at === undefined ? '' : ' (архив)';
  const summary = `Сводка: всего ${total} · ${ISSUE_STATUSES.map(
    (status) => `${status} ${counts[status]}`,
  ).join(' · ')}`;

  const openSection = renderSection(wrapper, '## Открытые', activeRows);
  const deferredSection = renderSection(wrapper, '## Отложенные', deferredRows);
  const closedSection = renderSection(wrapper, '## Закрытые', closedRows);
  const milestonesSection = renderMilestones(wrapper, project);

  return {
    content: [
      `# ${project.key} — ${project.name}${archived}`,
      summary,
      ...(milestonesSection === null ? [] : [milestonesSection]),
      openSection.content,
      deferredSection.content,
      closedSection.content,
    ].join('\n\n'),
    events: openSection.events + deferredSection.events + closedSection.events,
  };
}

function renderMilestones(wrapper, project) {
  const milestones = listMilestones(wrapper, { project: project.key, state: 'all' });
  if (milestones.length === 0) return null;

  const lines = ['## Милстоуны'];
  for (const milestone of milestones) {
    const { progress } = milestone;
    const due = milestone.due_at === null ? '' : ` · до ${formatDate(milestone.due_at)}`;
    lines.push(
      `- **${milestone.name}** · ${milestone.state} · ${progress.done}/${progress.total} (${progress.percent}%)${due}`,
    );
  }
  return lines.join('\n');
}

function renderSection(wrapper, title, rows) {
  const parts = [title];
  let events = 0;

  if (rows.length === 0) {
    parts.push('_Задач нет._');
  } else {
    for (const row of rows) {
      const rendered = renderIssue(wrapper, row);
      events += rendered.events;
      parts.push(rendered.content);
    }
  }

  return { content: parts.join('\n\n'), events };
}

function renderIssue(wrapper, row) {
  const issue = serializeIssue(row);
  const parts = [`### ${issue.id} · ${issue.title}`, renderMeta(issue)];

  if (issue.body.trim() !== '') parts.push(issue.body.replace(/\n+$/, ''));

  const eventRows = listEvents(wrapper, { issueId: row.id, limit: MAX_EVENTS_PER_ISSUE });
  if (eventRows.length > 0) {
    parts.push(
      [`События (последние ${eventRows.length}):`, ...eventRows.map(renderEvent)].join('\n'),
    );
  }

  return { content: parts.join('\n\n'), events: eventRows.length };
}

function renderMeta(issue) {
  const fields = [
    `\`${issue.status}\``,
    `p${issue.priority}`,
    `метки: ${issue.labels.length ? issue.labels.join(', ') : '—'}`,
    `исполнитель: ${issue.assignee ?? '—'}`,
    `ref: ${issue.ref ?? '—'}`,
    `милстоун: ${issue.milestone ?? '—'}`,
    `создана: ${formatTs(issue.created_at)}`,
    `обновлена: ${formatTs(issue.updated_at)}`,
  ];
  if (issue.closed_at !== null) fields.push(`закрыта: ${formatTs(issue.closed_at)}`);
  if (issue.close_reason) fields.push(`причина: ${oneLine(issue.close_reason)}`);
  return fields.join(' · ');
}

function renderEvent(event) {
  return `- ${formatTs(event.ts)} ${event.kind} ${event.actor}: ${describeEvent(event)}`;
}

function describeEvent(event) {
  const data = event.data ?? {};
  switch (event.kind) {
    case 'created':
      return 'создана';
    case 'status': {
      const reason = data.reason ? ` (${oneLine(String(data.reason))})` : '';
      return `${data.from ?? '?'} → ${data.to ?? '?'}${reason}`;
    }
    case 'claim':
      return `взята в работу: ${data.assignee ?? event.actor}`;
    case 'comment':
      return truncate(oneLine(String(data.text ?? '')), COMMENT_PREVIEW_CHARS);
    case 'edit':
      if (!data.field) return 'правка';
      return `правка ${data.field}: ${oneLine(String(data.from ?? '—'))} → ${oneLine(
        String(data.to ?? '—'),
      )}`;
    case 'link':
      return `связь: ${oneLine(String(data.ref ?? data.url ?? JSON.stringify(data)))}`;
    default:
      return oneLine(JSON.stringify(data));
  }
}

// ---------------------------------------------------------------------------
// JSONL

function buildJsonl(wrapper, scope, { events, limit }) {
  const db = unwrapDb(wrapper);
  const projectKeys = scope.projects.map((project) => project.key);

  if (projectKeys.length === 0) {
    return { content: '', projects: 0, issues: 0, events: 0 };
  }

  const placeholders = projectKeys.map(() => '?').join(', ');
  const lines = [];

  if (events) {
    const rows = db
      .prepare(
        `SELECT e.id, e.issue_id, e.ts, e.actor, e.kind, e.data, i.project_key, i.num
         FROM events e
         JOIN issues i ON i.id = e.issue_id
         WHERE i.project_key IN (${placeholders})
         ORDER BY e.ts ASC, e.id ASC${limit === null ? '' : ' LIMIT ?'}`,
      )
      .all(...projectKeys, ...(limit === null ? [] : [limit]));
    for (const row of rows) lines.push(JSON.stringify(serializeEvent(row)));
    return {
      content: lines.length ? `${lines.join('\n')}\n` : '',
      projects: projectKeys.length,
      issues: 0,
      events: lines.length,
    };
  }

  const rows = db
    .prepare(
      `${ISSUE_SELECT}
       WHERE i.project_key IN (${placeholders})
       ORDER BY i.project_key ASC, i.num ASC${limit === null ? '' : ' LIMIT ?'}`,
    )
    .all(...projectKeys, ...(limit === null ? [] : [limit]));
  for (const row of rows) lines.push(JSON.stringify(serializeIssue(row)));

  return {
    content: lines.length ? `${lines.join('\n')}\n` : '',
    projects: projectKeys.length,
    issues: lines.length,
    events: 0,
  };
}

// ---------------------------------------------------------------------------
// Общие помощники

function resolveScope(wrapper, { project, all, mode, cwd, env }) {
  const includeAll = Boolean(all);
  const hasProject = project !== null && project !== undefined && String(project).trim() !== '';

  if (includeAll && hasProject) {
    throw new UsageError('Нельзя сочетать проект и --all.', {
      code: 'invalid_arguments',
      hint: 'rat export [project] или rat export --all',
    });
  }

  if (hasProject) {
    const key = normalizeProjectKey(String(project));
    const row = getProject(wrapper, key);
    if (!row) {
      throw new NotFoundError(`Проект ${key} не найден.`, {
        code: 'project_not_found',
        hint: `Создайте проект: rat project add ${key} --name "..."`,
      });
    }
    return { projects: [row] };
  }

  if (includeAll) return { projects: listProjects(wrapper, { includeArchived: true }) };

  // jsonl по умолчанию — снапшот всей базы (PLAN §8: exports/all.jsonl),
  // архивные проекты добавляет только явный --all.
  if (mode === 'jsonl') return { projects: listProjects(wrapper, { includeArchived: false }) };

  try {
    return { projects: [resolveProject(wrapper, { cwd, env })] };
  } catch (err) {
    if (err?.code === 'project_not_found') {
      const projects = listProjects(wrapper, { includeArchived: true });
      if (projects.length === 0) return { projects: [] };
    }
    throw err;
  }
}

/**
 * Нормализует формат экспорта.
 * @param {string|null|undefined} value
 * @returns {'md'|'jsonl'}
 * @throws {UsageError}
 */
export function normalizeFormat(value) {
  const format = value === null || value === undefined || value === ''
    ? 'md'
    : String(value).trim().toLowerCase();
  if (!EXPORT_FORMATS.includes(format)) {
    throw new UsageError(`Неизвестный формат экспорта «${value}». Допустимо: md, jsonl.`, {
      code: 'invalid_format',
    });
  }
  return format;
}

function normalizeLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) {
    throw new UsageError('--limit: ожидается целое число 1..1000000.', { code: 'invalid_limit' });
  }
  return limit;
}

/** epoch ms → «YYYY-MM-DD HH:MM» (UTC, без зависимости от локали). */
function formatTs(ts) {
  if (ts === null || ts === undefined || !Number.isFinite(Number(ts))) return '—';
  const iso = new Date(Number(ts)).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** epoch ms → «YYYY-MM-DD» (UTC): сроки милстоунов показываем без времени. */
function formatDate(ts) {
  return formatTs(ts).slice(0, 10);
}

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
