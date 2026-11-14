import test from 'node:test';
import assert from 'node:assert/strict';

import { exportJsonl, exportMarkdown } from '../src/core/export.mjs';
import {
  changeStatus,
  createIssue,
  createMilestone,
  createProject,
  initDatabase,
  updateMilestone,
} from '../src/core/store.mjs';
import { createSandbox } from './helpers.mjs';

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
  'milestone',
  'created_at',
  'updated_at',
  'closed_at',
  'close_reason',
  'meta',
];

function setup(t, prefix = 'rat-m7-export-') {
  const box = createSandbox(t, prefix);
  const wrapper = box.open();
  initDatabase(wrapper);
  createProject(wrapper, { key: 'AXEL', name: 'Axel' });
  return { box, wrapper };
}

function parsedLines(content) {
  return content.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

function dbSnapshot(wrapper) {
  const count = (table) => wrapper.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    issues: count('issues'),
    events: count('events'),
    milestones: count('milestones'),
    updatedAt: wrapper.db.prepare('SELECT SUM(updated_at) AS sum FROM issues').get().sum,
  };
}

test('exportJsonl: milestone после ref, null у задачи без милстоуна', (t) => {
  const { wrapper } = setup(t);
  const milestone = createMilestone(wrapper, {
    project: 'AXEL',
    name: 'v1.0',
    due: '2026-01-01',
  });
  const attached = createIssue(wrapper, { project: 'AXEL', title: 'С милстоуном', milestone: milestone.name });
  const plain = createIssue(wrapper, { project: 'AXEL', title: 'Без милстоуна' });

  const lines = parsedLines(exportJsonl(wrapper, { project: 'AXEL' }));
  assert.equal(lines.length, 2);

  for (const line of lines) {
    assert.deepEqual(Object.keys(line), ISSUE_FIELD_ORDER);
    const refIndex = Object.keys(line).indexOf('ref');
    assert.equal(Object.keys(line).indexOf('milestone'), refIndex + 1);
  }

  const byId = new Map(lines.map((line) => [line.id, line]));
  assert.equal(byId.get(attached.id).milestone, 'v1.0');
  assert.equal(byId.get(plain.id).milestone, null);
});

test('exportMarkdown: блок «## Милстоуны» с прогрессом и сроком, милстоун в метаданных', (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'AXEL', name: 'v0.9' });
  updateMilestone(wrapper, { project: 'AXEL', ref: 'v0.9', state: 'closed' });
  createMilestone(wrapper, { project: 'AXEL', name: 'v1.0', due: '2026-01-01' });

  const first = createIssue(wrapper, { project: 'AXEL', title: 'Первая', milestone: 'v1.0' });
  const second = createIssue(wrapper, { project: 'AXEL', title: 'Вторая', milestone: 'v1.0' });
  const third = createIssue(wrapper, { project: 'AXEL', title: 'Третья', milestone: 'v1.0' });
  const cancelled = createIssue(wrapper, { project: 'AXEL', title: 'Отменённая', milestone: 'v1.0' });
  const open = createIssue(wrapper, { project: 'AXEL', title: 'Открытая', milestone: 'v1.0' });

  for (const issue of [first, second, third]) {
    changeStatus(wrapper, { ref: issue.id, status: 'done' });
  }
  changeStatus(wrapper, { ref: cancelled.id, status: 'cancelled' });
  // 3 done + 1 cancelled из 5 → floor(300 / 4) = 75%.
  changeStatus(wrapper, { ref: open.id, status: 'deferred' });

  const md = exportMarkdown(wrapper, { project: 'AXEL' });

  assert.match(md, /\n## Милстоуны\n/);
  assert.match(md, /- \*\*v1\.0\*\* · open · 3\/5 \(75%\) · до 2026-01-01/);
  assert.match(md, /- \*\*v0\.9\*\* · closed · 0\/0 \(0%\)(?! · до)/);
  assert.match(md, /милстоун: v1\.0/);

  // Милстоуны идут после сводки и до задач, open раньше closed.
  const summaryIndex = md.indexOf('Сводка:');
  const blockIndex = md.indexOf('## Милстоуны');
  const openIndex = md.indexOf('## Открытые');
  assert.ok(summaryIndex < blockIndex && blockIndex < openIndex);
  assert.match(md.slice(0, blockIndex), /Сводка:/);
  assert.ok(md.indexOf('v1.0** · open') < md.indexOf('v0.9** · closed'));
});

test('exportMarkdown: проект без милстоунов не печатает блок', (t) => {
  const { wrapper } = setup(t);
  createIssue(wrapper, { project: 'AXEL', title: 'Одна задача' });

  const md = exportMarkdown(wrapper, { project: 'AXEL' });
  assert.equal(md.includes('## Милстоуны'), false);
  assert.match(md, /милстоун: —/);
});

test('экспорт детерминирован и не меняет базу', (t) => {
  const { wrapper } = setup(t);
  createMilestone(wrapper, { project: 'AXEL', name: 'v1.0', due: '2026-01-01' });
  const issue = createIssue(wrapper, { project: 'AXEL', title: 'Задача', milestone: 'v1.0' });
  changeStatus(wrapper, { ref: issue.id, status: 'done', reason: 'ок' });

  const before = dbSnapshot(wrapper);
  const md1 = exportMarkdown(wrapper, { project: 'AXEL' });
  const md2 = exportMarkdown(wrapper, { project: 'AXEL', now: 0 });
  const jsonl1 = exportJsonl(wrapper, { project: 'AXEL' });
  const jsonl2 = exportJsonl(wrapper, { project: 'AXEL' });
  const after = dbSnapshot(wrapper);

  assert.equal(md1, md2);
  assert.equal(jsonl1, jsonl2);
  assert.deepEqual(after, before);
});
