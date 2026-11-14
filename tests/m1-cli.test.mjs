import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createSandbox, runCli, runCliAsync } from './helpers.mjs';

function json(result) {
  return JSON.parse(result.stdout);
}

function errorJson(result) {
  return JSON.parse(result.stderr);
}

test('CLI: полный цикл задачи — add → show → claim → comment → done → reopen → cancel', (t) => {
  const box = createSandbox(t, 'rat-m1-cli-');
  const dbPath = box.dbPath;

  assert.equal(runCli(['init'], { dbPath }).code, 0);

  const projectResult = runCli(
    ['project', 'add', 'axel', '--name', 'Axel', '--path', box.dir, '--color', 'sky', '--json'],
    { dbPath },
  );
  assert.equal(projectResult.code, 0, projectResult.stderr);
  const project = json(projectResult);
  assert.equal(project.key, 'AXEL');
  assert.equal(project.name, 'Axel');
  assert.equal(project.color, 'sky');
  assert.equal(project.root_path, path.resolve(box.dir));

  const addResult = runCli(
    [
      'add',
      'Первая задача',
      '--project',
      'axel',
      '--body',
      'Тело задачи',
      '--label',
      'B, a , a',
      '--priority',
      '1',
      '--ref',
      'src/x.mjs',
      '--json',
    ],
    { dbPath },
  );
  assert.equal(addResult.code, 0, addResult.stderr);
  const created = json(addResult);
  assert.equal(created.id, 'AXEL-1');
  assert.equal(created.project, 'AXEL');
  assert.equal(created.title, 'Первая задача');
  assert.equal(created.body, 'Тело задачи');
  assert.equal(created.status, 'open');
  assert.equal(created.priority, 1);
  assert.deepEqual(created.labels, ['a', 'b']);
  assert.equal(created.ref, 'src/x.mjs');
  assert.equal(created.assignee, null);
  assert.equal(created.deduplicated, false);

  const initialShow = runCli(['show', 'axel-1', '--json'], { dbPath });
  assert.equal(initialShow.code, 0, initialShow.stderr);
  const initialDetail = json(initialShow);
  assert.equal(initialDetail.issue.status, 'open');
  assert.deepEqual(initialDetail.events.map((event) => event.kind), ['created']);
  assert.equal(initialDetail.events[0].actor, 'test');

  const claimResult = runCli(['claim', 'AXEL-1', '--json'], { dbPath });
  assert.equal(claimResult.code, 0, claimResult.stderr);
  const claimed = json(claimResult);
  assert.equal(claimed.issue.status, 'doing');
  assert.equal(claimed.issue.assignee, 'test');
  assert.equal(claimed.event.kind, 'claim');
  assert.deepEqual(claimed.event.data, { from: 'open', to: 'doing', assignee: 'test' });

  const commentResult = runCli(['comment', 'AXEL-1', 'Сделано, файлы: src/x.mjs', '--json'], {
    dbPath,
  });
  assert.equal(commentResult.code, 0, commentResult.stderr);
  const comment = json(commentResult);
  assert.equal(comment.kind, 'comment');
  assert.equal(comment.issue, 'AXEL-1');
  assert.equal(comment.data.text, 'Сделано, файлы: src/x.mjs');
  assert.equal(comment.actor, 'test');

  const middleShow = json(runCli(['show', 'AXEL-1', '--json'], { dbPath }));
  assert.deepEqual(middleShow.events.map((event) => event.kind), ['created', 'claim', 'comment']);
  assert.equal(middleShow.issue.status, 'doing');
  assert.equal(middleShow.issue.updated_at, middleShow.events.at(-1).ts);

  const doneResult = runCli(['done', 'AXEL-1', '--reason', 'готово', '--json'], { dbPath });
  assert.equal(doneResult.code, 0, doneResult.stderr);
  const done = json(doneResult);
  assert.equal(done.issue.status, 'done');
  assert.equal(done.issue.close_reason, 'готово');
  assert.equal(done.issue.closed_at, done.event.ts);
  assert.equal(done.event.data.from, 'doing');
  assert.equal(done.event.data.to, 'done');
  assert.equal(done.event.data.reason, 'готово');

  const reopenResult = runCli(['reopen', 'AXEL-1', '--json'], { dbPath });
  assert.equal(reopenResult.code, 0, reopenResult.stderr);
  const reopened = json(reopenResult);
  assert.equal(reopened.issue.status, 'open');
  assert.equal(reopened.issue.closed_at, null);
  assert.equal(reopened.issue.close_reason, null);

  const cancelResult = runCli(['cancel', 'AXEL-1', '--reason', 'не нужно', '--json'], { dbPath });
  assert.equal(cancelResult.code, 0, cancelResult.stderr);
  const cancelled = json(cancelResult);
  assert.equal(cancelled.issue.status, 'cancelled');
  assert.equal(cancelled.issue.close_reason, 'не нужно');
  assert.equal(cancelled.issue.closed_at, cancelled.event.ts);

  const finalShow = runCli(['show', 'AXEL-1', '--json'], { dbPath });
  assert.equal(finalShow.code, 0, finalShow.stderr);
  const finalDetail = json(finalShow);
  assert.deepEqual(
    finalDetail.events.map((event) => event.kind),
    ['created', 'claim', 'comment', 'status', 'status', 'status'],
  );
  assert.equal(finalDetail.issue.updated_at, finalDetail.events.at(-1).ts);
  assert.equal(finalDetail.issue.closed_at, finalDetail.events.at(-1).ts);

  const humanShow = runCli(['show', 'AXEL-1'], { dbPath });
  assert.equal(humanShow.code, 0, humanShow.stderr);
  assert.match(humanShow.stdout, /AXEL-1\s+Первая задача/);
  assert.match(humanShow.stdout, /Тело задачи/);
  assert.match(humanShow.stdout, /События \(6\)/);
  assert.equal(humanShow.stdout.includes('\u001b['), false);

  const projectsResult = runCli(['project', 'ls', '--json'], { dbPath });
  assert.equal(projectsResult.code, 0, projectsResult.stderr);
  const axel = json(projectsResult).projects.find((entry) => entry.key === 'AXEL');
  assert.deepEqual(axel.counts, {
    open: 0,
    doing: 0,
    blocked: 0,
    deferred: 0,
    done: 0,
    cancelled: 1,
    total: 1,
  });
});

