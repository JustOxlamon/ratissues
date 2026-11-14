import { UsageError } from '../../core/db.mjs';
import { listCanon, resolveProject } from '../../core/query.mjs';
import {
  createCanon,
  getCanon,
  reactivateCanon,
  repealCanon,
  updateCanon,
} from '../../core/store.mjs';
import { parseArgs, readStdinText, trimTrailingNewline } from '../args.mjs';
import { formatTs, paint, useColor } from '../ui.mjs';

export const meta = {
  name: 'canon',
  summary: 'канон проекта: add, ls, show, edit, repeal, reactivate',
  usage: [
    'rat canon add TITLE [--project K] [--body TEXT|-] [--priority 0..3] [--label a,b] [--source RAT-7] [--supersedes KEY-Cn]',
    'rat canon ls [project] [--state active|repealed|all] [--label x] [-q TEXT]',
    'rat canon show REF [--project K]',
    'rat canon edit REF [--title T|-] [--body T|-] [--priority N] [--label +a,-b] [--project K]',
    'rat canon repeal REF [--reason TEXT] [--project K]',
    'rat canon reactivate REF [--project K]',
  ].join('\n       '),
};

/**
 * `rat canon <add|ls|show|edit|repeal|reactivate>` — канон проекта: актуальные
 * решения из развилок («делай так / не делай так»).
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const [subcommand, ...args] = ctx.args;
  if (!subcommand) {
    throw new UsageError('Укажите подкоманду canon: add, ls, show, edit, repeal или reactivate.', {
      code: 'missing_subcommand',
      hint: meta.usage,
    });
  }
  if (subcommand === 'add') return runAdd(ctx, args);
  if (subcommand === 'ls') return runLs(ctx, args);
  if (subcommand === 'show') return runShow(ctx, args);
  if (subcommand === 'edit') return runEdit(ctx, args);
  if (subcommand === 'repeal') return runState(ctx, args, 'repeal');
  if (subcommand === 'reactivate') return runState(ctx, args, 'reactivate');
  throw new UsageError(`Неизвестная подкоманда canon «${subcommand}».`, {
    code: 'unknown_subcommand',
    hint: meta.usage,
  });
}

async function runAdd(ctx, args) {
  const { flags, positionals } = parseArgs(args, {
    values: ['project', 'body', 'priority', 'label', 'source', 'supersedes'],
    hint: 'rat canon add TITLE [--project K] [--body TEXT|-] [--priority 0..3] [--label a,b] [--source RAT-7] [--supersedes KEY-Cn]',
  });
  if (positionals.length !== 1) {
    throw new UsageError('canon add: нужен ровно один TITLE.', {
      code: 'invalid_arguments',
      hint: 'rat canon add TITLE [--body TEXT|-] [--priority 0..3] [--label a,b]',
    });
  }

  let body = flags.body ?? '';
  if (body === '-') {
    body = trimTrailingNewline(await readStdinText(ctx.io.stdin));
  }

  const rule = createCanon(ctx.openDatabase(), {
    project: flags.project ?? null,
    title: positionals[0],
    body,
    priority: flags.priority ?? null,
    labels: flags.label ?? null,
    source: flags.source ?? null,
    supersedes: flags.supersedes ?? null,
    cwd: ctx.cwd,
    env: ctx.env,
  });

  return printCanon(ctx, rule, 'создано');
}

function runLs(ctx, args) {
  const { flags, positionals } = parseArgs(args, {
    values: ['project', 'state', 'label', 'q'],
    aliases: { s: 'state', q: 'q' },
    hint: 'rat canon ls [project] [--state active|repealed|all] [--label x] [-q TEXT]',
  });
  if (positionals.length > 1) {
    throw new UsageError('canon ls: можно указать не более одного проекта.', {
      code: 'invalid_arguments',
      hint: 'rat canon ls [project] [--state active|repealed|all]',
    });
  }

  const rules = listCanon(ctx.openDatabase(), {
    project: positionals[0] ?? null,
    state: flags.state ?? 'active',
    label: flags.label ?? null,
    q: flags.q ?? null,
    cwd: ctx.cwd,
    env: ctx.env,
  });

  if (ctx.flags.json) {
    ctx.printJson({ canon: rules });
    return 0;
  }
  if (ctx.flags.quiet) {
    if (rules.length) ctx.print(rules.map((rule) => rule.id).join('\n'));
    return 0;
  }

  if (rules.length === 0) {
    ctx.print('Канон-правил нет.');
    return 0;
  }

  printTable(ctx, rules);
  return 0;
}

function runShow(ctx, args) {
  const { flags, positionals } = parseArgs(args, {
    values: ['project'],
    hint: 'rat canon show REF [--project K]',
  });
  if (positionals.length !== 1) {
    throw new UsageError('canon show: нужен ровно один REF.', {
      code: 'invalid_arguments',
      hint: 'rat canon show REF [--project K]',
    });
  }

  const rule = getCanon(ctx.openDatabase(), positionals[0], {
    projectKey: scopeForRef(ctx, flags.project, positionals[0]),
  });

  if (ctx.flags.json) {
    ctx.printJson(rule);
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(rule.id);
    return 0;
  }

  printShow(ctx, rule);
  return 0;
}

async function runEdit(ctx, args) {
  const { flags, positionals } = parseArgs(args, {
    values: ['project', 'title', 'body', 'priority', 'label'],
    multi: ['label'],
    hint: 'rat canon edit REF [--title T|-] [--body T|-] [--priority N] [--label +a,-b] [--project K]',
  });
  if (positionals.length !== 1) {
    throw new UsageError('canon edit: нужен ровно один REF.', {
      code: 'invalid_arguments',
      hint: 'rat canon edit REF [--title T|-] [--body T|-]',
    });
  }

  let title = flags.title;
  let body = flags.body;
  if (title === '-') title = trimTrailingNewline(await readStdinText(ctx.io.stdin));
  if (body === '-') body = trimTrailingNewline(await readStdinText(ctx.io.stdin));

  const rule = updateCanon(ctx.openDatabase(), {
    ref: positionals[0],
    title,
    body,
    priority: flags.priority ?? undefined,
    labels: flags.label === undefined ? undefined : parseLabelFlags(flags.label),
    projectKey: scopeForRef(ctx, flags.project, positionals[0]),
    env: ctx.env,
  });

  return printCanon(ctx, rule, 'обновлено');
}

/**
 * --label '+a,-b' → {add, remove} для инкрементального изменения набора.
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

function runState(ctx, args, action) {
  const isRepeal = action === 'repeal';
  const { flags, positionals } = parseArgs(args, {
    values: isRepeal ? ['project', 'reason'] : ['project'],
    hint: `rat canon ${action} REF [--project K]${isRepeal ? ' [--reason TEXT]' : ''}`,
  });
  if (positionals.length !== 1) {
    throw new UsageError(`canon ${action}: нужен ровно один REF.`, {
      code: 'invalid_arguments',
      hint: `rat canon ${action} REF [--project K]`,
    });
  }

  const scope = scopeForRef(ctx, flags.project, positionals[0]);
  const rule = isRepeal
    ? repealCanon(ctx.openDatabase(), {
        ref: positionals[0],
        reason: flags.reason ?? null,
        projectKey: scope,
        env: ctx.env,
      })
    : reactivateCanon(ctx.openDatabase(), {
        ref: positionals[0],
        projectKey: scope,
        env: ctx.env,
      });

  return printCanon(ctx, rule, isRepeal ? 'отменено' : 'возвращено в активные');
}

function printCanon(ctx, rule, verb) {
  if (ctx.flags.json) {
    ctx.printJson(rule);
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(rule.id);
    return 0;
  }
  ctx.print(`Канон-правило ${rule.project}/${rule.id} ${verb}: ${rule.status}.`);
  return 0;
}

function printShow(ctx, rule) {
  const color = useColor(ctx.io, ctx.env);
  const lines = [
    `${paint(rule.id, 5, color)} · ${rule.title}`,
    `  статус: ${paint(rule.status, rule.status === 'active' ? 92 : 90, color)} · p${rule.priority} · метки: ${rule.labels.length ? rule.labels.join(', ') : '—'}`,
  ];
  if (rule.source_issue) lines.push(`  источник: ${rule.source_issue}`);
  if (rule.supersedes) lines.push(`  заменяет: ${rule.supersedes}`);
  if (rule.body.trim() !== '') lines.push(`  ${rule.body.replace(/\n/g, '\n  ')}`);
  lines.push(
    `  создано: ${formatTs(rule.created_at)} (${rule.created_by}) · обновлено: ${formatTs(rule.updated_at)}`,
  );
  if (rule.status === 'repealed') {
    lines.push(
      `  отменено: ${formatTs(rule.repealed_at)} (${rule.repealed_by ?? '—'}): ${rule.repeal_reason ?? '—'}`,
    );
    if (rule.meta?.superseded_by) lines.push(`  заменено на: ${rule.meta.superseded_by}`);
  }
  ctx.print(lines.join('\n'));
  return 0;
}

/**
 * Проект-скоуп для ссылки. Полный id (KEY-C1) несёт проект сам; для C1/голого
 * числа — стандартное определение проекта (--project → RAT_PROJECT → root_path
 * → default).
 */
