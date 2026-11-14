/** ANSI-цвета статусов (PLAN §5: open lime, doing sky, blocked amber, deferred violet, done emerald, cancelled rose). */
export const STATUS_COLORS = Object.freeze({
  open: 92,
  doing: 36,
  blocked: 33,
  deferred: 35,
  done: 32,
  cancelled: 31,
});

const PROJECT_COLORS = Object.freeze({
  lime: 92,
  sky: 36,
  amber: 33,
  emerald: 32,
  rose: 31,
  zinc: 90,
  slate: 90,
  violet: 35,
  blue: 34,
  red: 31,
  green: 32,
  orange: 33,
  teal: 36,
});

/**
 * Включать ли цвет: --quiet и не-tty его выключают, NO_COLOR уважается,
 * FORCE_COLOR позволяет включить принудительно.
 * @param {{stdout?: NodeJS.WritableStream}} io
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function useColor(io, env = process.env) {
  if (env && Object.hasOwn(env, 'NO_COLOR')) return false;
  if (env?.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') {
    return true;
  }
  return Boolean(io?.stdout?.isTTY);
}

/**
 * Оборачивает текст ANSI-кодом, если цвет включён.
 * @param {string} text
 * @param {number|null|undefined} code
 * @param {boolean} enabled
 * @returns {string}
 */
export function paint(text, code, enabled) {
  if (!enabled || code === null || code === undefined) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

/**
 * Цвет проекта по слагу палитры (hex оставляет без цвета).
 * @param {string|null|undefined} color
 * @param {boolean} enabled
 * @returns {number|null}
 */
export function projectColorCode(color) {
  if (typeof color !== 'string') return null;
  return PROJECT_COLORS[color.toLowerCase()] ?? null;
}

/**
 * epoch ms → «YYYY-MM-DD HH:MM» (UTC, детерминированно).
 * @param {number|null|undefined} ts
 * @returns {string}
 */
export function formatTs(ts) {
  if (ts === null || ts === undefined || !Number.isFinite(Number(ts))) return '—';
  const iso = new Date(Number(ts)).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Возраст в компактном виде: 0m, 5m, 3h, 12d, 2y.
 * @param {number|null|undefined} ts epoch ms
 * @param {number} [now]
 * @returns {string}
 */
export function formatAge(ts, now = Date.now()) {
  if (ts === null || ts === undefined || !Number.isFinite(Number(ts))) return '—';
  const diff = Math.max(0, Number(now) - Number(ts));
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const year = 365 * day;
  if (diff < minute) return '0m';
  if (diff < hour) return `${Math.floor(diff / minute)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  if (diff < year) return `${Math.floor(diff / day)}d`;
  return `${Math.floor(diff / year)}y`;
}

/**
 * Подпись события для человекочитаемой ленты.
 * @param {{kind:string, actor:string, data:object|null}} event
 * @returns {string}
 */
export function describeEvent(event) {
  const data = event.data ?? {};
  switch (event.kind) {
    case 'created':
      return 'создана';
    case 'status': {
      const reason = data.reason ? ` — ${data.reason}` : '';
      return `статус: ${data.from ?? '?'} → ${data.to ?? '?'}${reason}`;
    }
    case 'claim':
      return `взята в работу: ${data.assignee ?? event.actor}`;
    case 'comment':
      return String(data.text ?? '');
    case 'edit':
      if (data.field) return `правка ${data.field}: ${data.from ?? '—'} → ${data.to ?? '—'}`;
      return 'правка';
    case 'link':
      return `связь: ${data.ref ?? data.url ?? JSON.stringify(data)}`;
    default:
      return JSON.stringify(data);
  }
}
