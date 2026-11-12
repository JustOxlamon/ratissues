import { getIssueDetail } from '../../core/store.mjs';
import { UsageError } from '../../core/db.mjs';
import { parseArgs } from '../args.mjs';
import { describeEvent, formatTs, paint, STATUS_COLORS, useColor } from '../ui.mjs';

export const meta = {
  name: 'show',
  summary: 'задача и последние события',
  usage: 'rat show ID [--events N] [--json]',
};

/**
 * `rat show` — задача + последние N событий одним вызовом.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  const { flags, positionals } = parseArgs(ctx.args, {
    values: ['events'],
    hint: meta.usage,
  });
  if (positionals.length !== 1) {
    throw new UsageError('show: нужен ровно один ID задачи (RAT-7 или число).', {
      code: 'invalid_arguments',
      hint: meta.usage,
    });
  }

  const detail = getIssueDetail(ctx.openDatabase(), {
    ref: positionals[0],
    events: flags.events ?? 20,
  });

  if (ctx.flags.json) {
    ctx.printJson(detail);
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(detail.issue.id);
    return 0;
  }

  printHuman(ctx, detail);
  return 0;
}

function printHuman(ctx, { issue, events }) {
  const color = useColor(ctx.io, ctx.env);
  const statusColor = STATUS_COLORS[issue.status] ?? null;

  ctx.print(`${paint(issue.id, 1, color)}  ${paint(issue.title, 1, color)}`);
  ctx.print(
    [
      `Статус: ${paint(issue.status, statusColor, color)}`,
      `Приоритет: p${issue.priority}`,
      `Метки: ${issue.labels.length ? issue.labels.join(', ') : '—'}`,
    ].join('   '),
  );

  const meta2 = [
    `Исполнитель: ${issue.assignee ?? '—'}`,
    `Ссылка: ${issue.ref ?? '—'}`,
  ];
  ctx.print(meta2.join('   '));

  const dates = [
    `Создана: ${formatTs(issue.created_at)}`,
    `Обновлена: ${formatTs(issue.updated_at)}`,
  ];
  if (issue.closed_at !== null) {
    const reason = issue.close_reason ? ` (${issue.close_reason})` : '';
    dates.push(`Закрыта: ${formatTs(issue.closed_at)}${reason}`);
  }
  ctx.print(dates.join('   '));

  if (issue.body.trim() !== '') {
    ctx.print('');
    ctx.print(issue.body);
  }

  ctx.print('');
  ctx.print(`События (${events.length}):`);
  if (events.length === 0) {
    ctx.print('  —');
    return;
  }

  for (const event of events) {
    const head = `  ${formatTs(event.ts)}  ${event.actor}  ${paint(event.kind, kindColor(event.kind), color)}`;
    const description = describeEvent(event);
    const lines = String(description).split('\n');
    ctx.print(`${head}  ${lines[0]}`);
    for (const line of lines.slice(1)) ctx.print(`      ${line}`);
  }
}

function kindColor(kind) {
  if (kind === 'comment') return 36;
  if (kind === 'status') return 33;
  if (kind === 'claim') return 92;
  if (kind === 'created') return 32;
  return 90;
}
