import path from 'node:path';

import { REPO_ROOT, UsageError } from '../../core/db.mjs';
import { buildExport, defaultExportPath, writeExportFile } from '../../core/export.mjs';
import { resolveProject } from '../../core/query.mjs';
import { parseArgs } from '../args.mjs';

export const meta = {
  name: 'export',
  summary: 'снапшот задач в md/jsonl (для чтения, грепа и git)',
  usage:
    'rat export [project] [--format md|jsonl] [--out FILE|-] [--events] [--all] ' +
    '[--limit N] [--json]',
};

/**
 * `rat export` — снапшот для человека (md) или для контекста LLM (jsonl).
 * Без --out пишет в exports/ от корня репозитория; `--out -` печатает ровно
 * экспорт в stdout (никаких баннеров).
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  const { flags, positionals } = parseArgs(ctx.args, {
    values: ['format', 'out', 'limit'],
    booleans: ['events', 'all'],
    hint: meta.usage,
  });

  if (positionals.length > 1) {
    throw new UsageError('export: можно указать не более одного проекта.', {
      code: 'invalid_arguments',
      hint: meta.usage,
    });
  }
  if (flags.all && positionals.length) {
    throw new UsageError('export: --all несовместим с явным проектом.', {
      code: 'invalid_arguments',
      hint: meta.usage,
    });
  }

  const format = normalizeFormatFlag(flags.format);
  const withEvents = Boolean(flags.events);
  if (withEvents && format !== 'jsonl') {
    throw new UsageError('export: --events доступен только с --format jsonl.', {
      code: 'invalid_arguments',
      hint: 'rat export --format jsonl --events --out -',
    });
  }
  if (flags.out === '-' && ctx.flags.json) {
    throw new UsageError('export: --json несовместим с --out - (stdout занят снапшотом).', {
      code: 'invalid_arguments',
      hint: 'Уберите --json или пишите снапшот в файл.',
    });
  }

  const wrapper = ctx.openDatabase();
  let projectKey = positionals[0] ?? null;

  // md без проекта — это exports/<KEY>.md, поэтому KEY надо определить заранее.
  if (format === 'md' && !flags.all && projectKey === null) {
    projectKey = resolveProject(wrapper, { cwd: ctx.cwd, env: ctx.env }).key;
  }

  const report = buildExport(wrapper, {
    format,
    project: projectKey,
    all: Boolean(flags.all),
    events: withEvents,
    limit: flags.limit ?? null,
    cwd: ctx.cwd,
    env: ctx.env,
  });

  if (flags.out === '-') {
    // Ровно контент: без заголовков, без перевода строки сверху.
    ctx.io.stdout.write(report.content);
    return 0;
  }

  const target = flags.out
    ? path.resolve(ctx.cwd, flags.out)
    : defaultExportPath({ format, projectKey, all: Boolean(flags.all) });
  const written = writeExportFile(target, report.content);

  if (ctx.flags.json) {
    ctx.printJson({
      path: written.path,
      format: report.format,
      bytes: written.bytes,
      projects: report.projects,
      issues: report.issues,
      events: report.events,
      canon: report.canon,
    });
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(written.path);
    return 0;
  }

  ctx.print(`Экспорт: ${displayPath(written.path)} (${formatBytes(written.bytes)})`);
  return 0;
}

function normalizeFormatFlag(value) {
  if (value === undefined) return 'md';
  const format = String(value).trim().toLowerCase();
  if (format !== 'md' && format !== 'jsonl') {
    throw new UsageError(`export: неизвестный формат «${value}». Допустимо: md, jsonl.`, {
      code: 'invalid_format',
      hint: meta.usage,
    });
  }
  return format;
}

/** Путь в сообщении: относительно корня репозитория, если он внутри него. */
function displayPath(absolute) {
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return absolute;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  const kb = bytes / 1024;
  return `${kb >= 100 ? kb.toFixed(0) : kb.toFixed(1)} КБ`;
}
