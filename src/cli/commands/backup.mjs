import { existsSync } from 'node:fs';

import {
  createBackup,
  isDisabled,
  listBackups,
  pruneBackups,
  resolveBackupDir,
  resolveInterval,
  resolveKeep,
} from '../../core/backup.mjs';
import { NotFoundError, UsageError } from '../../core/db.mjs';
import { parseArgs } from '../args.mjs';

export const meta = {
  name: 'backup',
  summary: 'резервная копия базы: создать сейчас или показать историю',
  usage: 'rat backup [--list] [--keep N] [--json]',
};

/**
 * `rat backup` — ручная копия базы; `--list` — что уже накопилось.
 * Автобекап перед каждой командой живёт в core/backup.mjs и управляется
 * RAT_BACKUP / RAT_BACKUP_INTERVAL / RAT_BACKUP_KEEP / RAT_BACKUP_DIR.
 * @param {object} ctx контекст CLI (см. src/cli/index.mjs)
 * @returns {number} exit code
 */
export function run(ctx) {
  const { flags, positionals } = parseArgs(ctx.args, {
    values: ['keep'],
    booleans: ['list'],
    hint: meta.usage,
  });

  if (positionals.length) {
    throw new UsageError(`backup не принимает аргументов: ${positionals.join(' ')}`, {
      code: 'unexpected_argument',
      hint: meta.usage,
    });
  }

  const keep = flags.keep === undefined ? undefined : parseKeep(flags.keep);
  const dir = resolveBackupDir(ctx.dbPath, ctx.env);
  if (!dir) {
    throw new UsageError('Для базы в памяти резервные копии недоступны.', {
      code: 'backup_unavailable',
      hint: 'Укажите файловую базу через --db.',
    });
  }

  if (flags.list) {
    return showList(ctx, { dir, keep });
  }

  if (!existsSync(ctx.dbPath)) {
    throw new NotFoundError(`База не найдена: ${ctx.dbPath}`, {
      code: 'db_not_found',
      hint: 'Сначала выполните: rat init',
    });
  }

  const created = createBackup(ctx.dbPath, { env: ctx.env, keep });

  if (ctx.flags.json) {
    ctx.printJson({
      ok: true,
      path: created.path,
      size: created.size,
      created_at: created.createdAt,
      removed: created.removed,
      keep: keep ?? resolveKeep(ctx.env),
      dir,
    });
    return 0;
  }

  if (ctx.flags.quiet) {
    ctx.print(created.path);
    return 0;
  }

  ctx.print(`Копия: ${created.path} (${formatSize(created.size)})`);
  if (created.removed.length) {
    ctx.print(`Ротация: удалено старых копий ${created.removed.length}.`);
  }
  return 0;
}

function showList(ctx, { dir, keep }) {
  const limit = keep ?? resolveKeep(ctx.env);
  const removed = Number.isInteger(limit) && limit > 0 && keep !== undefined
    ? pruneBackups(ctx.dbPath, { env: ctx.env, keep: limit })
    : [];
  const items = listBackups(ctx.dbPath, ctx.env);

  if (ctx.flags.json) {
    ctx.printJson({
      dir,
      keep: limit,
      interval_seconds: resolveInterval(ctx.env),
      auto: !isDisabled(ctx.env),
      backups: items.map((item) => ({
        path: item.path,
        name: item.name,
        size: item.size,
        created_at: item.createdAt,
      })),
      removed,
    });
    return 0;
  }

  if (items.length === 0) {
    ctx.print(`Копий нет. Каталог: ${dir}`);
    return 0;
  }

  ctx.print(`Копии в ${dir} (храним ${limit}, интервал ${formatInterval(resolveInterval(ctx.env))}):`);
  for (const item of items) {
    const mark = item.path === items[0].path ? '*' : ' ';
    ctx.print(`${mark} ${item.name}  ${formatSize(item.size)}  ${formatAge(item.createdAt)}`);
  }
  if (removed.length) ctx.print(`Ротация: удалено ${removed.length}.`);
  return 0;
}

function parseKeep(raw) {
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--keep ожидает целое ≥ 1, получено «${raw}».`, {
      code: 'invalid_flag_value',
      hint: meta.usage,
    });
  }
  return value;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatAge(createdAt) {
  const minutes = Math.max(0, Math.round((Date.now() - createdAt) / 60000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

function formatInterval(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} с`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ч`;
  return `${Math.round(seconds / 86400)} дн`;
}
