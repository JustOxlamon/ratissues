import test from 'node:test';
import assert from 'node:assert/strict';

import { appendEvent } from '../src/core/events.mjs';
import {
  addComment,
  changeStatus,
  createIssue,
  createProject,
  initDatabase,
} from '../src/core/store.mjs';
import { createSandbox, runCli } from './helpers.mjs';

const ISSUE_KEYS = [
  'assignee',
  'body',
  'close_reason',
  'closed_at',
  'created_at',
  'id',
  'labels',
  'meta',
  'num',
  'priority',
  'project',
  'ref',
  'status',
  'title',
  'updated_at',
];

function json(result) {
  return JSON.parse(result.stdout);
}

function errorJson(result) {
  return JSON.parse(result.stderr);
}

function setup(t, prefix = 'rat-m2-cli-') {
  const box = createSandbox(t, prefix);
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });
  return { box, wrapper, dbPath: box.dbPath };
}

test('CLI ls: таблица/JSON, фильтры, сортировка, лимит и курсор', (t) => {
  const { wrapper, dbPath } = setup(t);

  const a = createIssue(wrapper, {
    project: 'AXEL',
    title: 'Починить кнопку',
    body: 'Русский текст',
    labels: 'ui,bug',
    priority: 1,
  });
  const b = createIssue(wrapper, {
    project: 'AXEL',
    title: 'Refactor database',
    labels: 'backend',
    priority: 0,
  });
  const c = createIssue(wrapper, { project: 'AXEL', title: 'Закрытая AXEL', priority: 3 });
  changeStatus(wrapper, { ref: c.id, status: 'done' });
  const r = createIssue(wrapper, { title: 'RAT открытая', priority: 2 });
  const rDone = createIssue(wrapper, { title: 'RAT закрытая', priority: 0 });
  changeStatus(wrapper, { ref: rDone.id, status: 'done' });

  const active = runCli(['ls', 'AXEL', '--json'], { dbPath });
  assert.equal(active.code, 0, active.stderr);
  const activeJson = json(active);
  assert.deepEqual(Object.keys(activeJson), ['issues', 'next_cursor']);
  assert.equal(activeJson.next_cursor, null);
  assert.deepEqual(activeJson.issues.map((issue) => issue.id), [b.id, a.id]);
  assert.deepEqual(Object.keys(activeJson.issues[0]).sort(), ISSUE_KEYS);

  const all = runCli(['ls', 'AXEL', '-s', 'all', '--json'], { dbPath });
  assert.equal(all.code, 0, all.stderr);
  assert.deepEqual(json(all).issues.map((issue) => issue.id), [b.id, a.id, c.id]);

  const updated = runCli(['ls', 'AXEL', '--sort', 'updated', '--json'], { dbPath });
  assert.equal(updated.code, 0, updated.stderr);
  const updatedIds = json(updated).issues.map((issue) => issue.id);
  assert.equal(updatedIds.length, 2);
  assert.deepEqual(new Set(updatedIds), new Set([a.id, b.id]));

  const everywhere = runCli(['ls', '--all', '--json'], { dbPath });
  assert.equal(everywhere.code, 0, everywhere.stderr);
  assert.deepEqual(
    json(everywhere).issues.map((issue) => issue.id).sort(),
    [a.id, b.id, r.id].sort(),
  );

  const searched = runCli(['ls', '--all', '-q', 'кнопку', '--json'], { dbPath });
  assert.equal(searched.code, 0, searched.stderr);
  assert.deepEqual(json(searched).issues.map((issue) => issue.id), [a.id]);

  const labelled = runCli(['ls', 'AXEL', '--label', 'UI', '--json'], { dbPath });
  assert.equal(labelled.code, 0, labelled.stderr);
  assert.deepEqual(json(labelled).issues.map((issue) => issue.id), [a.id]);

  const p0 = runCli(['ls', 'AXEL', '--priority', 'p0', '--json'], { dbPath });
  assert.equal(p0.code, 0, p0.stderr);
  assert.deepEqual(json(p0).issues.map((issue) => issue.id), [b.id]);

  const firstPage = runCli(['ls', 'AXEL', '--limit', '1', '--json'], { dbPath });
  assert.equal(firstPage.code, 0, firstPage.stderr);
  const firstJson = json(firstPage);
  assert.equal(firstJson.issues.length, 1);
  assert.equal(typeof firstJson.next_cursor, 'string');
  const secondPage = runCli(
    ['ls', 'AXEL', '--limit', '1', '--cursor', firstJson.next_cursor, '--json'],
    { dbPath },
  );
  assert.equal(secondPage.code, 0, secondPage.stderr);
  const secondJson = json(secondPage);
  assert.equal(secondJson.issues.length, 1);
  assert.equal(secondJson.next_cursor, null);
  assert.notEqual(secondJson.issues[0].id, firstJson.issues[0].id);

  const human = runCli(['ls', 'AXEL', '-s', 'all'], { dbPath });
  assert.equal(human.code, 0, human.stderr);
  for (const header of ['ID', 'PRI', 'STATUS', 'AGE', 'ASSIGNEE', 'LABELS', 'TITLE']) {
    assert.match(human.stdout, new RegExp(header));
  }
  assert.match(human.stdout, new RegExp(b.id));
  assert.equal(human.stdout.includes('\u001b['), false);

  const empty = runCli(['ls', 'AXEL', '--label', 'nope'], { dbPath });
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /Задач нет/);

  assert.equal(runCli(['ls', '--all', 'AXEL', '--json'], { dbPath }).code, 2);
  assert.equal(errorJson(runCli(['ls', '-s', 'nope', '--json'], { dbPath })).error.code, 'invalid_status');
  assert.equal(errorJson(runCli(['ls', '--sort', 'nope', '--json'], { dbPath })).error.code, 'invalid_sort');
  assert.equal(errorJson(runCli(['ls', 'ZZZ', '--json'], { dbPath })).error.code, 'project_not_found');
});

