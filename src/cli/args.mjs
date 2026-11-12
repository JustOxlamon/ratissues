import { UsageError } from '../core/db.mjs';

/**
 * Разбирает флаги команды. Глобальные флаги (--json/--quiet/--db/--actor)
 * сюда уже не попадают — их снимает parseGlobalFlags в index.mjs.
 *
 * Поддерживает `--flag value`, `--flag=value` и короткие алиасы вида
 * `-s value` / `-s=value` (маппинг задаётся в `aliases`). Значение `-`
 * разрешено (stdin). Флаги из `multi` можно повторять — они собираются
 * в массив. Неизвестный флаг → UsageError (exit 2).
 *
 * @param {string[]} args
 * @param {{values?: string[], booleans?: string[], aliases?: Record<string,string>, multi?: string[], hint?: string}} [spec]
 * @returns {{flags: Record<string, string|boolean|string[]>, positionals: string[]}}
 * @throws {UsageError}
 */
export function parseArgs(args, {
  values = [],
  booleans = [],
  aliases = {},
  multi = [],
  hint,
} = {}) {
  const valueFlags = new Set(values);
  const boolFlags = new Set(booleans);
  const multiFlags = new Set(multi);
  const flags = {};
  const positionals = [];
  const usageHint = hint ? { hint } : {};

  for (let i = 0; i < args.length; i += 1) {
    let arg = args[i];

    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }

    const short = /^-([A-Za-z])(=.*)?$/.exec(arg);
    if (short && Object.hasOwn(aliases, short[1])) {
      arg = `--${aliases[short[1]]}${short[2] ?? ''}`;
    }

    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);

    if (boolFlags.has(name)) {
      if (eq !== -1) {
        throw new UsageError(`Флаг --${name} не принимает значения.`, {
          code: 'unexpected_flag_value',
          ...usageHint,
        });
      }
      flags[name] = true;
      continue;
    }

    if (!valueFlags.has(name)) {
      throw new UsageError(`Неизвестный флаг --${name}.`, {
        code: 'unknown_flag',
        ...usageHint,
      });
    }

    let value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`Флаг --${name} требует значения.`, {
          code: 'missing_flag_value',
          ...usageHint,
        });
      }
      value = next;
      i += 1;
    }

    if (value === '') {
      throw new UsageError(`Флаг --${name} требует значения.`, {
        code: 'missing_flag_value',
        ...usageHint,
      });
    }

    if (multiFlags.has(name)) {
      const list = Array.isArray(flags[name]) ? flags[name] : [];
      list.push(value);
      flags[name] = list;
      continue;
    }
    flags[name] = value;
  }

  return { flags, positionals };
}

/**
 * Читает stdin целиком как UTF-8. Используется для `--body -`, `--title -`
 * и комментария без текста.
 * @param {NodeJS.ReadableStream|null|undefined} stream
 * @returns {Promise<string>}
 */
export async function readStdinText(stream) {
  if (!stream) return '';
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Убирает один завершающий перевод строки (stdin от `echo`/`printf`).
 * @param {string} text
 * @returns {string}
 */
export function trimTrailingNewline(text) {
  return text.replace(/\r?\n$/, '');
}
