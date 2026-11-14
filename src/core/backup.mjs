import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { closeDb, openDb } from './db.mjs';

/*
 * backup.mjs — резервные копии базы: устойчивость локальных данных.
 *
 * Не доменный писатель: не меняет issues/events и не открывает транзакций домена.
 * Копия делается через `VACUUM INTO` на отдельном коротком коннекте — это
 * целостный снапшот даже при WAL и параллельных процессах.
 *
 * Политика:
 *   RAT_BACKUP=off            — выключить автобекапы;
 *   RAT_BACKUP_INTERVAL=24h   — как часто (s/m/h/d, по умолчанию 24h);
 *   RAT_BACKUP_KEEP=7         — сколько копий хранить (ротация, по умолчанию 7);
 *   RAT_BACKUP_DIR=<path>     — каталог копий (по умолчанию <каталог БД>/backups);
 *   RAT_BACKUP_DEBUG=1        — печатать причины сбоя бэкапа.
 */

/** Сколько копий хранить по умолчанию. */
export const DEFAULT_BACKUP_KEEP = 7;

/** Интервал между автобекапами по умолчанию, в секундах (сутки). */
export const DEFAULT_BACKUP_INTERVAL_SECONDS = 24 * 60 * 60;

/** Префикс/суффикс имени файла копии. */
const BACKUP_SUFFIX = '.db';

/**
 * Разбирает длительность вида `24h`, `90m`, `30s`, `1d`, `3600`.
 * Голая цифра — секунды. Мусор → fallback.
 * @param {string|number|undefined|null} raw
 * @param {number} fallback
 * @returns {number} секунды
 */
export function parseDuration(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(String(raw).trim());
  if (!match) return fallback;
  const scale = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[(match[2] ?? 's').toLowerCase()];
  const value = Number(match[1]) * scale;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Сколько копий хранить: `RAT_BACKUP_KEEP` или значение по умолчанию.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} целое ≥ 1
 */
export function resolveKeep(env = process.env) {
  const raw = Number.parseInt(env?.RAT_BACKUP_KEEP ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_BACKUP_KEEP;
}

/**
 * Интервал автобекапа в секундах.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveInterval(env = process.env) {
  return parseDuration(env?.RAT_BACKUP_INTERVAL, DEFAULT_BACKUP_INTERVAL_SECONDS);
}

/**
 * Автобекапы выключены (`RAT_BACKUP=off|0|false|no`)?
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isDisabled(env = process.env) {
  const raw = String(env?.RAT_BACKUP ?? '').trim().toLowerCase();
  return raw === 'off' || raw === '0' || raw === 'false' || raw === 'no';
}

/**
 * Каталог копий для базы: `RAT_BACKUP_DIR` или `<каталог БД>/backups`.
 * @param {string} dbPath абсолютный путь к базе
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} null для `:memory:` и пустого пути
 */
export function resolveBackupDir(dbPath, env = process.env) {
  if (!dbPath || dbPath === ':memory:') return null;
  const override = env?.RAT_BACKUP_DIR;
  if (override) return path.resolve(override);
  return path.join(path.dirname(path.resolve(dbPath)), 'backups');
}

/** @param {string} dbPath */
function baseName(dbPath) {
  const name = path.basename(dbPath);
  return name.toLowerCase().endsWith(BACKUP_SUFFIX)
    ? name.slice(0, -BACKUP_SUFFIX.length)
    : name;
}

/**
 * Метка времени в имени файла: локальное время, сортируемо лексикографически.
 * @param {number} ms
 * @returns {string}
 */
export function formatStamp(ms) {
  const d = new Date(ms);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return [
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    pad(d.getMilliseconds(), 3),
  ].join('-');
}

/**
 * Обратный разбор метки из имени файла.
 * @param {string} name
 * @param {string} driver базовое имя базы
 * @returns {number|null} epoch ms или null, если имя не наше
 */
export function parseStampFromName(name, driver) {
  const escaped = driver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `^${escaped}-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})-(\\d{3})${BACKUP_SUFFIX}$`,
  ).exec(name);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match.map(Number);
  const value = new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  return Number.isFinite(value) ? value : null;
}