test('CLI next: порядок, --label, пустой результат и JSON-схема', (t) => {
  const { wrapper, dbPath } = setup(t);

  const older = createIssue(wrapper, { title: 'p1 старая', priority: 1 });
  const p0Newer = createIssue(wrapper, { title: 'p0 новая', priority: 0 });
  const p0Older = createIssue(wrapper, { title: 'p0 старая', priority: 0 });
  createIssue(wrapper, { title: 'p1 с меткой', priority: 1, labels: 'ui' });
  const done = createIssue(wrapper, { title: 'p0 закрытая', priority: 0 });
  changeStatus(wrapper, { ref: done.id, status: 'done' });

  // updated_at у быстро созданных задач почти совпадает; разводим p0-кандидатов.
  const touch = wrapper.db.prepare(
    'UPDATE issues SET updated_at = ? WHERE project_key = ? AND num = ?',
  );
  touch.run(Date.now() - 10_000, 'RAT', p0Older.num);
  touch.run(Date.now() - 5_000, 'RAT', p0Newer.num);

  const next = runCli(['next', '--json'], { dbPath });
  assert.equal(next.code, 0, next.stderr);
  const nextJson = json(next);
  assert.deepEqual(Object.keys(nextJson), ['issue']);
  assert.equal(nextJson.issue.id, p0Older.id);
  assert.deepEqual(Object.keys(nextJson.issue).sort(), ISSUE_KEYS);

  const labelled = runCli(['next', '--label', 'ui', '--json'], { dbPath });
  assert.equal(labelled.code, 0, labelled.stderr);
  assert.equal(json(labelled).issue.title, 'p1 с меткой');

  const emptyProject = runCli(['next', 'AXEL', '--json'], { dbPath });
  assert.equal(emptyProject.code, 0, emptyProject.stderr);
  assert.deepEqual(json(emptyProject), { issue: null });

  const emptyHuman = runCli(['next', 'AXEL'], { dbPath });
  assert.equal(emptyHuman.code, 0, emptyHuman.stderr);
  assert.match(emptyHuman.stdout, /Нет открытых задач/);

  const claimed = runCli(['claim', p0Older.id, '--json'], { dbPath });
  assert.equal(claimed.code, 0, claimed.stderr);
  const afterClaim = json(runCli(['next', '--json'], { dbPath }));
  assert.equal(afterClaim.issue.id, p0Newer.id);
  assert.ok(older.id);
});