test('CLI: проект определяется по cwd через root_path', (t) => {
  const box = createSandbox(t, 'rat-m1-cli-');
  const dbPath = box.dbPath;
  assert.equal(runCli(['init'], { dbPath }).code, 0);

  const projectResult = runCli(
    ['project', 'add', 'AXEL', '--name', 'Axel', '--path', box.dir, '--json'],
    { dbPath },
  );
  assert.equal(projectResult.code, 0, projectResult.stderr);

  const fromCwd = runCli(['add', 'Из cwd', '--json'], { dbPath, cwd: box.dir });
  assert.equal(fromCwd.code, 0, fromCwd.stderr);
  const issue = json(fromCwd);
  assert.equal(issue.project, 'AXEL');
  assert.equal(issue.id, 'AXEL-1');
});

test('CLI: JSON-схемы add / show / comment / status / project зафиксированы', (t) => {
  const box = createSandbox(t, 'rat-m1-cli-');
  const dbPath = box.dbPath;
  assert.equal(runCli(['init'], { dbPath }).code, 0);

  const project = json(
    runCli(
      ['project', 'add', 'AXEL', '--name', 'Axel', '--path', box.dir, '--color', 'sky', '--json'],
      { dbPath },
    ),
  );
  assert.deepEqual(Object.keys(project).sort(), [
    'archived_at',
    'color',
    'created_at',
    'key',
    'name',
    'root_path',
  ]);

  const projectList = json(runCli(['project', 'ls', '--json'], { dbPath }));
  assert.deepEqual(Object.keys(projectList), ['projects']);
  assert.deepEqual(Object.keys(projectList.projects[0]).sort(), [
    'archived_at',
    'color',
    'counts',
    'created_at',
    'key',
    'name',
    'root_path',
  ]);
  assert.deepEqual(Object.keys(projectList.projects[0].counts).sort(), [
    'blocked',
    'cancelled',
    'deferred',
    'doing',
    'done',
    'open',
    'total',
  ]);

  const issue = json(runCli(['add', 'Схема', '--json'], { dbPath }));
  assert.deepEqual(Object.keys(issue).sort(), [
    'assignee',
    'body',
    'close_reason',
    'closed_at',
    'created_at',
    'deduplicated',
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
  ]);

  const detail = json(runCli(['show', issue.id, '--json'], { dbPath }));
  assert.deepEqual(Object.keys(detail), ['issue', 'events']);
  assert.deepEqual(Object.keys(detail.issue).sort(), [
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
  ]);
  assert.deepEqual(Object.keys(detail.events[0]).sort(), [
    'actor',
    'data',
    'id',
    'issue',
    'kind',
    'project',
    'ts',
  ]);

  const comment = json(runCli(['comment', issue.id, 'Схема комментария', '--json'], { dbPath }));
  assert.deepEqual(Object.keys(comment).sort(), [
    'actor',
    'data',
    'deduplicated',
    'id',
    'issue',
    'kind',
    'project',
    'ts',
  ]);

  const status = json(runCli(['status', issue.id, 'blocked', '--json'], { dbPath }));
  assert.deepEqual(Object.keys(status).sort(), ['event', 'issue']);
  assert.equal(status.issue.status, 'blocked');
  assert.equal(status.event.kind, 'status');
});

