import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/core/db.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RAT_BIN = path.join(REPO_ROOT, 'bin', 'rat.mjs');

/**
 * Временный каталог + путь к базе, уникальные для одного теста.
 * @param {import('node:test').TestContext} t
 * @param {string} [prefix]
 */
export function createSandbox(t, prefix = 'rat-test-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const dbPath = path.join(dir, 'issues.db');
  let wrapper = null;

  t.after(() => {
    if (wrapper) {
      try {
        wrapper.db.close();
      } catch {
        // уже закрыта
      }
      wrapper = null;
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  return {
    dir,
    dbPath,
    open() {
      if (!wrapper) wrapper = openDb(dbPath);
      return wrapper;
    },
    close() {
      if (!wrapper) return;
      wrapper.db.close();
      wrapper = null;
    },
  };
}

/**
 * Запуск CLI в отдельном процессе на указанной базе.
 * @param {string[]} args
 * @param {{dbPath?: string, cwd?: string, env?: NodeJS.ProcessEnv, input?: string}} [options]
 */
export function runCli(args, { dbPath, cwd, env: extraEnv, input } = {}) {
  const env = buildEnv(dbPath, extraEnv);

  const result = spawnSync(process.execPath, ['--no-warnings', RAT_BIN, ...args], {
    cwd: cwd ?? REPO_ROOT,
    env,
    encoding: 'utf8',
    input,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Асинхронный запуск CLI (для проверки параллелизма).
 * @param {string[]} args
 * @param {{dbPath?: string, cwd?: string, env?: NodeJS.ProcessEnv, input?: string}} [options]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string}>}
 */
export function runCliAsync(args, { dbPath, cwd, env: extraEnv, input } = {}) {
  const env = buildEnv(dbPath, extraEnv);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', RAT_BIN, ...args], {
      cwd: cwd ?? REPO_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {
      // процесс мог закрыть stdin раньше — для теста это не ошибка
    });
    child.stdin.end(input ?? '');
  });
}

function buildEnv(dbPath, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.RAT_PROJECT;
  delete env.RAT_DB;
  delete env.RAT_ACTOR;
  delete env.FORCE_COLOR;
  if (dbPath) env.RAT_DB = dbPath;
  env.RAT_ACTOR = 'test';
  return env;
}

/**
 * Прямая вставка задачи (только для тестов и намеренной порчи базы).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [row]
 * @returns {number} внутренний id
 */
export function seedIssue(db, {
  projectKey = 'RAT',
  num = 1,
  title = 'Тестовая задача',
  body = '',
  status = 'open',
  priority = 2,
  labels = '[]',
  assignee = null,
  ref = null,
  meta = '{}',
  createdAt = Date.now(),
  updatedAt = createdAt,
} = {}) {
  const info = db
    .prepare(
      `INSERT INTO issues(
         project_key, num, title, body, status, priority, labels,
         assignee, ref, created_at, updated_at, meta
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(projectKey, num, title, body, status, priority, labels, assignee, ref, createdAt, updatedAt, meta);
  return Number(info.lastInsertRowid);
}
