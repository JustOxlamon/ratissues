import test from 'node:test';
import assert from 'node:assert/strict';

import { createSandbox, runCli } from './helpers.mjs';

function json(result) {
  return JSON.parse(result.stdout);
}

function errorOf(result) {
  return JSON.parse(result.stderr);
}

function init(box) {
  const result = runCli(['init'], { dbPath: box.dbPath });
  assert.equal(result.code, 0, result.stderr);
}

test('CLI: milestone add с --body -, --due, --json и --quiet', (t) => {
  const box = createSandbox(t, 'rat-m7-cli-');
  init(box);

  const created = runCli(
    ['milestone', 'add', 'v1.0', '--project', 'RAT', '--due', '2026-12-31', '--body', '-', '--json'],
    { dbPath: box.dbPath, input: 'Первый релиз\n' },
  );
  assert.equal(created.code, 0, created.stderr);
  const milestone = json(created);
  assert.equal(milestone.project, 'RAT');
  assert.equal(milestone.name, 'v1.0');
  assert.equal(milestone.body, 'Первый релиз');
  assert.equal(milestone.due_at, Date.UTC(2026, 11, 31));
  assert.equal(milestone.state, 'open');
  assert.deepEqual(milestone.progress, { total: 0, done: 0, cancelled: 0, percent: 0 });

  const quiet = runCli(['milestone', 'add', 'v1.1', '--quiet'], { dbPath: box.dbPath });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(quiet.stdout.trim(), 'v1.1');
});

test('CLI: milestone ls — таблица, --json и --state closed|all', (t) => {
  const box = createSandbox(t, 'rat-m7-cli-');
  init(box);
  runCli(['milestone', 'add', 'v1.0', '--due', '2026-01-01'], { dbPath: box.dbPath });
  runCli(['milestone', 'add', 'v1.1', '--due', '2026-02-01'], { dbPath: box.dbPath });
  runCli(['milestone', 'close', 'v1.1'], { dbPath: box.dbPath });

  const table = runCli(['milestone', 'ls'], { dbPath: box.dbPath });
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /PROJECT\s+NAME\s+STATE\s+PROGRESS\s+DUE/);
  assert.match(table.stdout, /v1\.0\s+open\s+0\/0 \(0%\)\s+2026-01-01/);
  assert.doesNotMatch(table.stdout, /v1\.1/);

  const open = json(runCli(['milestone', 'ls', '--json'], { dbPath: box.dbPath }));
  assert.deepEqual(open.milestones.map((milestone) => milestone.name), ['v1.0']);

  const closed = json(runCli(['milestone', 'ls', '--state', 'closed', '--json'], { dbPath: box.dbPath }));
  assert.deepEqual(closed.milestones.map((milestone) => milestone.name), ['v1.1']);

  const all = json(runCli(['milestone', 'ls', '--state', 'all', '--json'], { dbPath: box.dbPath }));
  assert.deepEqual(all.milestones.map((milestone) => milestone.name), ['v1.0', 'v1.1']);
});

test('CLI: milestone edit — --name/--due/--clear-due/--body', (t) => {
  const box = createSandbox(t, 'rat-m7-cli-');
  init(box);
  runCli(['milestone', 'add', 'v1.0', '--due', '2026-12-31', '--body', 'старое'], {
    dbPath: box.dbPath,
  });

  const edited = runCli(
    ['milestone', 'edit', 'v1.0', '--name', 'v2.0', '--due', '2027-01-15', '--body', '-', '--json'],
    { dbPath: box.dbPath, input: 'новое\n' },
  );
  assert.equal(edited.code, 0, edited.stderr);
  const milestone = json(edited);
  assert.equal(milestone.name, 'v2.0');
  assert.equal(milestone.body, 'новое');
  assert.equal(milestone.due_at, Date.UTC(2027, 0, 15));

  const cleared = json(
    runCli(['milestone', 'edit', 'v2.0', '--clear-due', '--json'], { dbPath: box.dbPath }),
  );
  assert.equal(cleared.due_at, null);
});