test('CLI log: since/kind/limit/проект, JSON-схема и человекочитаемый вывод', (t) => {
  const { wrapper, dbPath } = setup(t);
  const now = Date.now();

  const ratIssue = createIssue(wrapper, { title: 'RAT задача' });
  addComment(wrapper, { ref: ratIssue.id, text: 'комментарий RAT' });
  const axelIssue = createIssue(wrapper, { project: 'AXEL', title: 'AXEL задача' });
  addComment(wrapper, { ref: axelIssue.id, text: 'комментарий AXEL' });
  createProject(wrapper, { key: 'EMPTY', name: 'Empty' });
  appendEvent(wrapper, {
    issueId: ratIssue.id,
    kind: 'comment',
    data: { text: 'старый комментарий' },
    ts: now - 10 * 86_400_000,
  });

  const all = runCli(['log', '--json'], { dbPath });
  assert.equal(all.code, 0, all.stderr);
  const allJson = json(all);
  assert.deepEqual(Object.keys(allJson), ['events']);
  assert.deepEqual(Object.keys(allJson.events[0]).sort(), [
    'actor',
    'data',
    'id',
    'issue',
    'kind',
    'project',
    'ts',
  ]);
  assert.equal(allJson.events.length, 5);
  assert.ok(allJson.events.every((event) => !event.issue_id));

  const since = runCli(['log', '--since', '1d', '--json'], { dbPath });
  assert.equal(since.code, 0, since.stderr);
  assert.equal(json(since).events.length, 4);
  assert.equal(
    json(since).events.some((event) => event.data.text === 'старый комментарий'),
    false,
  );

  const iso = runCli(['log', '--since', '2000-01-01T00:00:00.000Z', '--json'], { dbPath });
  assert.equal(iso.code, 0, iso.stderr);
  assert.equal(json(iso).events.length, 5);

  const comments = runCli(['log', '--kind', 'comment', '--json'], { dbPath });
  assert.equal(comments.code, 0, comments.stderr);
  assert.equal(json(comments).events.length, 3);
  assert.ok(json(comments).events.every((event) => event.kind === 'comment'));

  const axel = runCli(['log', 'AXEL', '--json'], { dbPath });
  assert.equal(axel.code, 0, axel.stderr);
  assert.ok(json(axel).events.every((event) => event.project === 'AXEL'));

  const limited = runCli(['log', '--limit', '1', '--json'], { dbPath });
  assert.equal(limited.code, 0, limited.stderr);
  assert.equal(json(limited).events.length, 1);

  const human = runCli(['log', '--since', '1d'], { dbPath });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /created/);
  assert.match(human.stdout, /RAT-1/);
  assert.equal(human.stdout.includes('\u001b['), false);

  const empty = runCli(['log', 'EMPTY'], { dbPath });
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /Событий нет/);

  assert.equal(errorJson(runCli(['log', '--kind', 'nope', '--json'], { dbPath })).error.code, 'invalid_event_kind');
  assert.equal(errorJson(runCli(['log', 'ZZZ', '--json'], { dbPath })).error.code, 'project_not_found');
  assert.equal(runCli(['log', '--since', 'вчера', '--json'], { dbPath }).code, 2);
});

