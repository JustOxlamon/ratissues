import {
  EXIT_CODES,
  openDb,
  RatError,
  resolveDbPath,
  UsageError,
} from '../core/db.mjs';
import * as addCommand from './commands/add.mjs';
import * as claimCommand from './commands/claim.mjs';
import * as commentCommand from './commands/comment.mjs';
import * as doctorCommand from './commands/doctor.mjs';
import * as editCommand from './commands/edit.mjs';
import * as exportCommand from './commands/export.mjs';
import * as initCommand from './commands/init.mjs';
import * as logCommand from './commands/log.mjs';
import * as lsCommand from './commands/ls.mjs';
import * as nextCommand from './commands/next.mjs';
import * as projectCommand from './commands/project.mjs';
import * as serveCommand from './commands/serve.mjs';
import * as showCommand from './commands/show.mjs';
import * as statsCommand from './commands/stats.mjs';
import * as statusCommand from './commands/status.mjs';

const COMMAND_MODULES = [
  initCommand,
  doctorCommand,
  projectCommand,
  addCommand,
  lsCommand,
  showCommand,
  editCommand,
  statusCommand,
  ...Object.values(statusCommand.aliases),
  claimCommand,
  commentCommand,
  nextCommand,
  logCommand,
  statsCommand,
  exportCommand,
  serveCommand,
];

/** Реализованные команды. Список в help строится отсюда. */
export const COMMANDS = new Map(COMMAND_MODULES.map((command) => [command.meta.name, command]));

/**
 * Точка входа CLI.
 * @param {string[]} argv аргументы без node и пути к скрипту
 * @param {{stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv, cwd?: string}} [context]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2), context = {}) {
  const io = {
    stdout: context.stdout ?? process.stdout,
    stderr: context.stderr ?? process.stderr,
    stdin: context.stdin ?? process.stdin,
    env: context.env ?? process.env,
    cwd: context.cwd ?? process.cwd(),
  };

  let parsed;
  try {
    parsed = parseGlobalFlags(argv);
  } catch (err) {
    return reportError(err, { json: argv.includes('--json') }, io);
  }
  const { flags, rest } = parsed;

  if (flags.help) {
    printHelp(io.stdout, rest[0]);
    return EXIT_CODES.OK;
  }

  const commandName = rest[0];
  if (!commandName) {
    printHelp(io.stderr);
    return EXIT_CODES.USAGE;
  }

  const command = COMMANDS.get(commandName);
  if (!command) {
    const error = new UsageError(`Неизвестная команда «${commandName}».`, {
      code: 'unknown_command',
      hint: `Доступно: ${[...COMMANDS.keys()].join(', ')}`,
    });
    if (flags.json) io.stderr.write(`${JSON.stringify(errorPayload(error))}\n`);
    else {
      io.stderr.write(`Ошибка: ${error.message}\n\n`);
      printHelp(io.stderr);
    }
    return EXIT_CODES.USAGE;
  }

  const dbPath = resolveDbPath(flags.db, io.env);
  let wrapper = null;

  const ctx = {
    command: commandName,
    args: rest.slice(1),
    flags,
    io,
    env: io.env,
    cwd: io.cwd,
    dbPath,
    /** Лениво открывает базу (создаёт каталог/файл при необходимости). */
    openDatabase() {
      if (!wrapper) wrapper = openDb(dbPath);
      return wrapper;
    },
    /** Закрывает коннект, если он был открыт. */
    closeDatabase() {
      if (!wrapper) return;
      try {
        wrapper.db.close();
      } catch {
        // уже закрыта
      }
      wrapper = null;
    },
    print(text) {
      const value = String(text);
      io.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
    },
    printJson(value) {
      io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },
    printError(text) {
      io.stderr.write(`${text}\n`);
    },
  };

  try {
    const code = await command.run(ctx);
    return Number.isInteger(code) ? code : EXIT_CODES.OK;
  } catch (err) {
    return reportError(err, flags, io);
  } finally {
    ctx.closeDatabase();
  }
}

/**
 * Разбирает глобальные флаги в любом месте argv.
 * Командные флаги остаются в rest нетронутыми.
 * @param {string[]} argv
 * @returns {{flags: {json:boolean, quiet:boolean, help:boolean, db:string|null, actor:string|null}, rest: string[]}}
 */
export function parseGlobalFlags(argv) {
  const flags = { json: false, quiet: false, help: false, db: null, actor: null };
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    if (arg === '--quiet') {
      flags.quiet = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--db' || arg.startsWith('--db=')) {
      const { value, consumed } = readFlagValue(argv, i, '--db');
      flags.db = value;
      i += consumed;
      continue;
    }
    if (arg === '--actor' || arg.startsWith('--actor=')) {
      const { value, consumed } = readFlagValue(argv, i, '--actor');
      flags.actor = value;
      i += consumed;
      continue;
    }
    rest.push(arg);
  }

  return { flags, rest };
}

function readFlagValue(argv, index, name) {
  const arg = argv[index];
  const eq = arg.indexOf('=');
  if (eq !== -1) {
    const value = arg.slice(eq + 1);
    if (value === '') {
      throw new UsageError(`Флаг ${name} требует значения.`, { code: 'missing_flag_value' });
    }
    return { value, consumed: 0 };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new UsageError(`Флаг ${name} требует значения.`, { code: 'missing_flag_value' });
  }
  return { value: next, consumed: 1 };
}

function reportError(err, flags, io) {
  const known = err instanceof RatError;
  const exitCode = known ? err.exitCode : EXIT_CODES.DB;
  const payload = errorPayload(err);

  if (flags.json) {
    io.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    let text = `Ошибка: ${payload.error.message}`;
    if (payload.error.hint) text += `\nПодсказка: ${payload.error.hint}`;
    io.stderr.write(`${text}\n`);
  }
  return exitCode;
}

function errorPayload(err) {
  const known = err instanceof RatError;
  return {
    error: {
      code: known ? err.code : 'internal_error',
      message: err?.message ?? String(err),
      ...(known && err.hint ? { hint: err.hint } : {}),
    },
  };
}

/**
 * Печатает справку. Если передана реализованная команда — её usage.
 * @param {NodeJS.WritableStream} stream
 * @param {string} [commandName]
 */
export function printHelp(stream, commandName) {
  const command = commandName ? COMMANDS.get(commandName) : undefined;
  if (command) {
    stream.write(
      [
        `${command.meta.name} — ${command.meta.summary}`,
        '',
        `Использование: ${command.meta.usage}`,
        '',
      ].join('\n'),
    );
    return;
  }

  const lines = [
    'rat — локальный трекер задач',
    '',
    'Использование:',
    '  rat <команда> [аргументы] [флаги]',
    '',
    'Команды:',
  ];
  for (const [, commandModule] of COMMANDS) {
    lines.push(`  ${commandModule.meta.name.padEnd(8)} ${commandModule.meta.summary}`);
  }
  lines.push(
    '',
    'Глобальные флаги:',
    '  --json          машиночитаемый вывод',
    '  --db <path>     путь к базе (иначе $RAT_DB или data/issues.db)',
    '  --actor <name>  автор событий (иначе $RAT_ACTOR или cli)',
    '  --quiet         минимальный вывод',
    '  -h, --help      эта справка',
    '',
    'Коды выхода: 0 ok, 1 не найдено, 2 ошибка использования, 3 конфликт, 4 ошибка БД',
  );
  stream.write(`${lines.join('\n')}\n`);
}
