import {
  archiveProject,
  createProject,
  listProjectsWithCounts,
} from '../../core/store.mjs';
import { UsageError } from '../../core/db.mjs';
import { parseArgs } from '../args.mjs';
import { paint, projectColorCode, STATUS_COLORS, useColor } from '../ui.mjs';

export const meta = {
  name: 'project',
  summary: 'проекты: add KEY, ls, archive KEY',
  usage: [
    'rat project add KEY --name "..." [--path <dir>] [--color <slug>] [--json]',
    'rat project ls [--all] [--json]',
    'rat project archive KEY [--json]',
  ].join('\n       '),
};

/**
 * `rat project <add|ls>` — управление проектами.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  const [subcommand, ...args] = ctx.args;
  if (!subcommand) {
    throw new UsageError('Укажите подкоманду project: add или ls.', {
      code: 'missing_subcommand',
      hint: meta.usage,
    });
  }
  if (subcommand === 'add') return runAdd(ctx, args);
  if (subcommand === 'ls') return runLs(ctx, args);
  if (subcommand === 'archive') return runArchive(ctx, args);
  throw new UsageError(`Неизвестная подкоманда project «${subcommand}».`, {
    code: 'unknown_subcommand',
    hint: meta.usage,
  });
}

function runAdd(ctx, args) {
  const { flags, positionals } = parseArgs(args, {
    values: ['name', 'path', 'color'],
    hint: 'rat project add KEY --name "..." [--path <dir>] [--color <slug>]',
  });

  if (positionals.length !== 1) {
    throw new UsageError('project add: нужен ровно один KEY.', {
      code: 'invalid_arguments',
      hint: 'rat project add KEY --name "..."',
    });
  }
  if (flags.name === undefined) {
    throw new UsageError('project add: флаг --name обязателен.', {
      code: 'missing_flag',
      hint: 'rat project add KEY --name "..."',
    });
  }

  const project = createProject(ctx.openDatabase(), {
    key: positionals[0],
    name: flags.name,
    rootPath: flags.path ?? null,
    color: flags.color ?? null,
    cwd: ctx.cwd,
  });

  if (ctx.flags.json) {
    ctx.printJson(project);
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(project.key);
    return 0;
  }
  ctx.print(`Проект ${project.key} «${project.name}» создан.`);
  return 0;
}

function runArchive(ctx, args) {
  const { positionals } = parseArgs(args, {
    hint: 'rat project archive KEY [--json]',
  });
  if (positionals.length !== 1) {
    throw new UsageError('project archive: нужен ровно один KEY.', {
      code: 'invalid_arguments',
      hint: 'rat project archive KEY [--json]',
    });
  }

  const project = archiveProject(ctx.openDatabase(), { key: positionals[0] });

  if (ctx.flags.json) {
    ctx.printJson(project);
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(project.key);
    return 0;
  }
  ctx.print(`Проект ${project.key} архивирован.`);
  return 0;
}

function runLs(ctx, args) {
  const { flags, positionals } = parseArgs(args, {
    booleans: ['all'],
    hint: 'rat project ls [--all] [--json]',
  });
  if (positionals.length) {
    throw new UsageError(`project ls не принимает аргументов: ${positionals.join(' ')}`, {
      code: 'unexpected_argument',
      hint: 'rat project ls [--all] [--json]',
    });
  }

  const projects = listProjectsWithCounts(ctx.openDatabase(), {
    includeArchived: Boolean(flags.all),
  });

  if (ctx.flags.json) {
    ctx.printJson({ projects });
    return 0;
  }
  if (ctx.flags.quiet) {
    if (projects.length) ctx.print(projects.map((project) => project.key).join('\n'));
    return 0;
  }

  if (projects.length === 0) {
    ctx.print('Проектов нет. Создайте: rat project add KEY --name "..."');
    return 0;
  }

  const color = useColor(ctx.io, ctx.env);
  const statuses = ['open', 'doing', 'blocked', 'done', 'cancelled'];
  const headers = ['KEY', 'NAME', ...statuses.map((status) => status.toUpperCase()), 'TOTAL'];
  const rows = projects.map((project) => [
    project.key,
    project.archived_at ? `${project.name} (архив)` : project.name,
    ...statuses.map((status) => String(project.counts[status])),
    String(project.counts.total),
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const pad = (value, index) =>
    index <= 1 ? value.padEnd(widths[index]) : value.padStart(widths[index]);

  const headerLine = headers.map((header, index) => pad(header, index)).join('  ');
  ctx.print(paint(headerLine, 2, color));

  for (const project of projects) {
    const values = [
      project.key,
      project.archived_at ? `${project.name} (архив)` : project.name,
      ...statuses.map((status) => String(project.counts[status])),
      String(project.counts.total),
    ];
    const cells = values.map((value, index) => {
      const padded = pad(value, index);
      if (index === 0) return paint(padded, projectColorCode(project.color), color);
      if (index > 1 && index <= statuses.length + 1) {
        return paint(padded, STATUS_COLORS[statuses[index - 2]], color);
      }
      if (index === values.length - 1) return paint(padded, 1, color);
      return padded;
    });
    ctx.print(cells.join('  '));
  }
  return 0;
}
