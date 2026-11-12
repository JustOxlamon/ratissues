import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { formatStamp, parseDuration, parseStampFromName } from '../src/core/backup.mjs';
import { openDb } from '../src/core/db.mjs';
import { createSandbox, runCli } from './helpers.mjs';

/**
 * Копии в песочнице (сортировка по имени = по времени).
 * @param {string} dir
 * @returns {string[]}
 */
function backupFiles(dir) {
  const backupsDir = path.join(dir, 'backups');
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir).sort();
}

/** Создаёт «старую» копию с заданной меткой, чтобы проверить интервал/ротацию. */
function seedBackup(dir, createdAt) {
  const backupsDir = path.join(dir, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const name = `issues-${formatStamp(createdAt)}.db`;
  copyFileSync(path.join(dir, 'issues.db'), path.join(backupsDir, name));
  return path.join(backupsDir, name);
}

/** Сколько задач в базе (открывает её на чтение и закрывает). */
function countIssues(dbPath) {
  const wrapper = openDb(dbPath);
  try {
    return wrapper.db.prepare('SELECT count(*) AS c FROM issues').get().c;
  } finally {
    wrapper.db.close();
  }
}

test('автобекап: копия создаётся перед записью и не содержит её', (t) => {
  const box = createSandbox(t);
  const init = runCli(['init'], { dbPath: box.dbPath });
  assert.equal(init.code, 0, init.stderr);
  assert.deepEqual(backupFiles(box.dir), [], 'init не должен бэкапить несуществующую базу');

  const add = runCli(['add', 'первая задача', '--project', 'RAT'], {
    dbPath: box.dbPath,
    env: { RAT_BACKUP: 'on' },
  });
  assert.equal(add.code, 0, add.stderr);

  const files = backupFiles(box.dir);
  assert.equal(files.length, 1, `ожидалась одна копия, есть: ${files.join(', ')}`);
  assert.equal(countIssues(box.dbPath), 1);
  assert.equal(countIssues(path.join(box.dir, 'backups', files[0])), 0, 'копия снята до вставки');
});

test('автобекап: повторный вызов внутри интервала копию не делает', (t) => {
  const box = createSandbox(t);
  runCli(['init'], { dbPath: box.dbPath });
  const env = { RAT_BACKUP: 'on', RAT_BACKUP_INTERVAL: '24h' };
  runCli(['ls'], { dbPath: box.dbPath, env });

  const before = backupFiles(box.dir);
  const again = runCli(['ls', '--json'], { dbPath: box.dbPath, env });
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(backupFiles(box.dir), before, 'второй вызов не должен добавлять копию');
});

test('автобекап: копия из прошлого запускает новую', (t) => {
  const box = createSandbox(t);
  runCli(['init'], { dbPath: box.dbPath });
  const old = seedBackup(box.dir, Date.now() - 3 * 24 * 60 * 60 * 1000);

  const result = runCli(['ls'], {
    dbPath: box.dbPath,
    env: { RAT_BACKUP: 'on', RAT_BACKUP_INTERVAL: '24h' },
  });
  assert.equal(result.code, 0, result.stderr);

  const files = backupFiles(box.dir);
  assert.equal(files.length, 2, `ожидались старая и новая копии, есть: ${files.join(', ')}`);
  assert.ok(!files.includes(path.basename(old)) === false, 'старая копия должна остаться');
});

test('автобекап: RAT_BACKUP=off и --no-backup отключают копии', (t) => {
  const offBox = createSandbox(t);
  runCli(['init'], { dbPath: offBox.dbPath });
  const off = runCli(['add', 'без копии', '--project', 'RAT'], {
    dbPath: offBox.dbPath,
    env: { RAT_BACKUP: 'off' },
  });
  assert.equal(off.code, 0, off.stderr);
  assert.deepEqual(backupFiles(offBox.dir), []);

  const flagBox = createSandbox(t);
  runCli(['init'], { dbPath: flagBox.dbPath });
  const withFlag = runCli(['add', 'без копии', '--no-backup'], {
    dbPath: flagBox.dbPath,
    env: { RAT_BACKUP: 'on' },
  });
  assert.equal(withFlag.code, 0, withFlag.stderr);
  assert.deepEqual(backupFiles(flagBox.dir), []);
});

test('автобекап: ротация оставляет RAT_BACKUP_KEEP свежих копий', (t) => {
  const box = createSandbox(t);
  runCli(['init'], { dbPath: box.dbPath });
  const now = Date.now();
  seedBackup(box.dir, now - 5 * 24 * 60 * 60 * 1000);
  seedBackup(box.dir, now - 4 * 24 * 60 * 60 * 1000);
  seedBackup(box.dir, now - 3 * 24 * 60 * 60 * 1000);
  assert.equal(backupFiles(box.dir).length, 3);

  const result = runCli(['ls'], {
    dbPath: box.dbPath,
    env: { RAT_BACKUP: 'on', RAT_BACKUP_KEEP: '2' },
  });
  assert.equal(result.code, 0, result.stderr);

  const files = backupFiles(box.dir);
  assert.equal(files.length, 2, `после ротации ожидались 2 файла: ${files.join(', ')}`);
});

test('автобекап: сбой копии не ломает команду (только предупреждение)', (t) => {
  const box = createSandbox(t);
  runCli(['init'], { dbPath: box.dbPath });
  // Каталогом копий назначаем файл — создать копию невозможно.
  const blocker = path.join(box.dir, 'not-a-dir');
  writeFileSync(blocker, 'x');

  const result = runCli(['ls', '--json'], {
    dbPath: box.dbPath,
    env: { RAT_BACKUP: 'on', RAT_BACKUP_DIR: blocker },
  });
  assert.equal(result.code, 0, 'ошибка бэкапа не должна менять код выхода');
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.match(result.stderr, /резервная копия не создана/i);
});

test('rat backup: создаёт копию и показывает историю в --json', (t) => {
  const box = createSandbox(t);
  runCli(['init'], { dbPath: box.dbPath });
  runCli(['add', 'задача', '--project', 'RAT'], { dbPath: box.dbPath });

  const manual = runCli(['backup', '--json'], { dbPath: box.dbPath });
  assert.equal(manual.code, 0, manual.stderr);
  const payload = JSON.parse(manual.stdout);
  assert.equal(payload.ok, true);
  assert.ok(existsSync(payload.path));
  assert.equal(payload.keep, 7);
  assert.equal(countIssues(payload.path), 1, 'ручная копия снимается после записи');

  const list = runCli(['backup', '--list', '--json'], { dbPath: box.dbPath });
  assert.equal(list.code, 0, list.stderr);
  const history = JSON.parse(list.stdout);
  assert.equal(history.dir, path.join(box.dir, 'backups'));
  assert.equal(history.keep, 7);
  assert.equal(history.interval_seconds, 24 * 60 * 60);
  assert.equal(history.backups.length, 1);
  assert.ok(typeof history.backups[0].created_at === 'number');
  assert.ok(history.backups[0].size > 0);
});

test('rat backup: --list на пустом каталоге и на несуществующей базе', (t) => {
  const box = createSandbox(t);
  runCli(['init'], { dbPath: box.dbPath });

  const empty = runCli(['backup', '--list'], { dbPath: box.dbPath });
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /Копий нет/);

  const missing = runCli(['backup'], { dbPath: path.join(box.dir, 'nope.db') });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /База не найдена/);
});

test('backup: parseDuration понимает единицы и мусор', () => {
  assert.equal(parseDuration('24h', 42), 86400);
  assert.equal(parseDuration('90m', 42), 5400);
  assert.equal(parseDuration('30s', 42), 30);
  assert.equal(parseDuration('1d', 42), 86400);
  assert.equal(parseDuration('3600', 42), 3600);
  assert.equal(parseDuration('0', 42), 0);
  assert.equal(parseDuration('чепуха', 42), 42);
  assert.equal(parseDuration(undefined, 42), 42);
});

test('backup: метка времени в имени файла разбирается обратно', () => {
  const ms = new Date(2026, 10, 12, 23, 32, 51, 276).getTime();
  const name = `issues-${formatStamp(ms)}.db`;
  assert.equal(name, 'issues-20261112-233251-276.db');
  assert.equal(parseStampFromName(name, 'issues'), ms);
  assert.equal(parseStampFromName('issues-чужое.db', 'issues'), null);
  assert.equal(parseStampFromName(name, 'other'), null);
});
