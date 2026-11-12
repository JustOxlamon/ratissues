import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';

import { createApiHandler } from './api.mjs';

/**
 * http.mjs — node:http сервер: JSON API + статика web/.
 * Только loopback (проверка --host в CLI), Cache-Control: no-store для API.
 */

const BODY_LIMIT_BYTES = 1 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/**
 * @param {object} options
 * @param {{db: import('node:sqlite').DatabaseSync}} options.wrapper
 * @param {string} options.webDir
 * @param {boolean} [options.quiet]
 * @returns {import('node:http').Server}
 */
export function createServer({ wrapper, webDir, quiet = false }) {
  const { handler: api, close: closeApi } = createApiHandler(wrapper);
  const resolvedWebDir = path.resolve(webDir);

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    try {
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url, `http://${host}`);

      if (url.pathname.startsWith('/api/')) {
        await api(req, res, url);
      } else {
        await serveStatic(req, res, url, resolvedWebDir);
      }
    } catch (err) {
      if (!res.headersSent) {
        const body = JSON.stringify({
          error: { code: 'internal_error', message: err?.message ?? String(err) },
        });
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
      }
    } finally {
      if (!quiet) logRequest(req, res, Date.now() - start);
    }
  });

  server.on('close', () => {
    closeApi();
  });

  return server;
}

async function serveStatic(req, res, url, webDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendStaticError(res, 405, 'method_not_allowed', 'Метод не поддерживается.');
    return;
  }

  let relative = decodeURIComponent(url.pathname);
  if (relative === '/' || relative === '') relative = '/index.html';
  if (relative.includes('\0')) {
    sendStaticError(res, 400, 'invalid_path', 'Некорректный путь.');
    return;
  }

  const target = path.resolve(path.join(webDir, relative.replace(/^\/+/, '')));
  if (!isInside(target, webDir)) {
    sendStaticError(res, 404, 'not_found', 'Файл не найден.');
    return;
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    sendStaticError(res, 404, 'not_found', 'Файл не найден.');
    return;
  }

  if (info.isDirectory()) {
    sendStaticError(res, 404, 'not_found', 'Файл не найден.');
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': info.size,
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(target);
  stream.pipe(res);
  await new Promise((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

function sendStaticError(res, status, code, message) {
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function isInside(file, dir) {
  const relative = path.relative(dir, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function logRequest(req, res, duration) {
  const status = res.statusCode ?? 0;
  const line = `${req.method} ${req.url} ${status} ${duration}ms`;
  process.stderr.write(`${line}\n`);
}

export { BODY_LIMIT_BYTES };
