import test from 'node:test';
import assert from 'node:assert/strict';

import { createSandbox, runCli, runCliAsync } from './helpers.mjs';

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

test('CLI: canon add с --body -, --priority, --label, --source, --json и --quiet', (t) => {
  const box = createSandbox(t, 'rat-m8-cli-');
  init(box);
  runCli(['add', 'Развилка', '--json'], { dbPath: box.dbPath });

  const created = runCli(
    [
      'canon', 'add', 'Только node:*', '--project', 'RAT',
      '--body', '-', '--priority', '1', '--label', 'runtime,deps',
      '--source', 'RAT-1', '--json',
    ],
    { dbPath: box.dbPath, input: 'Никаких npm-зависимостей\n' },
  );
  assert.equal(created.code, 0, created.stderr);
  const rule = json(created);
  assert.equal(rule.id, 'RAT-C1');
  assert.equal(rule.title, 'Только node:*');
  assert.equal(rule.body, 'Никаких npm-зависимостей');
  assert.equal(rule.priority, 1);
  assert.deepEqual(rule.labels, ['deps', 'runtime']);
  assert.equal(rule.source_issue, 'RAT-1');
  assert.equal(rule.status, 'active');

  const quiet = runCli(['canon', 'add', 'Второе', '--quiet'], { dbPath: box.dbPath });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(quiet.stdout.trim(), 'RAT-C2');
});

test('CLI: canon ls — таблица, --json, --state, --label, -q', (t) => {
  const box = createSandbox(t, 'rat-m8-cli-');
  init(box);
  runCli(['canon', 'add', 'Низкий', '--priority', '2', '--label', 'deps'], { dbPath: box.dbPath });
  runCli(['canon', 'add', 'Важное', '--priority', '0', '--label', 'runtime'], { dbPath: box.dbPath });
  runCli(['canon', 'add', 'Отменённое', '--priority', '1'], { dbPath: box.dbPath });
  runCli(['canon', 'repeal', 'RAT-C3', '--reason', 'нет'], { dbPath: box.dbPath });

  const table = runCli(['canon', 'ls', 'RAT'], { dbPath: box.dbPath });
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /PROJECT\s+ID\s+TITLE\s+P\s+STATUS\s+UPDATED/);
  assert.match(table.stdout, /RAT-C2/);
  assert.doesNotMatch(table.stdout, /RAT-C3/);

  const active = json(runCli(['canon', 'ls', 'RAT', '--json'], { dbPath: box.dbPath }));
  assert.deepEqual(active.canon.map((rule) => rule.id), ['RAT-C2', 'RAT-C1']);

  const all = json(runCli(['canon', 'ls', '--state', 'all', '--json'], { dbPath: box.dbPath }));
  assert.deepEqual(all.canon.map((rule) => rule.id), ['RAT-C2', 'RAT-C1', 'RAT-C3']);

  const byLabel = json(
    runCli(['canon', 'ls', 'RAT', '--label', 'deps', '--json'], { dbPath: box.dbPath }),
  );
  assert.deepEqual(byLabel.canon.map((rule) => rule.id), ['RAT-C1']);

  const byQuery = json(runCli(['canon', 'ls', 'RAT', '-q', 'важное', '--json'], { dbPath: box.dbPath }));
  assert.deepEqual(byQuery.canon.map((rule) => rule.id), ['RAT-C2']);

  const quiet = runCli(['canon', 'ls', 'RAT', '--quiet'], { dbPath: box.dbPath });
  assert.equal(quiet.stdout.trim(), 'RAT-C2\nRAT-C1');
});