test('CLI: коды выхода 1/2/3 и подсказка reopen', (t) => {
  const box = createSandbox(t, 'rat-m1-cli-');
  const dbPath = box.dbPath;
  assert.equal(runCli(['init'], { dbPath }).code, 0);
  const issue = json(runCli(['add', 'Коды выхода', '--json'], { dbPath }));

  assert.equal(runCli(['done', issue.id], { dbPath }).code, 0);

  const doneAgain = runCli(['done', issue.id, '--json'], { dbPath });
  assert.equal(doneAgain.code, 3);
  const conflict = errorJson(doneAgain);
  assert.equal(conflict.error.code, 'issue_closed');
  assert.match(conflict.error.hint, new RegExp(`rat reopen ${issue.id}`));

  const cancelAfterDone = runCli(['cancel', issue.id, '--json'], { dbPath });
  assert.equal(cancelAfterDone.code, 3);

  const badStatus = runCli(['status', issue.id, 'nope', '--json'], { dbPath });
  assert.equal(badStatus.code, 2);
  assert.equal(errorJson(badStatus).error.code, 'invalid_status');

  const notFound = runCli(['show', 'NOPE-999', '--json'], { dbPath });
  assert.equal(notFound.code, 1);
  assert.equal(errorJson(notFound).error.code, 'issue_not_found');

  const unknownSubcommand = runCli(['project', 'frobnicate', '--json'], { dbPath });
  assert.equal(unknownSubcommand.code, 2);
  assert.equal(errorJson(unknownSubcommand).error.code, 'unknown_subcommand');

  const missingTitle = runCli(['add', '--json'], { dbPath });
  assert.equal(missingTitle.code, 2);
  assert.equal(errorJson(missingTitle).error.code, 'missing_title');

  const unknownFlag = runCli(['add', 'Задача', '--bogus', '--json'], { dbPath });
  assert.equal(unknownFlag.code, 2);
  assert.equal(errorJson(unknownFlag).error.code, 'unknown_flag');

  const extraArg = runCli(['show', issue.id, 'лишнее', '--json'], { dbPath });
  assert.equal(extraArg.code, 2);
  assert.equal(errorJson(extraArg).error.code, 'invalid_arguments');

  const emptyComment = runCli(['comment', issue.id, '--json'], { dbPath });
  assert.equal(emptyComment.code, 2);
  assert.equal(errorJson(emptyComment).error.code, 'empty_comment');
});