test('CLI stats: JSON-схема, счётчики и человекочитаемая сводка', (t) => {
  const { wrapper, dbPath } = setup(t);

  createIssue(wrapper, { title: 'Открытая', priority: 0 });
  const done = createIssue(wrapper, { title: 'Закрытая', priority: 2 });
  changeStatus(wrapper, { ref: done.id, status: 'done' });
  addComment(wrapper, { ref: done.id, text: 'итог' });
  createIssue(wrapper, { project: 'AXEL', title: 'AXEL', priority: 2 });

  const result = runCli(['stats', '--json'], { dbPath });
  assert.equal(result.code, 0, result.stderr);
  const stats = json(result);
  assert.deepEqual(Object.keys(stats).sort(), ['projects', 'totals', 'week']);
  assert.deepEqual(Object.keys(stats.totals).sort(), ['byPriority', 'byStatus', 'total']);
  assert.deepEqual(Object.keys(stats.week).sort(), ['closed', 'comments', 'created']);
  assert.deepEqual(Object.keys(stats.projects[0]).sort(), ['counts', 'key', 'name']);

  assert.deepEqual(stats.projects.map((project) => project.key), ['AXEL', 'RAT']);
  assert.equal(stats.totals.total, 3);
  assert.equal(stats.totals.byStatus.open, 2);
  assert.equal(stats.totals.byStatus.done, 1);
  assert.equal(stats.totals.byPriority['0'], 1);
  assert.equal(stats.totals.byPriority['2'], 2);
  assert.deepEqual(stats.week, { created: 3, closed: 1, comments: 1 });

  const human = runCli(['stats'], { dbPath });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /KEY/);
  assert.match(human.stdout, /Всего: 3/);
  assert.match(human.stdout, /За 7 дней: создано 3, закрыто 1, комментариев 1/);

  const bad = runCli(['stats', 'лишнее', '--json'], { dbPath });
  assert.equal(bad.code, 2);
  assert.equal(errorJson(bad).error.code, 'unexpected_argument');
});

test('CLI edit: отдельные события, stdin, +x/-y, no-op и ошибки', (t) => {
  const { wrapper, dbPath } = setup(t);

  const issue = createIssue(wrapper, {
    title: 'Старое имя',
    body: 'старое тело',
    labels: 'y,ui',
    assignee: 'me',
    ref: 'src/x.mjs',
  });

  const edited = runCli(
    [
      'edit',
      issue.id,
      '--title',
      'Новое имя',
      '--priority',
      '0',
      '--label',
      '+x,-y',
      '--label',
      '-ui',
      '--assignee',
      'agent:test',
      '--ref',
      'src/y.mjs',
      '--json',
    ],
    { dbPath },
  );
  assert.equal(edited.code, 0, edited.stderr);
  const editedJson = json(edited);
  assert.deepEqual(Object.keys(editedJson).sort(), ['events', 'issue']);
  assert.equal(editedJson.issue.title, 'Новое имя');
  assert.equal(editedJson.issue.priority, 0);
  assert.equal(editedJson.issue.assignee, 'agent:test');
  assert.equal(editedJson.issue.ref, 'src/y.mjs');
  assert.deepEqual(editedJson.issue.labels, ['x']);
  assert.deepEqual(
    editedJson.events.map((event) => event.data.field),
    ['title', 'priority', 'assignee', 'ref', 'labels'],
  );
  assert.ok(editedJson.events.every((event) => event.kind === 'edit'));
  assert.equal(editedJson.issue.updated_at, editedJson.events[0].ts);

  const bodyFromStdin = runCli(['edit', issue.id, '--body', '-', '--json'], {
    dbPath,
    input: 'новое тело\n',
  });
  assert.equal(bodyFromStdin.code, 0, bodyFromStdin.stderr);
  assert.equal(json(bodyFromStdin).issue.body, 'новое тело');

  const noop = runCli(['edit', issue.id, '--title', 'Новое имя', '--json'], { dbPath });
  assert.equal(noop.code, 0, noop.stderr);
  assert.deepEqual(json(noop).events, []);

  const noChanges = runCli(['edit', issue.id, '--json'], { dbPath });
  assert.equal(noChanges.code, 2);
  assert.equal(errorJson(noChanges).error.code, 'no_changes');

  const emptyTitle = runCli(['edit', issue.id, '--title', '-', '--json'], {
    dbPath,
    input: '   \n',
  });
  assert.equal(emptyTitle.code, 2);
  assert.equal(errorJson(emptyTitle).error.code, 'required_field');

  const human = runCli(['edit', issue.id, '--priority', '3'], { dbPath });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, new RegExp(`${issue.id}: priority: 0 → 3`));

  const quiet = runCli(['edit', issue.id, '--priority', '1', '--quiet'], { dbPath });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(quiet.stdout, `${issue.id}\n`);

  assert.equal(runCli(['edit', '--title', 'x', '--json'], { dbPath }).code, 2);
  assert.equal(runCli(['edit', 'RAT-99', '--title', 'x', '--json'], { dbPath }).code, 1);
  assert.equal(runCli(['edit', issue.id, '--priority', '9', '--json'], { dbPath }).code, 2);
});

