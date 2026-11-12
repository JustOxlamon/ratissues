import { listLog } from '../../core/query.mjs';
import { UsageError } from '../../core/db.mjs';
import { parseArgs } from '../args.mjs';
import { describeEvent, formatTs, paint, useColor } from '../ui.mjs';

export const meta = {
  name: 'log',
  summary: 'лента событий (что происходило)',
  usage: 'rat log [project] [--since 1d|ISO] [--kind K] [--limit N] [--json]',
};

/**
 * `rat log [project]` — лента событий. Без проекта — по всем проектам.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  const { flags, positionals } = parseArgs(ctx.args, {
    values: ['since', 'kind', 'limit'],
    hint: meta.usage,
  });
  if (positionals.length > 1) {
    throw new UsageError('log: можно указать не более одного проекта.', {
      code: 'invalid_arguments',
      hint: meta.usage,
    });
  }

  const events = listLog(ctx.openDatabase(), {
    project: positionals[0] ?? null,
    since: flags.since ?? null,
    kind: flags.kind ?? null,
    limit: flags.limit ?? 50,
  });

  if (ctx.flags.json) {
    ctx.printJson({ events });
    return 0;
  }
  if (ctx.flags.quiet) {
    if (events.length) ctx.print(events.map((event) => String(event.id)).join('\n'));
    return 0;
  }

  if (events.length === 0) {
    ctx.print('Событий нет.');
    return 0;
  }

  const color = useColor(ctx.io, ctx.env);
  for (const event of events) {
    const issue = event.issue ?? '—';
    const kind = paint(event.kind.padEnd(8), kindColor(event.kind), color);
    const description = String(describeEvent(event)).split('\n')[0];
    ctx.print(`${formatTs(event.ts)}  ${issue.padEnd(8)}  ${kind} ${event.actor}  ${description}`);
  }
  return 0;
}

function kindColor(kind) {
  if (kind === 'comment') return 36;
  if (kind === 'status') return 33;
  if (kind === 'claim') return 92;
  if (kind === 'created') return 32;
  if (kind === 'edit') return 35;
  return 90;
}