test('CLI: --body - и комментарий из stdin, --quiet печатает только id', (t) => {
  const box = createSandbox(t, 'rat-m1-cli-');
  const dbPath = box.dbPath;
  assert.equal(runCli(['init'], { dbPath }).code, 0);

  const added = runCli(['add', 'Из stdin', '--body', '-', '--quiet'], {
    dbPath,
    input: 'тело из stdin\n',
  });
  assert.equal(added.code, 0, added.stderr);
  assert.equal(added.stdout, 'RAT-1\n');

  const detail = json(runCli(['show', 'RAT-1', '--json'], { dbPath }));
  assert.equal(detail.issue.body, 'тело из stdin');

  const commented = runCli(['comment', 'RAT-1', '-', '--quiet'], {
    dbPath,
    input: 'комментарий из stdin\n',
  });
  assert.equal(commented.code, 0, commented.stderr);
  assert.equal(commented.stdout.trim(), String(detail.events[0].id + 1));

  const afterComment = json(runCli(['show', 'RAT-1', '--json'], { dbPath }));
  assert.equal(afterComment.events.at(-1).kind, 'comment');
  assert.equal(afterComment.events.at(-1).data.text, 'комментарий из stdin');

  const lowerCase = json(runCli(['show', 'rat-1', '--json'], { dbPath }));
  assert.equal(lowerCase.issue.id, 'RAT-1');

  const internalId = box.open().db.prepare('SELECT id FROM issues WHERE project_key = ? AND num = ?').get('RAT', 1).id;
  const byInternalId = json(runCli(['show', String(internalId), '--json'], { dbPath }));
  assert.equal(byInternalId.issue.id, 'RAT-1');
});

test('CLI: --idem для add и comment не создаёт дубль', (t) => {
  const box = createSandbox(t, 'rat-m1-cli-');
  const dbPath = box.dbPath;
  assert.equal(runCli(['init'], { dbPath }).code, 0);

  const first = json(runCli(['add', 'Идем', '--idem', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--json'], { dbPath }));
  const second = json(runCli(['add', 'Идем', '--idem', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--json'], { dbPath }));
  assert.equal(first.id, 'RAT-1');
  assert.equal(second.id, 'RAT-1');
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);

  const c1 = json(runCli(['comment', 'RAT-1', 'Идем', '--idem', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '--json'], { dbPath }));
  const c2 = json(runCli(['comment', 'RAT-1', 'Идем', '--idem', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '--json'], { dbPath }));
  assert.equal(c1.id, c2.id);
  assert.equal(c1.deduplicated, false);
  assert.equal(c2.deduplicated, true);

  const wrapper = box.open();
  assert.equal(wrapper.db.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 1);
  assert.equal(
    wrapper.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'created'").get().n,
    1,
  );
  assert.equal(
    wrapper.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'comment'").get().n,
    1,
  );
});

test('CLI: 10 параллельных add → RAT-1..RAT-10 без дублей', async (t) => {
  const box = createSandbox(t, 'rat-m1-cli-');
  const dbPath = box.dbPath;
  assert.equal(runCli(['init'], { dbPath }).code, 0);

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      runCliAsync(['add', `Параллельная ${index + 1}`, '--json'], { dbPath }),
    ),
  );

  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
  }
  const issues = results.map((result) => json(result));
  assert.equal(new Set(issues.map((issue) => issue.id)).size, 10);

  const byNum = issues
    .slice()
    .sort((a, b) => a.num - b.num)
    .map((issue) => issue.id);
  assert.deepEqual(byNum, Array.from({ length: 10 }, (_, index) => `RAT-${index + 1}`));

  const wrapper = box.open();
  assert.equal(wrapper.db.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 10);
  assert.equal(
    wrapper.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'created'").get().n,
    10,
  );
});
