import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  buildExport,
  defaultExportPath,
  EXPORTS_DIR,
  exportJsonl,
  exportMarkdown,
  writeExportFile,
} from '../src/core/export.mjs';
import {
  addComment,
  archiveProject,
  changeStatus,
  claimIssue,
  createIssue,
  createProject,
  initDatabase,
} from '../src/core/store.mjs';
import { createSandbox, REPO_ROOT, runCli } from './helpers.mjs';

const ISSUE_FIELD_ORDER = [
  'id',
  'project',
  'num',
  'title',
  'body',
  'status',
  'priority',
  'labels',
  'assignee',
  'ref',
  'created_at',
  'updated_at',
  'closed_at',
  'close_reason',
  'meta',
];

const EVENT_FIELD_ORDER = ['id', 'issue', 'project', 'ts', 'actor', 'kind', 'data'];

function setup(t, prefix = 'rat-m3-export-') {
  const box = createSandbox(t, prefix);
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });
  return { box, wrapper, dbPath: box.dbPath };
}

/** Блок задачи: от `### ID ` до следующего заголовка того же/верхнего уровня. */
function issueBlock(markdown, id) {
  const marker = `### ${id} `;
  const start = markdown.indexOf(marker);
  assert.notEqual(start, -1, `в md нет задачи ${id}`);
  const rest = markdown.slice(start + marker.length);
  const next = rest.search(/\n##+ /);
  return next === -1 ? rest : rest.slice(0, next);
}

function parsedLines(content) {
  return content.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

test('exportMarkdown: заголовок, порядок секций, метаданные, fenced body и 10 событий', (t) => {
  const { wrapper } = setup(t);

  const p2 = createIssue(wrapper, {
    title: 'P2-задача',
    priority: 2,
    labels: 'ui,bug',
    assignee: 'agent:pickle',
    ref: 'src/a.mjs',
    body: 'Тело с примером:\n\n```js\nconst x = "кавычки";\n```',
  });
  const p0 = createIssue(wrapper, { title: 'P0-задача', priority: 0 });
  const doing = createIssue(wrapper, { title: 'P1-в работе', priority: 1 });
  claimIssue(wrapper, { ref: doing.id, actor: 'agent:pickle' });
  const done = createIssue(wrapper, { title: 'Закрытая done', priority: 1 });
  changeStatus(wrapper, { ref: done.id, status: 'done', reason: 'готово' });
  const cancelled = createIssue(wrapper, { title: 'Отменённая', priority: 3 });
  changeStatus(wrapper, { ref: cancelled.id, status: 'cancelled', reason: 'не нужно' });

  // Разводим closed_at, иначе порядок «Закрытых» зависит от тай-брейка.
  wrapper.db
    .prepare('UPDATE issues SET closed_at = ? WHERE project_key = ? AND num = ?')
    .run(Date.now() - 2000, 'RAT', cancelled.num);
  wrapper.db
    .prepare('UPDATE issues SET closed_at = ? WHERE project_key = ? AND num = ?')
    .run(Date.now() - 1000, 'RAT', done.num);

  // created + 12 комментариев = 13 событий, в md попадают последние 10.
  for (let index = 1; index <= 12; index += 1) {
    addComment(wrapper, {
      ref: p2.id,
      text: `c${String(index).padStart(2, '0')} комментарий`,
      actor: 'agent:pickle',
    });
  }

  const md = exportMarkdown(wrapper, { project: 'RAT' });

  assert.ok(md.startsWith('# RAT — RatIssues\n'), 'заголовок проекта первой строкой');
  assert.match(md, /Сводка: всего 5 · open 2 · doing 1 · blocked 0 · deferred 0 · done 1 · cancelled 1/);
  assert.match(md, /\n## Открытые\n/);
  assert.match(md, /\n## Закрытые\n/);
  assert.ok(md.endsWith('\n'));

  // Открытые: priority asc, затем updated_at asc.
  const openIndex = md.indexOf('## Открытые');
  const closedIndex = md.indexOf('## Закрытые');
  assert.ok(openIndex < closedIndex);
  assert.ok(md.indexOf(`### ${p0.id} `) < md.indexOf(`### ${doing.id} `));
  assert.ok(md.indexOf(`### ${doing.id} `) < md.indexOf(`### ${p2.id} `));
  assert.ok(md.indexOf(`### ${p2.id} `) < closedIndex);

  // Закрытые: closed_at desc → done (позже) раньше cancelled.
  assert.ok(md.indexOf('## Закрытые') < md.indexOf(`### ${done.id} `));
  assert.ok(md.indexOf(`### ${done.id} `) < md.indexOf(`### ${cancelled.id} `));

  // Метаданные и тело как есть (fence не ломает структуру).
  assert.match(md, /метки: bug, ui/);
  assert.match(md, /исполнитель: agent:pickle/);
  assert.match(md, /ref: src\/a\.mjs/);
  assert.match(md, /`done` · p1/);
  assert.match(md, /закрыта: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(md, /причина: готово/);
  assert.match(md, /```js\nconst x = "кавычки";\n```/);

  // Последние 10 событий, старые не попадают.
  const block = issueBlock(md, p2.id);
  const bullets = block.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(bullets.length, 10);
  assert.match(block, /События \(последние 10\):/);
  assert.match(block, /c12 комментарий/);
  assert.match(block, /c03 комментарий/);
  assert.doesNotMatch(block, /c02 комментарий/);
  assert.doesNotMatch(block, /c01 комментарий/);

  const doingBlock = issueBlock(md, doing.id);
  assert.match(doingBlock, /claim agent:pickle: взята в работу: agent:pickle/);

  // Детерминизм: age/now в md не печатаются.
  assert.equal(exportMarkdown(wrapper, { project: 'RAT' }), md);
  assert.equal(exportMarkdown(wrapper, { project: 'RAT', now: 0 }), md);
});

test('exportMarkdown: пустой проект и пустая база дают валидный md', (t) => {
  const { wrapper } = setup(t);
  createProject(wrapper, { key: 'EMPTY', name: 'Empty' });

  const empty = exportMarkdown(wrapper, { project: 'EMPTY' });
  assert.ok(empty.startsWith('# EMPTY — Empty\n'));
  assert.match(empty, /Сводка: всего 0 · open 0 · doing 0 · blocked 0 · deferred 0 · done 0 · cancelled 0/);
  assert.match(empty, /## Открытые\n\n_Задач нет\._/);
  assert.match(empty, /## Закрытые\n\n_Задач нет\._/);
  assert.ok(empty.endsWith('\n'));

  const byDefault = exportMarkdown(wrapper, { env: {} });
  assert.ok(byDefault.startsWith('# RAT — RatIssues\n'), 'без проекта — default_project');
});

test('exportMarkdown --all: все проекты по key, архив помечен', (t) => {
  const { wrapper } = setup(t);
  createIssue(wrapper, { title: 'RAT задача' });
  createIssue(wrapper, { project: 'AXEL', title: 'AXEL задача' });
  createProject(wrapper, { key: 'ZZZ', name: 'Забытый' });
  createIssue(wrapper, { project: 'ZZZ', title: 'Архивная задача' });
  archiveProject(wrapper, { key: 'ZZZ' });

  const md = exportMarkdown(wrapper, { all: true });
  const axel = md.indexOf('# AXEL — Axel');
  const rat = md.indexOf('# RAT — RatIssues');
  const zzz = md.indexOf('# ZZZ — Забытый (архив)');
  assert.notEqual(axel, -1);
  assert.notEqual(rat, -1);
  assert.notEqual(zzz, -1);
  assert.ok(axel < rat && rat < zzz, 'стабильный порядок проектов по key');
  assert.match(md, /### ZZZ-1 · Архивная задача/);
});

test('exportJsonl: строка на задачу, стабильные поля и порядок, тело с \\n и кавычками', (t) => {
  const { wrapper } = setup(t);
  createIssue(wrapper, {
    title: 'Первая',
    body: 'строка "кавычки"\nвторая\nтретья',
    labels: 'ui',
  });
  createIssue(wrapper, { title: 'Вторая' });
  createIssue(wrapper, { project: 'AXEL', title: 'AXEL задача' });
  createProject(wrapper, { key: 'ZZZ', name: 'Архив' });
  createIssue(wrapper, { project: 'ZZZ', title: 'ZZZ задача' });
  archiveProject(wrapper, { key: 'ZZZ' });

  const rat = exportJsonl(wrapper, { project: 'RAT' });
  assert.ok(rat.endsWith('\n'));
  const lines = rat.split('\n');
  assert.equal(lines.length, 3, 'две задачи + завершающий перевод строки');
  assert.equal(lines.at(-1), '');

  const issues = parsedLines(rat);
  assert.deepEqual(Object.keys(issues[0]), ISSUE_FIELD_ORDER);
  assert.deepEqual(issues.map((issue) => issue.id), ['RAT-1', 'RAT-2']);
  assert.equal(issues[0].body, 'строка "кавычки"\nвторая\nтретья');
  assert.deepEqual(issues[0].labels, ['ui']);

  // По умолчанию jsonl — вся база без архивных проектов.
  const allActive = parsedLines(exportJsonl(wrapper, {}));
  assert.deepEqual(allActive.map((issue) => issue.id), ['AXEL-1', 'RAT-1', 'RAT-2']);

  // --all добавляет архивные, порядок project ASC, num ASC.
  const all = parsedLines(exportJsonl(wrapper, { all: true }));
  assert.deepEqual(all.map((issue) => issue.id), ['AXEL-1', 'RAT-1', 'RAT-2', 'ZZZ-1']);

  // Пустой проект — пустая строка, а не мусор.
  createProject(wrapper, { key: 'EMPTY', name: 'Empty' });
  assert.equal(exportJsonl(wrapper, { project: 'EMPTY' }), '');
  assert.equal(buildExport(wrapper, { format: 'jsonl', project: 'EMPTY' }).issues, 0);

  // limit ограничивает число записей, сохраняя порядок.
  assert.deepEqual(
    parsedLines(exportJsonl(wrapper, { all: true, limit: 2 })).map((issue) => issue.id),
    ['AXEL-1', 'RAT-1'],
  );
});

test('exportJsonl --events: поле-события, хронология, limit и счётчики', (t) => {
  const { wrapper } = setup(t);
  const issue = createIssue(wrapper, { title: 'Задача' });
  addComment(wrapper, { ref: issue.id, text: 'первый' });
  changeStatus(wrapper, { ref: issue.id, status: 'blocked', reason: 'мешает' });
  createIssue(wrapper, { project: 'AXEL', title: 'AXEL' });

  const content = exportJsonl(wrapper, { project: 'RAT', events: true });
  assert.ok(content.endsWith('\n'));
  const events = parsedLines(content);
  assert.equal(events.length, 3, 'created + comment + status');
  assert.deepEqual(Object.keys(events[0]), EVENT_FIELD_ORDER);
  assert.ok(events.every((event) => event.project === 'RAT'));
  assert.ok(events.every((event) => event.issue === 'RAT-1'));
  assert.deepEqual(
    events.map((event) => event.kind),
    ['created', 'comment', 'status'],
  );
  for (const event of events) {
    assert.equal(typeof event.data, 'object', `data должно быть объектом, не строкой (событие ${event.kind})`);
    assert.ok(event.data !== null && !Array.isArray(event.data));
  }
  assert.equal(events.find((event) => event.kind === 'status').data.from, 'open');
  const timestamps = events.map((event) => event.ts);
  assert.deepEqual(timestamps, timestamps.slice().sort((a, b) => a - b));

  const limited = parsedLines(exportJsonl(wrapper, { project: 'RAT', events: true, limit: 2 }));
  assert.deepEqual(limited.map((event) => event.kind), ['created', 'comment']);

  const report = buildExport(wrapper, {
    format: 'jsonl',
    project: 'RAT',
    events: true,
    limit: 2,
  });
  assert.deepEqual(
    { format: report.format, projects: report.projects, issues: report.issues, events: report.events },
    { format: 'jsonl', projects: 1, issues: 0, events: 2 },
  );

  // События всех проектов при --all.
  const all = parsedLines(exportJsonl(wrapper, { all: true, events: true }));
  assert.ok(all.some((event) => event.project === 'AXEL' && event.kind === 'created'));
});

test('export не меняет базу: updated_at и число events до/после', (t) => {
  const { wrapper } = setup(t);
  const issue = createIssue(wrapper, { title: 'Неизменная', body: 'тело' });
  addComment(wrapper, { ref: issue.id, text: 'комментарий' });
  changeStatus(wrapper, { ref: issue.id, status: 'doing' });

  const rowsBefore = wrapper.db
    .prepare('SELECT id, updated_at, status, closed_at FROM issues ORDER BY id')
    .all();
  const eventsBefore = wrapper.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;

  exportMarkdown(wrapper, { project: 'RAT' });
  exportMarkdown(wrapper, { all: true });
  exportJsonl(wrapper, { all: true });
  exportJsonl(wrapper, { all: true, events: true });
  buildExport(wrapper, { format: 'md', all: true, now: 0 });

  const rowsAfter = wrapper.db
    .prepare('SELECT id, updated_at, status, closed_at FROM issues ORDER BY id')
    .all();
  const eventsAfter = wrapper.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  assert.deepEqual(rowsAfter, rowsBefore);
  assert.equal(eventsAfter, eventsBefore);
});

test('defaultExportPath и writeExportFile: exports/ от корня репо, mkdir -p, атомарно', (t) => {
  const { box } = setup(t);

  assert.equal(EXPORTS_DIR, path.join(REPO_ROOT, 'exports'));
  assert.equal(
    defaultExportPath({ format: 'md', projectKey: 'rat' }),
    path.join(REPO_ROOT, 'exports', 'RAT.md'),
  );
  assert.equal(
    defaultExportPath({ format: 'md', all: true }),
    path.join(REPO_ROOT, 'exports', 'all.md'),
  );
  assert.equal(
    defaultExportPath({ format: 'jsonl' }),
    path.join(REPO_ROOT, 'exports', 'all.jsonl'),
  );
  assert.equal(
    defaultExportPath({ format: 'jsonl', projectKey: 'AXEL' }),
    path.join(REPO_ROOT, 'exports', 'AXEL.jsonl'),
  );
  assert.throws(
    () => defaultExportPath({ format: 'md' }),
    (err) => err.exitCode === 2 && err.code === 'invalid_arguments',
  );

  const target = path.join(box.dir, 'nested', 'deep', 'snapshot.md');
  const written = writeExportFile(target, 'a\nb\n');
  assert.equal(written.path, path.resolve(target));
  assert.equal(written.bytes, 4);
  assert.equal(readFileSync(target, 'utf8'), 'a\nb\n');
  const leftovers = readdirSync(path.dirname(target)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('CLI export --out -: ровно снапшот в stdout, без баннеров', (t) => {
  const { wrapper, dbPath, box } = setup(t);
  createIssue(wrapper, { title: 'Открытая', priority: 1, labels: 'ui' });
  const closed = createIssue(wrapper, { title: 'Закрытая' });
  changeStatus(wrapper, { ref: closed.id, status: 'done', reason: 'ок' });

  const md = runCli(['export', '--out', '-'], { dbPath, cwd: box.dir });
  assert.equal(md.code, 0, md.stderr);
  assert.equal(md.stderr, '');
  assert.equal(md.stdout, exportMarkdown(wrapper, { project: 'RAT' }));
  assert.ok(md.stdout.startsWith('# RAT — RatIssues\n'));
  assert.equal(md.stdout.includes('Экспорт:'), false);

  const jsonl = runCli(['export', 'RAT', '--format', 'jsonl', '--out', '-'], {
    dbPath,
    cwd: box.dir,
  });
  assert.equal(jsonl.code, 0, jsonl.stderr);
  assert.equal(jsonl.stderr, '');
  assert.equal(jsonl.stdout, exportJsonl(wrapper, { project: 'RAT' }));
  assert.equal(parsedLines(jsonl.stdout).length, 2);

  const events = runCli(['export', 'RAT', '--format', 'jsonl', '--events', '--out', '-'], {
    dbPath,
    cwd: box.dir,
  });
  assert.equal(events.code, 0, events.stderr);
  assert.ok(parsedLines(events.stdout).every((event) => event.kind));
});

test('CLI export в файл: создаёт exports/, печатает путь и размер, --json схема', (t) => {
  const { wrapper, dbPath, box } = setup(t);
  createIssue(wrapper, { title: 'Задача' });

  const human = runCli(['export', '--out', 'exports/snapshot.md'], { dbPath, cwd: box.dir });
  assert.equal(human.code, 0, human.stderr);
  const written = path.join(box.dir, 'exports', 'snapshot.md');
  assert.ok(existsSync(written));
  assert.equal(readFileSync(written, 'utf8'), exportMarkdown(wrapper, { project: 'RAT' }));
  assert.match(human.stdout, /Экспорт: .*snapshot\.md \(\d+(\.\d+)? (Б|КБ)\)/);

  const quiet = runCli(['export', '--out', 'exports/quiet.md', '--quiet'], { dbPath, cwd: box.dir });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(quiet.stdout, `${path.resolve(box.dir, 'exports', 'quiet.md')}\n`);

  const jsonTarget = path.join(box.dir, 'exports', 'all.jsonl');
  const json = runCli(
    ['export', '--format', 'jsonl', '--out', jsonTarget, '--json'],
    { dbPath, cwd: box.dir },
  );
  assert.equal(json.code, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(report), ['path', 'format', 'bytes', 'projects', 'issues', 'events']);
  assert.equal(report.path, path.resolve(jsonTarget));
  assert.equal(report.format, 'jsonl');
  assert.equal(report.bytes, statSync(jsonTarget).size);
  assert.equal(report.issues, 1);
  assert.equal(report.events, 0);

  const mdJson = JSON.parse(
    runCli(['export', '--out', path.join(box.dir, 'exports', 'r.md'), '--json'], {
      dbPath,
      cwd: box.dir,
    }).stdout,
  );
  assert.equal(mdJson.format, 'md');
  assert.equal(mdJson.projects, 1);
  assert.equal(mdJson.issues, 1);
  assert.ok(mdJson.events >= 1, 'в md отрендерено хотя бы событие created');
});

test('CLI export: --all покрывает все проекты, --events только для jsonl', (t) => {
  const { wrapper, dbPath, box } = setup(t);
  createIssue(wrapper, { title: 'RAT' });
  createIssue(wrapper, { project: 'AXEL', title: 'AXEL' });
  createProject(wrapper, { key: 'ZZZ', name: 'Архив' });
  createIssue(wrapper, { project: 'ZZZ', title: 'ZZZ' });
  archiveProject(wrapper, { key: 'ZZZ' });

  const md = runCli(['export', '--all', '--out', '-'], { dbPath, cwd: box.dir });
  assert.equal(md.code, 0, md.stderr);
  assert.match(md.stdout, /# AXEL — Axel/);
  assert.match(md.stdout, /# RAT — RatIssues/);
  assert.match(md.stdout, /# ZZZ — Архив \(архив\)/);

  const jsonl = runCli(['export', '--format', 'jsonl', '--all', '--out', '-'], {
    dbPath,
    cwd: box.dir,
  });
  assert.equal(jsonl.code, 0, jsonl.stderr);
  assert.deepEqual(
    parsedLines(jsonl.stdout).map((issue) => issue.id),
    ['AXEL-1', 'RAT-1', 'ZZZ-1'],
  );

  const eventsOnMd = runCli(
    ['export', '--format', 'md', '--events', '--out', '-', '--json'],
    { dbPath, cwd: box.dir },
  );
  assert.equal(eventsOnMd.code, 2);
  assert.equal(JSON.parse(eventsOnMd.stderr).error.code, 'invalid_arguments');

  const eventsByDefault = runCli(['export', '--events', '--out', '-'], { dbPath, cwd: box.dir });
  assert.equal(eventsByDefault.code, 2);

  const edit = runCli(['export', '--all', 'RAT', '--out', '-', '--json'], { dbPath, cwd: box.dir });
  assert.equal(edit.code, 2);
  assert.equal(JSON.parse(edit.stderr).error.code, 'invalid_arguments');

  const badFormat = runCli(['export', '--format', 'xml', '--json'], { dbPath, cwd: box.dir });
  assert.equal(badFormat.code, 2);
  assert.equal(JSON.parse(badFormat.stderr).error.code, 'invalid_format');

  const jsonToStdout = runCli(['export', '--out', '-', '--json'], { dbPath, cwd: box.dir });
  assert.equal(jsonToStdout.code, 2);
});

test('CLI export: неизвестный проект → exit 1, help содержит команду', (t) => {
  const { dbPath, box } = setup(t);

  const missing = runCli(['export', 'ZZZ', '--out', 'exports/missing.md', '--json'], {
    dbPath,
    cwd: box.dir,
  });
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'project_not_found');
  assert.equal(existsSync(path.join(box.dir, 'exports', 'missing.md')), false);

  const help = runCli(['--help'], { dbPath, cwd: box.dir });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /export\s+снапшот задач/);

  const exportHelp = runCli(['export', '--help'], { dbPath, cwd: box.dir });
  assert.equal(exportHelp.code, 0, exportHelp.stderr);
  assert.match(exportHelp.stdout, /rat export \[project\]/);
  assert.match(exportHelp.stdout, /--format md\|jsonl/);
});