test('CLI: canon ls --project отвергается с exit 2, проект — только позиционно', (t) => {
  const box = createSandbox(t, 'rat-m8-cli-');
  init(box);
  runCli(['canon', 'add', 'Правило', '--project', 'RAT'], { dbPath: box.dbPath });

  const res = runCli(['canon', 'ls', '--project', 'RAT', '--json'], { dbPath: box.dbPath });
  assert.equal(res.code, 2);
  assert.equal(errorOf(res).error.code, 'unknown_flag');
  assert.match(errorOf(res).error.message, /Неизвестный флаг --project/);

  const flagless = runCli(['canon', 'ls', '--project', '--json'], { dbPath: box.dbPath });
  assert.equal(flagless.code, 2);
  assert.equal(errorOf(flagless).error.code, 'unknown_flag');

  const byPosition = json(runCli(['canon', 'ls', 'RAT', '--json'], { dbPath: box.dbPath }));
  assert.deepEqual(byPosition.canon.map((rule) => rule.id), ['RAT-C1']);
});

test('CLI: canon show — полный адрес + несовпадающий --project → exit 2', (t) => {
  const box = createSandbox(t, 'rat-m8-cli-');
  init(box);
  runCli(['project', 'add', 'PRON', '--name', 'Pron'], { dbPath: box.dbPath });
  runCli(['canon', 'add', 'Правило', '--project', 'RAT'], { dbPath: box.dbPath });

  const mismatch = runCli(['canon', 'show', 'RAT-C1', '--project', 'PRON', '--json'], { dbPath: box.dbPath });
  assert.equal(mismatch.code, 2);
  assert.equal(errorOf(mismatch).error.code, 'invalid_arguments');

  const matching = runCli(['canon', 'show', 'RAT-C1', '--project', 'RAT', '--json'], { dbPath: box.dbPath });
  assert.equal(matching.code, 0, matching.stderr);
  assert.equal(json(matching).id, 'RAT-C1');
});

test('CLI: canon show — --json со всеми полями', (t) => {
  const box = createSandbox(t, 'rat-m8-cli-');
  init(box);
  runCli(['canon', 'add', 'Правило', '--body', 'Контекст', '--label', 'x'], { dbPath: box.dbPath });

  const shown = json(runCli(['canon', 'show', 'RAT-C1', '--json'], { dbPath: box.dbPath }));
  assert.equal(shown.id, 'RAT-C1');
  assert.equal(shown.title, 'Правило');
  assert.equal(shown.body, 'Контекст');
  assert.deepEqual(shown.labels, ['x']);
  assert.equal(shown.created_by, 'test');

  const scoped = json(runCli(['canon', 'show', 'C1', '--project', 'RAT', '--json'], { dbPath: box.dbPath }));
  assert.equal(scoped.id, 'RAT-C1');
});

test('CLI: canon edit — --title/--body/--priority/--label и stdin', (t) => {
  const box = createSandbox(t, 'rat-m8-cli-');
  init(box);
  runCli(['canon', 'add', 'Сырое', '--label', 'deps'], { dbPath: box.dbPath });

  const edited = runCli(
    [
      'canon', 'edit', 'RAT-C1', '--title', 'Готовое', '--body', '-',
      '--priority', '0', '--label', '+runtime,-deps', '--json',
    ],
    { dbPath: box.dbPath, input: 'Новый контекст\n' },
  );
  assert.equal(edited.code, 0, edited.stderr);
  const rule = json(edited);
  assert.equal(rule.title, 'Готовое');
  assert.equal(rule.body, 'Новый контекст');
  assert.equal(rule.priority, 0);
  assert.deepEqual(rule.labels, ['runtime']);
});

test('CLI: canon repeal/reactivate и повторные вызовы — exit 0', (t) => {
  const box = createSandbox(t, 'rat-m8-cli-');
  init(box);
  runCli(['canon', 'add', 'Правило'], { dbPath: box.dbPath });

  const repealed = json(runCli(['canon', 'repeal', 'RAT-C1', '--reason', 'устарело', '--json'], { dbPath: box.dbPath }));
  assert.equal(repealed.status, 'repealed');
  assert.equal(repealed.repeal_reason, 'устарело');

  const again = runCli(['canon', 'repeal', 'RAT-C1', '--json'], { dbPath: box.dbPath });
  assert.equal(again.code, 0, again.stderr);

  const active = json(runCli(['canon', 'reactivate', 'RAT-C1', '--json'], { dbPath: box.dbPath }));
  assert.equal(active.status, 'active');
  assert.equal(active.repealed_at, null);
  assert.equal(runCli(['canon', 'reactivate', 'RAT-C1'], { dbPath: box.dbPath }).code, 0);
});