/**
 * Существующие копии, новые сверху.
 * @param {string} dbPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{path: string, name: string, createdAt: number, size: number}>}
 */
export function listBackups(dbPath, env = process.env) {
  const dir = resolveBackupDir(dbPath, env);
  if (!dir || !existsSync(dir)) return [];
  const driver = baseName(dbPath);

  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const items = [];
  for (const name of names) {
    const createdAt = parseStampFromName(name, driver);
    if (createdAt === null) continue;
    const full = path.join(dir, name);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue; // исчез между readdir и stat
    }
    items.push({ path: full, name, createdAt, size });
  }

  return items.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

/**
 * Удаляет всё, кроме `keep` самых свежих копий.
 * @param {string} dbPath
 * @param {{env?: NodeJS.ProcessEnv, keep?: number}} [options]
 * @returns {string[]} имена удалённых файлов
 */
export function pruneBackups(dbPath, { env = process.env, keep = resolveKeep(env) } = {}) {
  const limit = Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_BACKUP_KEEP;
  const removed = [];
  for (const item of listBackups(dbPath, env).slice(limit)) {
    try {
      unlinkSync(item.path);
      removed.push(item.name);
    } catch {
      // занят/нет прав — не повод валить команду
    }
  }
  return removed;
}

/**
 * Создаёт копию базы немедленно (и подчищает старые).
 * @param {string} dbPath
 * @param {{env?: NodeJS.ProcessEnv, keep?: number, now?: number}} [options]
 * @returns {{path: string, createdAt: number, size: number, removed: string[]}}
 */
export function createBackup(dbPath, { env = process.env, keep, now = Date.now() } = {}) {
  const dir = resolveBackupDir(dbPath, env);
  if (!dir) throw new Error('Для базы в памяти резервные копии недоступны.');
  mkdirSync(dir, { recursive: true });

  const driver = baseName(dbPath);
  let createdAt = now;
  let target = path.join(dir, `${driver}-${formatStamp(createdAt)}${BACKUP_SUFFIX}`);
  // Два процесса в одну миллисекунду — разводим суффиксом, не теряя сортируемость по mtime.
  for (let attempt = 1; existsSync(target) && attempt <= 50; attempt += 1) {
    createdAt = now + attempt;
    target = path.join(dir, `${driver}-${formatStamp(createdAt)}${BACKUP_SUFFIX}`);
  }

  const wrapper = openDb(dbPath);
  try {
    wrapper.db.prepare('VACUUM INTO ?').run(target);
  } finally {
    closeDb(wrapper);
  }

  const size = statSync(target).size;
  const removed = pruneBackups(dbPath, { env, keep: keep ?? resolveKeep(env) });
  return { path: target, createdAt, size, removed };
}

/**
 * Автобекап перед командой: создаёт копию, только если прошло больше интервала
 * или копий ещё нет. Никогда не бросает — сбой бэкапа не должен ломать команду.
 * @param {string} dbPath
 * @param {{env?: NodeJS.ProcessEnv, now?: number, keep?: number}} [options]
 * @returns {{created: boolean, reason: string, path?: string, createdAt?: number,
 *   size?: number, removed?: string[], lastAt?: number|null, error?: string}}
 */
export function maybeBackup(dbPath, { env = process.env, now = Date.now(), keep } = {}) {
  if (isDisabled(env)) return { created: false, reason: 'disabled' };
  if (!dbPath || dbPath === ':memory:') return { created: false, reason: 'memory' };
  if (!existsSync(dbPath)) return { created: false, reason: 'missing' };

  try {
    const backups = listBackups(dbPath, env);
    const lastAt = backups.length ? backups[0].createdAt : null;
    const intervalMs = resolveInterval(env) * 1000;
    // Копия «из будущего» (сбитые часы) считается свежей — иначе шквал копий.
    if (lastAt !== null && now - lastAt < intervalMs) {
      return { created: false, reason: 'fresh', lastAt };
    }

    const result = createBackup(dbPath, { env, keep, now });
    return { created: true, reason: 'due', lastAt, ...result };
  } catch (err) {
    // Ошибку отдаём наружу, но никогда не бросаем: бэкап — фон, а не блокер.
    return { created: false, reason: 'error', error: err?.message ?? String(err) };
  }
}
