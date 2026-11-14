import { UsageError } from '../../core/db.mjs';
import { listMilestones } from '../../core/query.mjs';
import { createMilestone, updateMilestone } from '../../core/store.mjs';
import { parseArgs, readStdinText, trimTrailingNewline } from '../args.mjs';
import { formatTs, paint, useColor } from '../ui.mjs';

export const meta = {
  name: 'milestone',
  summary: 'милстоуны: add, ls, edit, close, reopen',
  usage: [
    'rat milestone add NAME [--project K] [--due YYYY-MM-DD] [--body TEXT|-]',
    'rat milestone ls [project] [--state open|closed|all]',
    'rat milestone edit NAME [--project K] [--name NEW] [--due DATE] [--clear-due] [--body TEXT|-]',
    'rat milestone close NAME [--project K]',
    'rat milestone reopen NAME [--project K]',
  ].join('\n       '),
};

/**
 * `rat milestone <add|ls|edit|close|reopen>` — управление милстоунами.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const [subcommand, ...args] = ctx.args;
  if (!subcommand) {
    throw new UsageError('Укажите подкоманду milestone: add, ls, edit, close или reopen.', {
      code: 'missing_subcommand',
      hint: meta.usage,
    });
  }
  if (subcommand === 'add') return runAdd(ctx, args);
  if (subcommand === 'ls') return runLs(ctx, args);
  if (subcommand === 'edit') return runEdit(ctx, args);
  if (subcommand === 'close') return runState(ctx, args, 'closed');
  if (subcommand === 'reopen') return runState(ctx, args, 'open');
  throw new UsageError(`Неизвестная подкоманда milestone «${subcommand}».`, {
    code: 'unknown_subcommand',
    hint: meta.usage,
  });
}

async function runAdd(ctx, args) {
  const { flags, positionals } = parseArgs(args, {
    values: ['project', 'due', 'body'],
    hint: 'rat milestone add NAME [--project K] [--due YYYY-MM-DD] [--body TEXT|-]',
  });
  if (positionals.length !== 1) {
    throw new UsageError('milestone add: нужен ровно один NAME.', {
      code: 'invalid_arguments',
      hint: 'rat milestone add NAME [--project K] [--due YYYY-MM-DD] [--body TEXT|-]',
    });
  }

  let body = flags.body ?? '';
  if (body === '-') {
    body = trimTrailingNewline(await readStdinText(ctx.io.stdin));
  }

  const milestone = createMilestone(ctx.openDatabase(), {
    project: flags.project ?? null,
    name: positionals[0],
    body,
    due: flags.due ?? null,
    cwd: ctx.cwd,
    env: ctx.env,
  });

  return printMilestone(ctx, milestone, 'создан');
}

async function runEdit(ctx, args) {
  const { flags, positionals } = parseArgs(args, {
    values: ['project', 'name', 'due', 'body'],
    booleans: ['clear-due'],
    hint:
      'rat milestone edit NAME [--project K] [--name NEW] [--due DATE] [--clear-due] [--body TEXT|-]',
  });
  if (positionals.length !== 1) {
    throw new UsageError('milestone edit: нужен ровно один NAME (текущее имя).', {
      code: 'invalid_arguments',
      hint:
        'rat milestone edit NAME [--project K] [--name NEW] [--due DATE] [--clear-due] [--body TEXT|-]',
    });
  }

  let body = flags.body;
  if (body === '-') {
    body = trimTrailingNewline(await readStdinText(ctx.io.stdin));
  }

  const milestone = updateMilestone(ctx.openDatabase(), {
    ref: positionals[0],
    project: flags.project ?? null,
    name: flags.name,
    body,
    due: flags.due ?? null,
    clearDue: Boolean(flags['clear-due']),
    cwd: ctx.cwd,
    env: ctx.env,
  });

  return printMilestone(ctx, milestone, 'обновлён');
}

function runState(ctx, args, state) {
  const { flags, positionals } = parseArgs(args, {
    values: ['project'],
    hint: `rat milestone ${state === 'closed' ? 'close' : 'reopen'} NAME [--project K]`,
  });
  if (positionals.length !== 1) {
    throw new UsageError(`milestone ${state === 'closed' ? 'close' : 'reopen'}: нужен ровно один NAME.`, {
      code: 'invalid_arguments',
      hint: `rat milestone ${state === 'closed' ? 'close' : 'reopen'} NAME [--project K]`,
    });
  }

  const milestone = updateMilestone(ctx.openDatabase(), {
    ref: positionals[0],
    project: flags.project ?? null,
    state,
    cwd: ctx.cwd,
    env: ctx.env,
  });

  return printMilestone(ctx, milestone, state === 'closed' ? 'закрыт' : 'открыт');
}

function runLs(ctx, args) {
  const { flags, positionals } = parseArgs(args, {
    values: ['state'],
    hint: 'rat milestone ls [project] [--state open|closed|all]',
  });
  if (positionals.length > 1) {
    throw new UsageError('milestone ls: можно указать не более одного проекта.', {
      code: 'invalid_arguments',
      hint: 'rat milestone ls [project] [--state open|closed|all]',
    });
  }

  const milestones = listMilestones(ctx.openDatabase(), {
    project: positionals[0] ?? null,
    state: flags.state ?? 'open',
    cwd: ctx.cwd,
    env: ctx.env,
  });

  if (ctx.flags.json) {
    ctx.printJson({ milestones });
    return 0;
  }
  if (ctx.flags.quiet) {
    if (milestones.length) ctx.print(milestones.map((milestone) => milestone.name).join('\n'));
    return 0;
  }

  if (milestones.length === 0) {
    ctx.print('Милстоунов нет.');
    return 0;
  }

  printTable(ctx, milestones);
  return 0;
}

function printMilestone(ctx, milestone, verb) {
  if (ctx.flags.json) {
    ctx.printJson(milestone);
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(milestone.name);
    return 0;
  }
  ctx.print(`Милстоун ${milestone.project}/${milestone.name} ${verb}.`);
  return 0;
}

function formatProgress(progress) {
  const denominator = progress.total - progress.cancelled;
  return `${progress.done}/${denominator} (${progress.percent}%)`;
}

function formatDue(ts) {
  if (ts === null || ts === undefined) return '—';
  return formatTs(ts).slice(0, 10);
}

function printTable(ctx, milestones) {
  const color = useColor(ctx.io, ctx.env);
  const headers = ['PROJECT', 'NAME', 'STATE', 'PROGRESS', 'DUE'];
  const rows = milestones.map((milestone) => [
    milestone.project,
    milestone.name,
    milestone.state,
    formatProgress(milestone.progress),
    formatDue(milestone.due_at),
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const pad = (value, index) => (index <= 1 ? value.padEnd(widths[index]) : value.padStart(widths[index]));

  ctx.print(paint(headers.map((header, index) => pad(header, index)).join('  '), 2, color));
  rows.forEach((row, rowIndex) => {
    const cells = row.map((value, index) => {
      const padded = pad(value, index);
      if (index === 2) return paint(padded, milestones[rowIndex].state === 'open' ? 92 : 90, color);
      return padded;
    });
    ctx.print(cells.join('  '));
  });
}