test('CLI: milestone close/reopen, повторный вызов → exit 0', (t) => {
  const box = createSandbox(t, 'rat-m7-cli-');
  init(box);
  runCli(['milestone', 'add', 'v1.0'], { dbPath: box.dbPath });

  const closed = json(runCli(['milestone', 'close', 'v1.0', '--json'], { dbPath: box.dbPath }));
  assert.equal(closed.state, 'closed');
  assert.notEqual(closed.closed_at, null);

  const closedAgain = runCli(['milestone', 'close', 'v1.0', '--json'], { dbPath: box.dbPath });
  assert.equal(closedAgain.code, 0, closedAgain.stderr);

  const reopened = json(runCli(['milestone', 'reopen', 'v1.0', '--json'], { dbPath: box.dbPath }));
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.closed_at, null);
  assert.equal(runCli(['milestone', 'reopen', 'v1.0'], { dbPath: box.dbPath }).code, 0);
});

test('CLI: --milestone у add/edit/ls, фильтр none', (t) => {
  const box = createSandbox(t, 'rat-m7-cli-');
  init(box);
  runCli(['milestone', 'add', 'v1.0'], { dbPath: box.dbPath });

  const created = json(
    runCli(['add', 'В релиз', '--milestone', 'v1.0', '--json'], { dbPath: box.dbPath }),
  );
  assert.equal(created.milestone, 'v1.0');
  const plain = json(runCli(['add', 'Без милстоуна', '--json'], { dbPath: box.dbPath }));
  assert.equal(plain.milestone, null);

  const filtered = json(
    runCli(['ls', '--milestone', 'v1.0', '--status', 'all', '--json'], { dbPath: box.dbPath }),
  );
  assert.deepEqual(filtered.issues.map((issue) => issue.id), [created.id]);

  const without = json(
    runCli(['ls', '--milestone', 'none', '--status', 'all', '--json'], { dbPath: box.dbPath }),
  );
  assert.deepEqual(without.issues.map((issue) => issue.id), [plain.id]);

  const detached = json(
    runCli(['edit', created.id, '--milestone', '-', '--json'], { dbPath: box.dbPath }),
  );
  assert.equal(detached.issue.milestone, null);

  const after = json(
    runCli(['ls', '--milestone', 'v1.0', '--status', 'all', '--json'], { dbPath: box.dbPath }),
  );
  assert.deepEqual(after.issues, []);
});

test('CLI: коды выхода 1/2/3 для милстоунов', (t) => {
  const box = createSandbox(t, 'rat-m7-cli-');
  init(box);
  runCli(['milestone', 'add', 'v1.0', '--json'], { dbPath: box.dbPath });

  const notFound = runCli(['milestone', 'close', 'nope', '--json'], { dbPath: box.dbPath });
  assert.equal(notFound.code, 1);
  assert.equal(errorOf(notFound).error.code, 'milestone_not_found');

  const invalidMilestone = runCli(
    ['add', 'Задача', '--milestone', 'nope', '--json'],
    { dbPath: box.dbPath },
  );
  assert.equal(invalidMilestone.code, 2);
  assert.equal(errorOf(invalidMilestone).error.code, 'invalid_milestone');

  const invalidDue = runCli(
    ['milestone', 'add', 'bad', '--due', '2026-02-30', '--json'],
    { dbPath: box.dbPath },
  );
  assert.equal(invalidDue.code, 2);
  assert.equal(errorOf(invalidDue).error.code, 'invalid_due');

  const duplicate = runCli(['milestone', 'add', 'V1.0', '--json'], { dbPath: box.dbPath });
  assert.equal(duplicate.code, 3);
  assert.equal(errorOf(duplicate).error.code, 'milestone_exists');

  runCli(['milestone', 'close', 'v1.0'], { dbPath: box.dbPath });
  const closed = runCli(['add', 'Поздняя', '--milestone', 'v1.0', '--json'], { dbPath: box.dbPath });
  assert.equal(closed.code, 3);
  assert.equal(errorOf(closed).error.code, 'milestone_closed');
});

test('CLI: rat help milestone содержит usage', (t) => {
  const box = createSandbox(t, 'rat-m7-cli-');
  init(box);

  const help = runCli(['milestone', '--help'], { dbPath: box.dbPath });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /milestone — милстоуны: add, ls, edit, close, reopen/);
  assert.match(help.stdout, /rat milestone add NAME/);
  assert.match(help.stdout, /rat milestone ls \[project\]/);
});
