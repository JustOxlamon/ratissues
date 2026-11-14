import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import path from 'node:path';

import {
  ensureSchemaCurrent,
  EXIT_CODES,
  getSchemaVersion,
  REPO_ROOT,
  UsageError,
} from '../../core/db.mjs';
import { initDatabase } from '../../core/store.mjs';
import { createServer } from '../../server/http.mjs';
import { parseArgs } from '../args.mjs';

export const meta = {
  name: 'serve',
  summary: 'запустить web UI и JSON API',
  usage: 'rat serve [--port 4711] [--host 127.0.0.1] [--open] [--quiet]',
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * `rat serve` — локальный HTTP-сервер (только loopback).
 * @param {object} ctx контекст CLI
 * @returns {Promise<number>} exit code
 */
export async function run(ctx) {
  const { flags, positionals } = parseArgs(ctx.args, {
    values: ['port', 'host'],
    booleans: ['open'],
    hint: meta.usage,
  });

  if (positionals.length) {
    throw new UsageError(`serve не принимает аргументов: ${positionals.join(' ')}`, {
      code: 'unexpected_argument',
      hint: meta.usage,
    });
  }

  const host = flags.host ?? '127.0.0.1';
  const port = parsePort(flags.port ?? '4711');

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new UsageError(
      `serve: --host ${host} не разрешён. Допустимо: 127.0.0.1, localhost, ::1.`,
      { code: 'invalid_host' },
    );
  }

  const wrapper = ctx.openDatabase();
  if (getSchemaVersion(wrapper) === 0) {
    const report = initDatabase(wrapper);
    if (!ctx.flags.quiet) ctx.print(`База инициализирована: ${report.path}`);
  } else {
    ensureSchemaCurrent(wrapper);
  }

  const webDir = path.join(REPO_ROOT, 'web');
  const server = createServer({ wrapper, webDir, quiet: ctx.flags.quiet });

  try {
    await listen(server, port, host);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      ctx.printError(`Порт ${port} уже занят.`);
      return EXIT_CODES.DB;
    }
    throw err;
  }

  const address = server.address();
  const displayHost = host === '::1' ? '[::1]' : host;
  const url = `http://${displayHost}:${address.port}`;
  if (!ctx.flags.quiet) ctx.print(`Сервер слушает ${url}`);

  if (flags.open) openBrowser(url);

  await new Promise((resolve) => {
    const close = () => {
      server.close(() => resolve());
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });

  return EXIT_CODES.OK;
}

function parsePort(value) {
  const port = Number(String(value).trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`serve: --port должно быть целым числом 0..65535.`, {
      code: 'invalid_port',
    });
  }
  return port;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function openBrowser(url) {
  const system = platform();
  let command;
  let args;
  if (system === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (system === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // игнорируем ошибки открытия браузера
    });
    child.unref();
  } catch {
    // ignore
  }
}