test('CLI project archive: скрытие из ls, --all, повторный конфликт', (t) => {
  const { wrapper, dbPath } = setup(t);
  const axelIssue = createIssue(wrapper, { project: 'AXEL', title: 'Задача AXEL' });
  createIssue(wrapper, { title: 'Задача RAT' });

  const archived = runCli(['project', 'archive', 'axel', '--json'], { dbPath });
  assert.equal(archived.code, 0, archived.stderr);
  const project = json(archived);
  assert.equal(project.key, 'AXEL');
  assert.equal(typeof project.archived_at, 'number');
  assert.deepEqual(Object.keys(project).sort(), [
    'archived_at',
    'color',
    'created_at',
    'key',
    'name',
    'root_path',
  ]);

  const visible = json(runCli(['project', 'ls', '--json'], { dbPath }));
  assert.deepEqual(visible.projects.map((entry) => entry.key), ['RAT']);

  const withAll = json(runCli(['project', 'ls', '--all', '--json'], { dbPath }));
  const axel = withAll.projects.find((entry) => entry.key === 'AXEL');
  assert.equal(typeof axel.archived_at, 'number');

  const human = runCli(['project', 'ls', '--all'], { dbPath });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /архив/);

  const again = runCli(['project', 'archive', 'AXEL', '--json'], { dbPath });
  assert.equal(again.code, 3);
  assert.equal(errorJson(again).error.code, 'project_archived');

  const missing = runCli(['project', 'archive', 'ZZZ', '--json'], { dbPath });
  assert.equal(missing.code, 1);
  assert.equal(errorJson(missing).error.code, 'project_not_found');

  assert.equal(runCli(['project', 'archive', '--json'], { dbPath }).code, 2);

  // Задачи архивного проекта доступны явно и исчезают из «все проекты».
  const explicit = runCli(['ls', 'AXEL', '--json'], { dbPath });
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.deepEqual(json(explicit).issues.map((issue) => issue.id), [axelIssue.id]);
  const everywhere = runCli(['ls', '--all', '--json'], { dbPath });
  assert.equal(everywhere.code, 0, everywhere.stderr);
  assert.equal(
    json(everywhere).issues.some((issue) => issue.project === 'AXEL'),
    false,
  );
});

test('CLI help перечисляет все команды M0–M5 и их usage', (t) => {
  const { dbPath } = setup(t);

  const help = runCli(['--help'], { dbPath });
  assert.equal(help.code, 0, help.stderr);
  for (const command of [
    'init', 'doctor', 'project', 'add', 'ls', 'show', 'edit',
    'status', 'done', 'cancel', 'reopen', 'claim', 'comment',
    'next', 'log', 'stats', 'export', 'serve',
  ]) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`), `help содержит ${command}`);
  }

  const lsHelp = runCli(['ls', '--help'], { dbPath });
  assert.equal(lsHelp.code, 0, lsHelp.stderr);
  assert.match(lsHelp.stdout, /rat ls \[project\]/);
  assert.match(lsHelp.stdout, /--sort pri\|updated/);

  const serveHelp = runCli(['serve', '--help'], { dbPath });
  assert.equal(serveHelp.code, 0, serveHelp.stderr);
  assert.match(serveHelp.stdout, /--open/);
});