test('CLI: canon add --supersedes через CLI отменяет старое', (t) => {
  const box = createSandbox(t, 'rat-m8-cli-');
  init(box);
  runCli(['canon', 'add', 'Старое'], { dbPath: box.dbPath });

  const created = json(
    runCli(['canon', 'add', 'Новое', '--supersedes', 'RAT-C1', '--json'], { dbPath: box.dbPath }),
  );
  assert.equal(created.supersedes, 'RAT-C1');

  const old = json(runCli(['canon', 'show', 'RAT-C1', '--json'], { dbPath: box.dbPath }));
  assert.equal(old.status, 'repealed');
  assert.equal(old.meta.superseded_by, 'RAT-C2');
});

test('CLI: коды выхода 1/2/3 для канона', (t) => {
  const box = createSandbox(t, 'rat-m8-cli-');
  init(box);
  runCli(['canon', 'add', 'Активное'], { dbPath: box.dbPath });

  const notFound = runCli(['canon', 'show', 'RAT-C9', '--json'], { dbPath: box.dbPath });
  assert.equal(notFound.code, 1);
  assert.equal(errorOf(notFound).error.code, 'canon_not_found');

  const badRef = runCli(['canon', 'show', 'мусор', '--json'], { dbPath: box.dbPath });
  assert.equal(badRef.code, 2);
  assert.equal(errorOf(badRef).error.code, 'invalid_canon_ref');

  const noSub = runCli(['canon', '--json'], { dbPath: box.dbPath });
  assert.equal(noSub.code, 2);
  assert.equal(errorOf(noSub).error.code, 'missing_subcommand');

  const noTitle = runCli(['canon', 'add', '--json'], { dbPath: box.dbPath });
  assert.equal(noTitle.code, 2);
  assert.equal(errorOf(noTitle).error.code, 'invalid_arguments');

  runCli(['canon', 'add', 'Замена', '--supersedes', 'RAT-C1', '--json'], { dbPath: box.dbPath });
  const conflict = runCli(['canon', 'add', 'Ещё', '--supersedes', 'RAT-C1', '--json'], { dbPath: box.dbPath });
  assert.equal(conflict.code, 3);
  assert.equal(errorOf(conflict).error.code, 'canon_not_active');

  const badSource = runCli(['canon', 'add', 'X', '--source', 'RAT-99', '--json'], { dbPath: box.dbPath });
  assert.equal(badSource.code, 1);
  assert.equal(errorOf(badSource).error.code, 'source_issue_not_found');
});

test('CLI: rat help canon содержит usage', (t) => {
  const box = createSandbox(t, 'rat-m8-cli-');
  init(box);

  const help = runCli(['canon', '--help'], { dbPath: box.dbPath });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /canon — канон проекта: add, ls, show, edit, repeal, reactivate/);
  assert.match(help.stdout, /rat canon add TITLE/);
  assert.match(help.stdout, /rat canon ls \[project\]/);
  assert.match(help.stdout, /rat canon repeal REF/);
});

test('CLI: 10 параллельных canon add → 10 разных номеров', async (t) => {
  const box = createSandbox(t, 'rat-m8-cli-');
  init(box);

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      runCliAsync(['canon', 'add', `Правило ${index}`, '--project', 'RAT', '--json'], {
        dbPath: box.dbPath,
      }),
    ),
  );
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
  }

  const ids = results.map((result) => json(result).id).sort();
  const unique = new Set(ids);
  assert.equal(unique.size, 10, `номера не уникальны: ${ids.join(', ')}`);
  assert.deepEqual(ids, [
    'RAT-C1', 'RAT-C10', 'RAT-C2', 'RAT-C3', 'RAT-C4', 'RAT-C5',
    'RAT-C6', 'RAT-C7', 'RAT-C8', 'RAT-C9',
  ]);
});