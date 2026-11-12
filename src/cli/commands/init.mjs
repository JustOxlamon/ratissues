import { initDatabase } from '../../core/store.mjs';
import { UsageError } from '../../core/db.mjs';

export const meta = {
  name: 'init',
  summary: 'создать базу, схему и проект RAT по умолчанию',
  usage: 'rat init [--json] [--quiet] [--db <path>]',
};

/**
 * `rat init` — идемпотентная инициализация базы.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  if (ctx.args.length) {
    throw new UsageError(`init не принимает аргументов: ${ctx.args.join(' ')}`, {
      code: 'unexpected_argument',
      hint: meta.usage,
    });
  }

  const report = initDatabase(ctx.openDatabase());

  if (ctx.flags.json) {
    ctx.printJson({
      ok: true,
      path: report.path,
      schema_version: report.schemaVersion,
      fts5: report.hasFts5,
      default_project: report.defaultProject,
      project_created: report.projectCreated,
    });
    return 0;
  }

  if (ctx.flags.quiet) {
    ctx.print(report.path);
    return 0;
  }

  ctx.print(`База: ${report.path}`);
  ctx.print(`Схема: v${report.schemaVersion}`);
  ctx.print(`Проект по умолчанию: ${report.defaultProject ?? '—'}`);
  ctx.print(`FTS5: ${report.hasFts5 ? 'доступен' : 'нет (поиск через LIKE)'}`);
  ctx.print(report.projectCreated ? 'Проект RAT создан.' : 'Проект RAT уже существует.');
  return 0;
}
