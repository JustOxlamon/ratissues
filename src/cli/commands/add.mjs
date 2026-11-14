import { createIssue } from '../../core/store.mjs';
import { UsageError } from '../../core/db.mjs';
import { parseArgs, readStdinText, trimTrailingNewline } from '../args.mjs';

export const meta = {
  name: 'add',
  summary: 'создать задачу',
  usage:
    'rat add "title" [--project K] [--body TEXT|-] [--label a,b] [--priority 0..3] ' +
    '[--ref ...] [--assignee ...] [--milestone NAME] [--idem UUID] [--json]',
};

/**
 * `rat add` — создать задачу. --body - читает stdin.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const { flags, positionals } = parseArgs(ctx.args, {
    values: ['project', 'body', 'label', 'priority', 'ref', 'assignee', 'milestone', 'idem'],
    hint: meta.usage,
  });

  if (positionals.length === 0) {
    throw new UsageError('Нужен заголовок задачи: rat add "title".', {
      code: 'missing_title',
      hint: meta.usage,
    });
  }
  if (positionals.length > 1) {
    throw new UsageError('Заголовок должен быть одним аргументом — заключите его в кавычки.', {
      code: 'invalid_title',
      hint: meta.usage,
    });
  }

  let body = flags.body ?? '';
  if (body === '-') {
    body = trimTrailingNewline(await readStdinText(ctx.io.stdin));
  }

  const issue = createIssue(ctx.openDatabase(), {
    project: flags.project ?? null,
    title: positionals[0],
    body,
    priority: flags.priority ?? null,
    labels: flags.label ?? null,
    assignee: flags.assignee ?? null,
    ref: flags.ref ?? null,
    milestone: flags.milestone ?? null,
    actor: ctx.flags.actor,
    idem: flags.idem ?? null,
    cwd: ctx.cwd,
    env: ctx.env,
  });

  if (ctx.flags.json) {
    ctx.printJson(issue);
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(issue.id);
    return 0;
  }

  ctx.print(issue.deduplicated ? `${issue.id} уже создана (idem).` : `${issue.id} создана.`);
  return 0;
}
