import { claimIssue } from '../../core/store.mjs';
import { UsageError } from '../../core/db.mjs';
import { parseArgs } from '../args.mjs';

export const meta = {
  name: 'claim',
  summary: 'взять задачу в работу (doing + assignee)',
  usage: 'rat claim ID [--json]',
};

/**
 * `rat claim ID` — status=doing, assignee=actor, событие kind=claim.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  const { positionals } = parseArgs(ctx.args, { hint: meta.usage });
  if (positionals.length !== 1) {
    throw new UsageError('claim: нужен ровно один ID задачи.', {
      code: 'invalid_arguments',
      hint: meta.usage,
    });
  }

  const result = claimIssue(ctx.openDatabase(), {
    ref: positionals[0],
    actor: ctx.flags.actor,
    env: ctx.env,
  });

  if (ctx.flags.json) {
    ctx.printJson(result);
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(result.issue.id);
    return 0;
  }

  const from = result.event.data?.from ?? '?';
  ctx.print(`${result.issue.id}: ${from} → doing, исполнитель ${result.issue.assignee}.`);
  return 0;
}
