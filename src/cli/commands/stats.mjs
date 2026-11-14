import { getStats } from '../../core/query.mjs';
import { UsageError } from '../../core/db.mjs';
import { paint, STATUS_COLORS, useColor } from '../ui.mjs';

export const meta = {
  name: 'stats',
  summary: 'счётчики по проектам/статусам и за неделю',
  usage: 'rat stats [--json]',
};

/**
 * `rat stats` — сводка по всей базе: проекты, статусы, приоритеты, неделя.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  if (ctx.args.length) {
    throw new UsageError(`stats не принимает аргументов: ${ctx.args.join(' ')}`, {
      code: 'unexpected_argument',
      hint: meta.usage,
    });
  }

  const stats = getStats(ctx.openDatabase());

  if (ctx.flags.json) {
    ctx.printJson(stats);
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(String(stats.totals.total));
    return 0;
  }

  printHuman(ctx, stats);
  return 0;
}

function printHuman(ctx, stats) {
  const color = useColor(ctx.io, ctx.env);
  const statuses = ['open', 'doing', 'blocked', 'deferred', 'done', 'cancelled'];
  const headers = ['KEY', 'NAME', ...statuses.map((status) => status.toUpperCase()), 'TOTAL'];
  const rows = stats.projects.map((project) => [
    project.key,
    project.name,
    ...statuses.map((status) => String(project.counts[status])),
    String(project.counts.total),
  ]);

  if (rows.length === 0) {
    ctx.print('Проектов нет.');
    return;
  }

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const pad = (value, index) => (index <= 1 ? value.padEnd(widths[index]) : value.padStart(widths[index]));

  ctx.print(paint(headers.map((header, index) => pad(header, index)).join('  '), 2, color));
  stats.projects.forEach((project, rowIndex) => {
    const cells = rows[rowIndex].map((value, index) => {
      const padded = pad(value, index);
      if (index === 0) return paint(padded, 1, color);
      if (index > 1 && index <= statuses.length + 1) {
        return paint(padded, STATUS_COLORS[statuses[index - 2]], color);
      }
      if (index === rows[rowIndex].length - 1) return paint(padded, 1, color);
      return padded;
    });
    ctx.print(cells.join('  '));
  });

  ctx.print('');
  ctx.print(
    `Всего: ${stats.totals.total} — ${statuses
      .map((status) => `${status} ${stats.totals.byStatus[status]}`)
      .join(', ')}`,
  );
  ctx.print(
    `Приоритеты: ${Object.entries(stats.totals.byPriority)
      .map(([priority, count]) => `p${priority} ${count}`)
      .join(', ')}`,
  );
  ctx.print(
    `За 7 дней: создано ${stats.week.created}, закрыто ${stats.week.closed}, комментариев ${stats.week.comments}`,
  );
}
