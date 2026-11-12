import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Корень репозитория (не зависит от cwd). */
export const REPO_ROOT = path.resolve(CORE_DIR, '..', '..');

/** База по умолчанию: <repo>/data/issues.db. */
export const DEFAULT_DB_PATH = path.join(REPO_ROOT, 'data', 'issues.db');

/** Текущая версия схемы; значение лежит в meta(schema_version). */
export const SCHEMA_VERSION = 1;

/** Коды выхода CLI (PLAN §4). */
export const EXIT_CODES = Object.freeze({
  OK: 0,
  NOT_FOUND: 1,
  USAGE: 2,
  CONFLICT: 3,
  DB: 4,
});

/**
 * Базовая ошибка приложения. CLI отдаёт err.exitCode, API — err.code.
 */
export class RatError extends Error {
  constructor(message, { code = 'error', exitCode = EXIT_CODES.DB, hint } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    if (hint) this.hint = hint;
  }
}

/** Ошибка слоя БД: коннект, миграции, запросы. Exit code 4. */
export class DbError extends RatError {
  constructor(message, { code = 'db_error', cause, hint } = {}) {
    super(message, { code, exitCode: EXIT_CODES.DB, hint });
    if (cause) this.cause = cause;
  }
}

/** Неверные аргументы/флаги. Exit code 2. */
export class UsageError extends RatError {
  constructor(message, { code = 'usage_error', hint } = {}) {
    super(message, { code, exitCode: EXIT_CODES.USAGE, hint });
  }
}

/** Сущность не найдена. Exit code 1. */
export class NotFoundError extends RatError {
  constructor(message, { code = 'not_found', hint } = {}) {
    super(message, { code, exitCode: EXIT_CODES.NOT_FOUND, hint });
  }
}

/** Конфликт перехода/состояния. Exit code 3. */
export class ConflictError extends RatError {
  constructor(message, { code = 'conflict', hint } = {}) {
    super(message, { code, exitCode: EXIT_CODES.CONFLICT, hint });
  }
}

/**
 * Путь к базе: --db → $RAT_DB → <repo>/data/issues.db.
 * Относительные пути разворачиваются от cwd (как обычный CLI-путь).
 * @param {string|undefined|null} flagValue значение флага --db
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} абсолютный путь или ':memory:'
 */
export function resolveDbPath(flagValue, env = process.env) {
  const raw = firstNonEmpty(flagValue, env?.RAT_DB) ?? DEFAULT_DB_PATH;
  if (raw === ':memory:') return raw;
  return path.resolve(raw);
}

/**
 * Открывает базу и применяет pragma на этом коннекте.
 * @param {string} [dbPath] путь (по умолчанию DEFAULT_DB_PATH)
 * @returns {{db: DatabaseSync, path: string, hasFts5: boolean}}
 * @throws {DbError} если базу не удалось открыть
 */
export function openDb(dbPath = DEFAULT_DB_PATH) {
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new UsageError('Путь к базе не задан.', { code: 'invalid_db_path' });
  }
  const fullPath = dbPath === ':memory:' ? ':memory:' : path.resolve(dbPath);
  try {
    if (fullPath !== ':memory:') mkdirSync(path.dirname(fullPath), { recursive: true });
    const db = new DatabaseSync(fullPath);
    applyPragmas(db);
    return { db, path: fullPath, hasFts5: detectFts5(db) };
  } catch (err) {
    throw asDbError(err, `Не удалось открыть базу «${fullPath}»`, 'open_failed');
  }
}

/**
 * Возвращает сырой DatabaseSync из обёртки openDb (или сам объект, если это уже база).
 * @param {{db: DatabaseSync}|DatabaseSync} wrapperOrDb
 * @returns {DatabaseSync}
 */
export function unwrapDb(wrapperOrDb) {
  if (wrapperOrDb && typeof wrapperOrDb === 'object' && wrapperOrDb.db) return wrapperOrDb.db;
  return wrapperOrDb;
}

/**
 * Закрывает коннект. Повторный вызов безопасен.
 * @param {{db: DatabaseSync}|DatabaseSync} wrapperOrDb
 */
export function closeDb(wrapperOrDb) {
  const db = unwrapDb(wrapperOrDb);
  if (!db) return;
  try {
    db.close();
  } catch {
    // соединение уже закрыто — не ошибка
  }
}

/**
 * Выполняет fn внутри транзакции. Вложенные транзакции не поддерживаются.
 * @template T
 * @param {{db: DatabaseSync}|DatabaseSync} wrapperOrDb
 * @param {() => T} fn
 * @param {'IMMEDIATE'|'DEFERRED'|'EXCLUSIVE'} [mode]
 * @returns {T}
 */
export function transaction(wrapperOrDb, fn, mode = 'IMMEDIATE') {
  const db = unwrapDb(wrapperOrDb);
  if (!['IMMEDIATE', 'DEFERRED', 'EXCLUSIVE'].includes(mode)) {
    throw new UsageError(`Неизвестный режим транзакции: ${mode}`, { code: 'invalid_tx_mode' });
  }
  db.exec(`BEGIN ${mode}`);
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // транзакция уже откатилась
    }
    throw err instanceof RatError ? err : asDbError(err, 'Ошибка транзакции', 'transaction_failed');
  }
}

/**
 * Значение из meta по ключу.
 * @param {{db: DatabaseSync}|DatabaseSync} wrapperOrDb
 * @param {string} key
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
export function readMeta(wrapperOrDb, key, fallback = null) {
  const db = unwrapDb(wrapperOrDb);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row === undefined ? fallback : row.value;
}

/**
 * Версия схемы (0, если база ещё не инициализирована).
 * @param {{db: DatabaseSync}|DatabaseSync} wrapperOrDb
 * @returns {number}
 */
