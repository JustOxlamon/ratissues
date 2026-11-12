import { editIssue } from '../../core/store.mjs';
import { UsageError } from '../../core/db.mjs';
import { parseArgs, readStdinText, trimTrailingNewline } from '../args.mjs';

export const meta = {
  name: 'edit',
  summary: 'править поля задачи (каждое изменение → событие edit)',
  usage:
    'rat edit ID [--title T|-] [--body T|-] [--priority 0..3] [--label +x,-y] ' +
    '[--assignee A] [--ref R] [--json]',
};

/**
 * `rat edit ID` — правки задачи. --title -/--body - читают stdin; --label
 * принимает «+a,-b» и может повторяться (и/или перечисляться через запятую).
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const { flags, positionals } = parseArgs(ctx.args, {
    values: ['title', 'body', 'priority', 'label', 'assignee', 'ref'],
    multi: ['label'],
    hint: meta.usage,
  });
  if (positionals.length !== 1) {
    throw new UsageError('edit: нужен ровно один ID задачи.', {
      code: 'invalid_arguments',
      hint: meta.usage,
    });
  }

  const changes = {};
  if (flags.title !== undefined) {
    changes.title = flags.title === '-'
      ? trimTrailingNewline(await readStdinText(ctx.io.stdin))
      : flags.title;
  }
  if (flags.body !== undefined) {
    changes.body = flags.body === '-'
      ? trimTrailingNewline(await readStdinText(ctx.io.stdin))
      : flags.body;
  }
  if (flags.priority !== undefined) changes.priority = flags.priority;
  if (flags.assignee !== undefined) changes.assignee = flags.assignee;
  if (flags.ref !== undefined) changes.ref = flags.ref;
  if (flags.label !== undefined) changes.labels = parseLabelFlags(flags.label);

  if (Object.keys(changes).length === 0) {
    throw new UsageError('edit: нужно хотя бы одно изменение (--title/--body/--priority/--label/--assignee/--ref).', {
      code: 'no_changes',
      hint: meta.usage,
    });
  }

  const result = editIssue(ctx.openDatabase(), {
    ref: positionals[0],
    changes,
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

  if (result.events.length === 0) {
    ctx.print(`${result.issue.id}: изменений нет.`);
    return 0;
  }
  for (const event of result.events) {
    const { field, from, to } = event.data;
    ctx.print(`${result.issue.id}: ${field}: ${formatValue(from)} → ${formatValue(to)}`);
  }
  return 0;
}

/**
 * «+a,-b», «c» (без знака = добавить), можно повторять флаг/запятые.
 * @param {string[]|string} values
 * @returns {{add: string[], remove: string[]}}
 */
function parseLabelFlags(values) {
  const list = Array.isArray(values) ? values : [values];
  const add = [];
  const remove = [];
  for (const raw of list) {
    for (const part of String(raw).split(',')) {
      const token = part.trim();
      if (token === '') continue;
      if (token.startsWith('+')) add.push(token.slice(1));
      else if (token.startsWith('-')) remove.push(token.slice(1));
      else add.push(token);
    }
  }
  return { add, remove };
}

function formatValue(value) {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '[]';
  return String(value);
}
