import { addComment } from '../../core/store.mjs';
import { UsageError } from '../../core/db.mjs';
import { parseArgs, readStdinText, trimTrailingNewline } from '../args.mjs';

export const meta = {
  name: 'comment',
  summary: 'добавить комментарий',
  usage: 'rat comment ID [text|-] [--idem UUID] [--json]',
};

/**
 * `rat comment ID [text|-]` — неизменяемый комментарий. Без текста или с «-»
 * читает stdin.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const { flags, positionals } = parseArgs(ctx.args, {
    values: ['idem'],
    hint: meta.usage,
  });
  if (positionals.length === 0) {
    throw new UsageError('comment: нужен ID задачи.', {
      code: 'invalid_arguments',
      hint: meta.usage,
    });
  }

  const [ref, ...rest] = positionals;
  let text = rest.join(' ');

  if (text === '' || text === '-') {
    text = trimTrailingNewline(await readStdinText(ctx.io.stdin));
  }

  const event = addComment(ctx.openDatabase(), {
    ref,
    text,
    actor: ctx.flags.actor,
    idem: flags.idem ?? null,
    env: ctx.env,
  });

  if (ctx.flags.json) {
    ctx.printJson(event);
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(String(event.id));
    return 0;
  }

  ctx.print(
    event.deduplicated
      ? `Комментарий уже добавлен к ${event.issue}.`
      : `Комментарий добавлен к ${event.issue}.`,
  );
  return 0;
}
