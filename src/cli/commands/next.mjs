import { nextIssue, resolveProject } from '../../core/query.mjs';
import { UsageError } from '../../core/db.mjs';
import { parseArgs } from '../args.mjs';
import { paint, STATUS_COLORS, useColor } from '../ui.mjs';

export const meta = {
  name: 'next',
  summary: 'следующая открытая задача (priority asc, потом старая)',
  usage: 'rat next [project] [--label X] [--json]',
};

/**
 * `rat next [project]` — самая приоритетная открытая задача. Отсутствие
 * задачи — не ошибка: exit 0, JSON `{"issue": null}`.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  const { flags, positionals } = parseArgs(ctx.args, {
    values: ['label'],
    hint: meta.usage,
  });
  if (positionals.length > 1) {
    throw new UsageError('next: можно указать не более одного проекта.', {
      code: 'invalid_arguments',
      hint: meta.usage,
    });
  }

  const wrapper = ctx.openDatabase();
  const project = positionals[0]
    ?? resolveProject(wrapper, { cwd: ctx.cwd, env: ctx.env }).key;

  const issue = nextIssue(wrapper, { project, label: flags.label ?? null });

  if (ctx.flags.json) {
    ctx.printJson({ issue });
    return 0;
  }
  if (!issue) {
    if (!ctx.flags.quiet) ctx.print('Нет открытых задач.');
    return 0;
  }
  if (ctx.flags.quiet) {
    ctx.print(issue.id);
    return 0;
  }

  const color = useColor(ctx.io, ctx.env);
  const statusColor = STATUS_COLORS[issue.status] ?? null;
  const labels = issue.labels.length ? `  [${issue.labels.join(',')}]` : '';
  ctx.print(
    `${paint(issue.id, 1, color)}  ${paint(`p${issue.priority}`, statusColor, color)}  ${issue.title}${labels}`,
  );
  return 0;
}