export function getSchemaVersion(wrapperOrDb) {
  const db = unwrapDb(wrapperOrDb);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const version = row ? Number(row.value) : 0;
    return Number.isFinite(version) ? version : 0;
  } catch {
    return 0;
  }
}

/**
 * Есть ли таблица/виртуальная таблица с таким именем.
 * @param {{db: DatabaseSync}|DatabaseSync} wrapperOrDb
 * @param {string} name
 * @returns {boolean}
 */
export function tableExists(wrapperOrDb, name) {
  const db = unwrapDb(wrapperOrDb);
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(name);
  return Boolean(row);
}

/**
 * Идемпотентные миграции. Создаёт meta, при необходимости — остальную схему
 * и (если сборка умеет FTS5) issues_fts с триггерами.
 * @param {{db: DatabaseSync}|DatabaseSync} wrapperOrDb
 * @returns {{schemaVersion: number, hasFts5: boolean}}
 * @throws {DbError} если база создана более новой версией rat
 */
export function migrate(wrapperOrDb) {
  const db = unwrapDb(wrapperOrDb);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    )`);
  } catch (err) {
    throw asDbError(err, 'Не удалось создать таблицу meta', 'migrate_failed');
  }

  let version = getSchemaVersion(wrapperOrDb);
  if (version > SCHEMA_VERSION) {
    throw new DbError(
      `Версия схемы базы (${version}) новее, чем поддерживает этот rat (${SCHEMA_VERSION}).`,
      { code: 'schema_too_new', hint: 'Обновите rat или укажите другую базу через --db.' },
    );
  }

  for (const migration of MIGRATIONS) {
    if (version >= migration.version) continue;
    try {
      transaction(db, () => {
        migration.up(db);
        writeMeta(db, 'schema_version', migration.version);
      }, 'IMMEDIATE');
    } catch (err) {
      throw err instanceof RatError
        ? err
        : asDbError(err, `Миграция v${migration.version} не удалась`, 'migrate_failed');
    }
    version = migration.version;
  }

  const hasFts5 = ensureFts(wrapperOrDb, db);
  return { schemaVersion: version, hasFts5 };
}

// ---------------------------------------------------------------------------

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(BASE_SCHEMA_SQL);
    },
  },
];

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  root_path   TEXT,
  color       TEXT NOT NULL DEFAULT 'zinc',
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS issues (
  id           INTEGER PRIMARY KEY,
  project_key  TEXT NOT NULL REFERENCES projects(key),
  num          INTEGER NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','doing','blocked','done','cancelled')),
  priority     INTEGER NOT NULL DEFAULT 2
               CHECK (priority BETWEEN 0 AND 3),
  labels       TEXT NOT NULL DEFAULT '[]',
  assignee     TEXT,
  ref          TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  close_reason TEXT,
  meta         TEXT NOT NULL DEFAULT '{}',
  UNIQUE (project_key, num)
);

CREATE INDEX IF NOT EXISTS idx_issues_project_status
  ON issues(project_key, status, priority);
CREATE INDEX IF NOT EXISTS idx_issues_status_updated
  ON issues(status, updated_at);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  ts       INTEGER NOT NULL,
  actor    TEXT NOT NULL,
  kind     TEXT NOT NULL
           CHECK (kind IN ('created','status','comment','edit','link','claim')),
  data     TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_issue_ts ON events(issue_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`;

const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
  title,
  body,
  labels,
  content='issues',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS issues_fts_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, title, body, labels)
  VALUES (new.id, new.title, new.body, new.labels);
END;

CREATE TRIGGER IF NOT EXISTS issues_fts_ad AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, body, labels)
  VALUES ('delete', old.id, old.title, old.body, old.labels);
END;

CREATE TRIGGER IF NOT EXISTS issues_fts_au AFTER UPDATE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, body, labels)
  VALUES ('delete', old.id, old.title, old.body, old.labels);
  INSERT INTO issues_fts(rowid, title, body, labels)
  VALUES (new.id, new.title, new.body, new.labels);
END;
`;

function ensureFts(wrapperOrDb, db) {
  const holder = wrapperOrDb && typeof wrapperOrDb === 'object' && wrapperOrDb.db ? wrapperOrDb : null;
  const supported = holder ? Boolean(holder.hasFts5) : detectFts5(db);

  if (!supported) {
    if (holder) holder.hasFts5 = false;
    try {
      writeMeta(db, 'fts5', '0');
    } catch {
      // meta может отсутствовать при экзотическом сбое — не критично
    }
    return false;
  }

  try {
    const existed = tableExists(db, 'issues_fts');
    transaction(db, () => {
      db.exec(FTS_SCHEMA_SQL);
      if (!existed) db.exec("INSERT INTO issues_fts(issues_fts) VALUES('rebuild')");
    }, 'IMMEDIATE');
    writeMeta(db, 'fts5', '1');
    if (holder) holder.hasFts5 = true;
    return true;
  } catch {
    // сборка без FTS5 или ошибка создания — работаем через LIKE
    if (holder) holder.hasFts5 = false;
    try {
      writeMeta(db, 'fts5', '0');
    } catch {
      // см. выше
    }
    return false;
  }
}

function writeMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

function applyPragmas(db) {
  // busy_timeout — первым: переключение journal_mode ниже берёт блокировку,
  // а параллельные процессы не должны падать с «database is locked».
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
}

function detectFts5(db) {
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.__rat_fts5_probe USING fts5(x)');
    db.exec('DROP TABLE IF EXISTS temp.__rat_fts5_probe');
    return true;
  } catch {
    return false;
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function asDbError(err, message, code) {
  if (err instanceof RatError) return err;
  return new DbError(`${message}: ${err?.message ?? err}`, { code, cause: err });
}
