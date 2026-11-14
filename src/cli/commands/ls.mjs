import { resolveProject, searchIssues } from '../../core/query.mjs';
import { UsageError } from '../../core/db.mjs';
import { parseArgs } from '../args.mjs';
import { formatAge, paint, STATUS_COLORS, useColor } from '../ui.mjs';

export const meta = {
  name: 'ls',
  summary: 'список задач с фильтрами',
  usage:
    'rat ls [project] [-s open|doing|blocked|deferred|done|cancelled|active|all] [--label X] ' +
    '[--priority N|pN|0..1] [-q TEXT] [--milestone NAME|none] [--limit N] [--sort pri|updated] [--cursor C] [--all] [--json]',
};

/**
 * `rat ls [project]` — таблица задач или JSON {issues, next_cursor}.
 * Без явного проекта берётся проект по правилам resolveProject; --all — все
 * неархивные проекты.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  const { flags, positionals } = parseArgs(ctx.args, {
    values: ['status', 'label', 'priority', 'query', 'limit', 'sort', 'cursor', 'milestone'],
    booleans: ['all'],
    aliases: { s: 'status', q: 'query' },
    hint: meta.usage,
  });

  if (positionals.length > 1) {
    throw new UsageError('ls: можно указать не более одного проекта.', {
      code: 'invalid_arguments',
      hint: meta.usage,
    });
  }
  if (flags.all && positionals.length) {
    throw new UsageError('ls: --all несовместим с явным проектом.', {
      code: 'invalid_arguments',
      hint: meta.usage,
    });
  }

  const wrapper = ctx.openDatabase();
  let project = positionals[0] ?? null;
  if (project === null && !flags.all) {
    project = resolveProject(wrapper, { cwd: ctx.cwd, env: ctx.env }).key;
  }

  const { issues, nextCursor } = searchIssues(wrapper, {
    project,
    status: flags.status ?? 'active',
    label: flags.label ?? null,
    q: flags.query ?? null,
    priority: flags.priority ?? null,
    milestone: flags.milestone ?? null,
    limit: flags.limit ?? 50,
    sort: flags.sort ?? 'pri',
    cursor: flags.cursor ?? null,
  });

  if (ctx.flags.json) {
    ctx.printJson({ issues, next_cursor: nextCursor });
    return 0;
  }
  if (ctx.flags.quiet) {
    if (issues.length) ctx.print(issues.map((issue) => issue.id).join('\n'));
    return 0;
  }

  if (issues.length === 0) {
    ctx.print('Задач нет.');
    return 0;
  }

  printTable(ctx, issues);
  if (nextCursor) ctx.print(`\nЕщё: rat ls --cursor ${nextCursor}`);
  return 0;
}

function printTable(ctx, issues) {
  const color = useColor(ctx.io, ctx.env);
  const headers = ['ID', 'PRI', 'STATUS', 'AGE', 'ASSIGNEE', 'LABELS', 'MILESTONE', 'TITLE'];
  const rows = issues.map((issue) => [
    issue.id,
    `p${issue.priority}`,
    issue.status,
    formatAge(issue.created_at),
    issue.assignee ?? '—',
    issue.labels.length ? issue.labels.join(',') : '—',
    issue.milestone ?? '—',
    issue.title,
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const pad = (value, index) => (index === headers.length - 1 ? value : value.padEnd(widths[index]));

  const headerLine = headers.map((header, index) => pad(header, index)).join('  ');
  ctx.print(paint(headerLine, 2, color));

  rows.forEach((row, rowIndex) => {
    const statusColor = STATUS_COLORS[issues[rowIndex].status] ?? null;
    const cells = row.map((value, index) => {
      const padded = pad(value, index);
      if (index === headers.length - 1) return padded;
      if (index === 2) return paint(padded, statusColor, color);
      return padded;
    });
    ctx.print(cells.join('  '));
  });
}
