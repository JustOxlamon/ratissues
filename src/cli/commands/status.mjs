import { changeStatus } from '../../core/store.mjs';
import { UsageError } from '../../core/db.mjs';
import { parseArgs } from '../args.mjs';

export const meta = {
  name: 'status',
  summary: 'сменить статус задачи',
  usage: 'rat status ID <open|doing|blocked|done|cancelled> [--reason TEXT] [--json]',
};

/**
 * `rat status ID <status>` — смена статуса. Из done/cancelled только reopen.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  const { flags, positionals } = parseArgs(ctx.args, {
    values: ['reason'],
    hint: meta.usage,
  });
  if (positionals.length !== 2) {
    throw new UsageError('status: нужны ID задачи и новый статус.', {
      code: 'invalid_arguments',
      hint: meta.usage,
    });
  }

  const [ref, status] = positionals;
  const result = changeStatus(ctx.openDatabase(), {
    ref,
    status,
    reason: flags.reason ?? null,
    actor: ctx.flags.actor,
    env: ctx.env,
  });
  printResult(ctx, result);
  return 0;
}

/** Сахарные команды над тем же changeStatus: done / cancel / reopen. */
export const aliases = {
  done: makeAlias('done', 'done', 'закрыть задачу как done'),
  cancel: makeAlias('cancel', 'cancelled', 'отменить задачу'),
  reopen: makeAlias('reopen', 'open', 'переоткрыть задачу'),
};

function makeAlias(name, status, summary) {
  return {
    meta: {
      name,
      summary,
      usage: `rat ${name} ID [--reason TEXT] [--json]`,
    },
    run(ctx) {
      const { flags, positionals } = parseArgs(ctx.args, {
        values: ['reason'],
        hint: `rat ${name} ID [--reason TEXT] [--json]`,
      });
      if (positionals.length !== 1) {
        throw new UsageError(`${name}: нужен ровно один ID задачи.`, {
          code: 'invalid_arguments',
          hint: `rat ${name} ID [--reason TEXT] [--json]`,
        });
      }

      const result = changeStatus(ctx.openDatabase(), {
        ref: positionals[0],
        status,
        reason: flags.reason ?? null,
        actor: ctx.flags.actor,
        env: ctx.env,
      });
      printResult(ctx, result);
      return 0;
    },
  };
}

function printResult(ctx, { issue, event }) {
  if (ctx.flags.json) {
    ctx.printJson({ issue, event });
    return;
  }
  if (ctx.flags.quiet) {
    ctx.print(issue.id);
    return;
  }

  const data = event.data ?? {};
  const reason = data.reason ? ` — ${data.reason}` : '';
  ctx.print(`${issue.id}: ${data.from ?? '?'} → ${data.to ?? '?'}${reason}`);
}
