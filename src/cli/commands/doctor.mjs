import { doctor } from '../../core/store.mjs';
import { UsageError } from '../../core/db.mjs';

export const meta = {
  name: 'doctor',
  summary: 'проверить базу: схема, WAL, FTS5, целостность, права на запись',
  usage: 'rat doctor [--json] [--quiet] [--db <path>]',
};

/**
 * `rat doctor` — отчёт о состоянии базы. Exit code 0, если всё в порядке, иначе 4.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  if (ctx.args.length) {
    throw new UsageError(`doctor не принимает аргументов: ${ctx.args.join(' ')}`, {
      code: 'unexpected_argument',
      hint: meta.usage,
    });
  }

  const report = doctor(ctx.openDatabase());

  if (ctx.flags.json) {
    ctx.printJson({
      ok: report.ok,
      path: report.path,
      schema_version: report.schemaVersion,
      journal_mode: report.journalMode,
      fts5: report.hasFts5,
      counts: report.counts,
      checks: report.checks,
    });
    return report.ok ? 0 : 4;
  }

  if (ctx.flags.quiet) {
    ctx.print(report.ok ? 'ok' : 'fail');
    return report.ok ? 0 : 4;
  }

  const lines = [];
  lines.push(`База: ${report.path}`);
  lines.push(`Схема: ${report.schemaVersion ? `v${report.schemaVersion}` : 'не инициализирована'}`);
  lines.push(`Журнал: ${report.journalMode ?? '—'}`);
  lines.push('');
  for (const check of report.checks) {
    lines.push(`${check.ok ? '[ok]  ' : '[FAIL]'} ${check.message}`);
  }
  lines.push('');
  lines.push(
    `Проектов: ${report.counts.projects}, задач: ${report.counts.issues}, событий: ${report.counts.events}`,
  );
  lines.push(report.ok ? 'Итог: база здорова.' : 'Итог: найдены проблемы.');

  ctx.print(lines.join('\n'));
  return report.ok ? 0 : 4;
}