function scopeForRef(ctx, projectFlag, ref) {
  if (projectFlag) return projectFlag;
  const text = String(ref).trim();
  if (/^[A-Za-z0-9]{2,10}-C\d+$/i.test(text)) return null;
  return resolveProject(ctx.openDatabase(), { project: null, cwd: ctx.cwd, env: ctx.env }).key;
}

function truncate(text, max = 48) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function printTable(ctx, rules) {
  const color = useColor(ctx.io, ctx.env);
  const headers = ['PROJECT', 'ID', 'TITLE', 'P', 'STATUS', 'UPDATED'];
  const rows = rules.map((rule) => [
    rule.project,
    rule.id,
    truncate(rule.title),
    String(rule.priority),
    rule.status,
    formatTs(rule.updated_at).slice(0, 10),
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const pad = (value, index) => (index <= 2 ? value.padEnd(widths[index]) : value.padStart(widths[index]));

  ctx.print(paint(headers.map((header, index) => pad(header, index)).join('  '), 2, color));
  rows.forEach((row, rowIndex) => {
    const cells = row.map((value, index) => {
      const padded = pad(value, index);
      if (index === 4) return paint(padded, rules[rowIndex].status === 'active' ? 92 : 90, color);
      return padded;
    });
    ctx.print(cells.join('  '));
  });
}