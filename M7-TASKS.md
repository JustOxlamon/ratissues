# M7 — план реализации (handoff для LLM-исполнителя)

Этот файл — рабочий план, а не источник требований. Источник требований —
`PLAN.md` (§3, §4, §5, §6, §8, §9, §10, §13). Если план и `PLAN.md` расходятся,
прав `PLAN.md`; если расходится с кодом — сначала прочитай код, потом правь
план, а не наоборот.

Правила работы: одна задача = один логический коммит, после каждой задачи
`node --test "tests/**/*.test.mjs"` зелёный. Ничего не удалять и не
переформатировать «попутно». В рабочем дереве уже есть незакоммиченные правки
M2 (статус `deferred`) — они часть базы, откатывать их нельзя.

---

## 1. Исходное состояние

Уже сделано и не требует повторной работы:

- `src/core/db.mjs`: `SCHEMA_VERSION = 3`, миграция `add milestones`:
  - таблица `milestones` (`id, project_key, name, name_key, body, due_at, state,
    created_at, updated_at, closed_at, meta`), `UNIQUE(project_key, name_key)`,
    `CHECK (state IN ('open','closed'))`, FK `project_key → projects(key)`;
  - `ALTER TABLE issues ADD COLUMN milestone_id INTEGER REFERENCES milestones(id)`;
  - индексы `idx_milestones_project_state`, `idx_issues_milestone`.
- `tests/init.test.mjs`: тесты v1→v3 и v2→v3 (данные целы, FK, уникальность,
  идемпотентность).
- `PLAN.md` §13, `AGENTS.md` и `README.md` содержат пометку «M7 только в плане».
  Пометку снимет задача M7.6.

Текущий набор: **103 теста, все зелёные**. Это база, которую нельзя сломать.

Рабочая `data/issues.db` пока schema v1; она мигрирует при следующем
`rat init`. Для экспериментов — только временная БД (`--db`/`RAT_DB`), рабочую
не трогать.

---

## 2. Жёсткие ограничения

Из `AGENTS.md` / `PLAN.md` §1, §11:

- Node 24, ESM, `.mjs`. В рантайме только `node:*` (`node:sqlite`, `node:http`,
  `node:test`). Никаких npm-зависимостей, сборки в рантайме, better-sqlite3,
  express, jest.
- `src/core/store.mjs` — **единственный писатель в БД**. CLI и HTTP API вызывают
  его, а не SQL напрямую. `query.mjs`/`events.mjs`/`export.mjs` — только чтение.
- `events` — append-only. Новый `kind` **не добавлять**: привязка/отвязка
  милстоуна пишется существующим `kind='edit'` с `field:"milestone"`.
- Удаления нет: у милстоуна только `open`/`closed`.
- Не добавлять авторизацию, синхронизацию, уведомления, вложения, подзадачи,
  спринты, time-tracking, git-интеграцию.
- Публичные контракты `--json`, ответов API и порядка полей jsonl — не ломать.
  Новые поля только добавляются.
- Документация и сообщения — по-русски, идентификаторы — по-английски.
- `web/app.css` коммитится; после правок `web/*` обязателен
  `npm run build:css`.

---

## 3. Контракты, которые фиксируем заранее

### 3.1. Публичное представление милстоуна

```js
{
  project: 'RAT',          // ключ проекта
  name: 'v1.2',
  body: '',
  due_at: 1767225600000,   // epoch ms | null
  state: 'open',           // 'open' | 'closed'
  created_at: 0,
  updated_at: 0,
  closed_at: null,         // epoch ms | null
  progress: {
    total: 0,              // все привязанные задачи, включая cancelled
    done: 0,
    cancelled: 0,
    percent: 0             // floor(done*100 / (total-cancelled)); 0 при знаменателе 0
  }
}
```

Внутренний `id` наружу не отдаётся: публичная ссылка — имя внутри проекта.

### 3.2. Задача

`serializeIssue()` получает поле `milestone: string | null` — имя или `null`.
Порядок ключей: сразу после `ref`, перед `created_at`. Это же попадает в
`rat ls --json`, `rat show --json`, `GET /api/issues*` и jsonl-экспорт.

### 3.3. Ошибки и коды выхода

| Ситуация | Ошибка | CLI | HTTP |
|---|---|---|---|
| милстоун не найден в проекте | `UsageError code='invalid_milestone'` | 2 | 400 |
| назначение в закрытый милстоун | `ConflictError code='milestone_closed'` | 3 | 409 |
| дубль имени в проекте | `ConflictError code='milestone_exists'` | 3 | 409 |
| милстоун не найден по имени | `NotFoundError code='milestone_not_found'` | 1 | 404 |
| пустое/слишком длинное имя | `UsageError code='invalid_milestone_name'` | 2 | 400 |
| неверный `due` | `UsageError code='invalid_due'` | 2 | 400 |
| нет `project` у PATCH | `UsageError code='invalid_project'` | 2 | 400 |

Различие важное: **чужой/несуществующий** милстоун при привязке — это
`invalid_milestone` (пользователь ошибся аргументом), а **закрытый** — конфликт
состояния.

### 3.4. Семантика привязки

- `milestone = undefined` — не менять.
- `milestone = null | '' | '-' | 'none'` — отвязать (`milestone_id = NULL`).
- `milestone = 'v1.2'` — привязать; искать только в проекте задачи.
- `NULL` — легальное состояние «без милстоуна». Синтетических записей,
  «Backlog», бэкфилла и массового назначения нет.
- Закрытие милстоуна не закрывает и не переносит задачи.
- Повторный `close`/`reopen` — идемпотентный no-op (возвращает текущее
  состояние без изменения `updated_at`).

---

## 4. M7.1 — core: `query.mjs` и `store.mjs`

### 4.1. `src/core/query.mjs` (только чтение)

Добавить:

```js
export const MILESTONE_STATES = Object.freeze(['open', 'closed']);

/** trim, проверка непустоты и длины ≤ 200 символов. */
export function normalizeMilestoneName(value) {}

/** trim + toLowerCase(); SQLite NOCASE не понижает регистр кириллицы. */
export function milestoneNameKey(name) {}

/** Строка milestones (+ агрегаты) → публичный объект из §3.1. */
export function serializeMilestone(row) {}

/** Сырая строка milestones (+ агрегаты) по имени в проекте. */
export function resolveMilestone(wrapperOrDb, { ref, projectKey }) {}

/** Публичное представление одного милстоуна; NotFoundError milestone_not_found. */
export function getMilestone(wrapper, { ref, project = null, projectKey = null, cwd, env } = {}) {}

/** Список с прогрессом. project=null → все неархивные проекты. */
export function listMilestones(wrapper, {
  project = null,        // ключ проекта или null
  state = 'open',        // 'open' | 'closed' | 'all'
  includeArchived = false,
  cwd,
  env,
} = {}) {}
```

`MILESTONE_SELECT` (константа рядом с `ISSUE_SELECT`) обязан сразу отдавать
агрегаты, иначе `updateMilestone` вернёт «нулевой» прогресс:

```sql
SELECT m.id, m.project_key, m.name, m.name_key, m.body, m.due_at, m.state,
       m.created_at, m.updated_at, m.closed_at, m.meta,
       (SELECT COUNT(*) FROM issues i WHERE i.milestone_id = m.id) AS total,
       (SELECT COUNT(*) FROM issues i WHERE i.milestone_id = m.id AND i.status = 'done') AS done,
       (SELECT COUNT(*) FROM issues i WHERE i.milestone_id = m.id AND i.status = 'cancelled') AS cancelled
FROM milestones m
```

`resolveMilestone`/`getMilestone` используют `MILESTONE_SELECT`;
`serializeMilestone` терпим к отсутствию агрегатов (0), но в store после
`INSERT`/`UPDATE` всегда перечитывать через `resolveMilestone`, а не собирать
объект из входных данных.

Требования:

- `normalizeMilestoneName`: строка, `trim()`, непустая, ≤ 200 символов;
  иначе `UsageError invalid_milestone_name`.
- `resolveMilestone`: `ref` — имя (не id). Сравнение по `project_key` +
  `name_key`. Если проекта нет или имя пустое — `UsageError invalid_milestone`.
  Не найдено — `NotFoundError milestone_not_found` с подсказкой
  `rat milestone ls`.
- `listMilestones`:
  - `project` задан → `resolveProject` (явный проект ищется даже в архиве);
  - `project = null` → все проекты, `includeArchived=false` по умолчанию;
  - `state` валидируется; `all` — без фильтра;
  - один SQL на базе `MILESTONE_SELECT` + `WHERE`/`ORDER BY` (агрегаты уже
    в подзапросах, `JOIN`/`GROUP BY` не нужны);
  - детерминированный порядок:
    `CASE m.state WHEN 'open' THEN 0 ELSE 1 END, (m.due_at IS NULL),
    m.due_at ASC, m.name_key ASC`;
  - возвращает `serializeMilestone(row)`.
- `ISSUE_SELECT`: добавить коррелированный подзапрос, **не JOIN** (SELECT
  переиспользуется в десятках запросов, JOIN размножит строки):

  ```sql
  (SELECT m.name FROM milestones m WHERE m.id = i.milestone_id) AS milestone
  ```

- `serializeIssue`: `milestone: row.milestone ?? null` после `ref`.
- `searchIssues`: новый параметр `milestone = null`:
  - пусто/`null` → без фильтра;
  - `'none'` (case-insensitive) → `i.milestone_id IS NULL`;
  - иначе `i.milestone_id IN (SELECT id FROM milestones WHERE name_key = ?)`
    (имя нормализуется через `milestoneNameKey`).
  - `where`/`params` собираются по месту, FTS-ветка и LIKE-ветка должны
    получить фильтр одинаково.

### 4.2. `src/core/store.mjs` (единственный писатель)

Импортировать из `query.mjs`: `milestoneNameKey`, `normalizeMilestoneName`,
`resolveMilestone`, `serializeMilestone`, `MILESTONE_STATES`.

Добавить публичные функции:

```js
/**
 * Создать милстоун. Проект — по правилам resolveProject.
 * @returns {object} публичное представление (§3.1, progress нулевой)
 */
export function createMilestone(wrapper, {
  project = null, projectKey = null,
  name, body = '', due = null, dueAt = null,
  cwd, env = process.env,
} = {}) {}

/**
 * Изменить имя/описание/срок/состояние. Все поля опциональны;
 * отсутствующие не меняются. Пустой вызов возвращает текущее состояние.
 * @returns {object}
 */
export function updateMilestone(wrapper, {
  ref, project = null, projectKey = null,
  name, body, due = null, dueAt = null, clearDue = false,
  state, cwd, env = process.env,
} = {}) {}
```

Внутренние помощники:

```js
/** 'YYYY-MM-DD' → 00:00 UTC epoch ms; число → как есть; null → null. */
function normalizeDueAt(value)

/** Привязка для задачи: возвращает строку milestones или null. */
function resolveMilestoneForIssue(db, projectKey, value)
```

`resolveMilestoneForIssue`:

- `null`/`''`/`'-'`/`'none'` → `null` (отвязка);
- имя → строка по `name_key` **в проекте задачи**; нет → `UsageError
  invalid_milestone`; `state !== 'open'` → `ConflictError milestone_closed`;
- возвращает `{ id, name }` (или `null`).

`createMilestone`:

- проект: `resolveProject(db, { project: projectKey ?? project, cwd, env })`;
- имя/body: `normalizeMilestoneName` + `normalizeBody` (тот же лимит 64 КБ);
- `due_at = normalizeDueAt(dueAt ?? due)`;
- `transaction(... 'IMMEDIATE')`: проверка дубля
  `SELECT id FROM milestones WHERE project_key = ? AND name_key = ?` →
  `ConflictError milestone_exists`; `INSERT`; перечитать через
  `resolveMilestone` и вернуть `serializeMilestone` (прогресс посчитается
  запросом, не руками).
- `events` не пишутся (жизненный цикл проектного уровня, как у проекта).
  `--idem` для милстоунов не делаем: дедуплицировать не по чему.

`updateMilestone`:

- проект: `resolveProject(db, { project: projectKey ?? project, cwd, env })`;
  милстоун: `resolveMilestone(db, { ref, projectKey: projectRow.key })`;
- `transaction('IMMEDIATE')`;
- `name`: новое имя + `name_key`; проверка дубля **кроме себя**
  (`AND id <> ?`) → `ConflictError milestone_exists`;
- `body` → `normalizeBody`;
- `dueAt`/`due` → `normalizeDueAt`; `clearDue` → `NULL`; если переданы и
  `dueAt`, и `clearDue` — `UsageError invalid_arguments`;
- `state`: одно из `MILESTONE_STATES`; `closed` ставит `closed_at = Date.now()`,
  `open` очищает `closed_at`; то же состояние — no-op;
- если ничего не изменилось — вернуть текущее представление без `UPDATE`;
- иначе `UPDATE ... SET ..., updated_at = ? WHERE id = ?`, перечитать через
  `resolveMilestone` и вернуть `serializeMilestone` (прогресс актуальный).

### 4.3. Привязка в `createIssue`

- Новый параметр `milestone = null`.
- После `resolveProject` (проект уже известен) вызвать
  `resolveMilestoneForIssue(db, projectRow.key, milestone)`.
- В `INSERT INTO issues(...)` добавить колонку `milestone_id` и значение
  (`attach?.id ?? null`). Больше ничего в порядке параметров не менять.
- В `created`-событие добавить `milestone` в `data`, только если он не `null`
  (аддитивно): `{ idem?, milestone? }`. Существующие тесты на `{}` не ломаются.

### 4.4. Привязка в `editIssue`

- `allowedFields` дополнить `'milestone'`.
- Для `changes.milestone !== undefined`:
  - `attach = resolveMilestoneForIssue(db, current.project, changes.milestone)`;
  - сравнить `attach?.name ?? null` с `current.milestone`;
  - если отличается — `updates.push({ field: 'milestone', column:
    'milestone_id', from: current.milestone, to: attach?.name ?? null,
    value: attach?.id ?? null })`.
- Применение SQL: колонка берётся как `update.column ?? update.field`,
  значение — `update.value !== undefined ? update.value :
  (update.field === 'labels' ? JSON.stringify(update.to) : update.to)`.
  **Это ключевая точка**: в событие идёт имя (`milestone`), в БД — id
  (`milestone_id`).
- Событие: `edit { field: 'milestone', from, to }` (имена или `null`).

### 4.5. Привязка в `updateIssue`

- Новый параметр `milestone` (см. семантику §3.4).
- В блок «2. Поля» добавить ветку, аналогичную `editIssue`, с тем же
  `{ field:'milestone', column:'milestone_id', value }`.
- В применении `edits` использовать ту же логику `column`/`value`.
- JSDoc и `allowedFields` не забыть (у `updateIssue` нет whitelist, но
  документировать параметр нужно).

### 4.6. `doctor`

В `src/core/store.mjs` добавить проверку (не ломая doctor на v1/v2):

```js
{
  id: 'milestones',
  ok: true,
  message: 'Милстоуны: 4 (open 2)',
}
```

- Если таблицы `milestones` нет (старая база) — `ok:false`,
  `message: 'Нет таблицы milestones — выполните rat init'`.
- Если таблица есть, но нет колонки `issues.milestone_id` — `ok:false`.
  Колонку проверять через `PRAGMA table_info(issues)` локальным помощником
  (приватный `columnExists` из `db.mjs` наружу не экспортировать).
- Иначе — количество и число открытых. Не включать `milestones` в
  `requiredTables`: старые базы должны получать внятную подсказку, а не
  «отсутствуют таблицы».

---

## 5. M7.2 — CLI

### 5.1. Новый файл `src/cli/commands/milestone.mjs`

Модель — `src/cli/commands/project.mjs`. Экспорт:

```js
export const meta = {
  name: 'milestone',
  summary: 'милстоуны: add, ls, edit, close, reopen',
  usage: [
    'rat milestone add NAME [--project K] [--due YYYY-MM-DD] [--body TEXT|-]',
    'rat milestone ls [project] [--state open|closed|all]',
    'rat milestone edit NAME [--project K] [--name NEW] [--due DATE] [--clear-due] [--body TEXT|-]',
    'rat milestone close NAME [--project K]',
    'rat milestone reopen NAME [--project K]',
  ].join('\n       '),
};

export function run(ctx) {}
```

Подкоманды:

| Подкоманда | `parseArgs` | Поведение |
|---|---|---|
| `add` | `values:['project','due','body']` | `--body -` → stdin (`readStdinText` + `trimTrailingNewline`); вернуть name в `--quiet`, объект в `--json` |
| `ls` | `values:['project','state']` | `state` по умолчанию `open`; без проекта — все неархивные; таблица `PROJECT NAME STATE PROGRESS DUE` |
| `edit` | `values:['project','name','due','body']`, `booleans:['clear-due']` | позиционный NAME — текущее имя; `--name` — новое |
| `close` | `values:['project']` | `updateMilestone({ state:'closed' })` |
| `reopen` | `values:['project']` | `updateMilestone({ state:'open' })` |

Детали:

- `--project` не задан: для `add/edit/close/reopen` — проект по правилам
  `resolveProject` (cwd → `$RAT_PROJECT` → ...), как у `rat add`; для `ls` —
  все неархивные.
- прогресс печатать как `done/(total−cancelled) (N%)`; `cancelled` не
  показывать отдельной колонкой, только в расчёте (иначе знаменатель врёт).
- `--due` показывать `YYYY-MM-DD` (UTC), не epoch.
- `--json` у `ls` → `{ milestones: [...] }`; у остальных — объект милстоуна.
- `--quiet` → только имя.
- Никакого `--idem`.
- Ошибки не перехватывать: `reportError` в `src/cli/index.mjs` сам отдаёт
  коды 1/2/3/4.

### 5.2. `src/cli/index.mjs`

- `import * as milestoneCommand from './commands/milestone.mjs';`
- добавить в `COMMAND_MODULES` после `projectCommand`.
- Справка строится из `COMMANDS` автоматически, отдельных правок не нужно.

### 5.3. `src/cli/commands/add.mjs`

- `values` += `'milestone'`.
- Передать `milestone: flags.milestone ?? null` в `createIssue`.
- Обновить `meta.usage` (`[--milestone NAME]`).

### 5.4. `src/cli/commands/edit.mjs`

- `values` += `'milestone'`.
- Если флаг присутствует — `changes.milestone = flags.milestone` (включая
  `-`/`none` для отвязки).
- Обновить `meta.usage` (`[--milestone NAME|-]`).
- Убедиться, что «нет изменений» по-прежнему даёт `UsageError`.

### 5.5. `src/cli/commands/ls.mjs`

- `values` += `'milestone'`.
- Передать `milestone: flags.milestone ?? null` в `searchIssues`.
- В человеческой таблице добавить колонку `MILESTONE` (`—` при `null`).
- Обновить `meta.usage` (`[--milestone NAME|none]`).

### 5.6. `src/cli/commands/show.mjs`

- В мета-строку задачи добавить `милстоун: <name>` (или `—`).
- `--json` уже получит поле через `serializeIssue`; править не нужно.

---

## 6. M7.3 — HTTP API (`src/server/api.mjs`)

Импортировать `createMilestone`, `updateMilestone` из `store.mjs`;
`getMilestone`, `listMilestones` из `query.mjs`.

### 6.1. GET

```js
GET /api/milestones?project=K&state=open|closed|all&all=true
→ 200 { milestones: [...] }
```

- `state` по умолчанию `open`; `all=true` — включить архивные проекты.
- `project` опционален; без него — все неархивные.

```js
GET /api/issues?...&milestone=NAME|none
```

- добавить `milestone` в вызов `searchIssues`.

### 6.2. POST

```js
POST /api/milestones
{ project?, name, body?, due_at? }   // due_at: epoch ms | 'YYYY-MM-DD'
→ 201 <milestone>
```

- `project` может быть опущен — сработают правила `resolveProject`
  (`body.project ?? null`).
- `actor` не нужен: событий нет.

### 6.3. PATCH

```js
PATCH /api/milestones/:ref?project=K
{ name?, body?, due_at?, clear_due?, state? }
→ 200 <milestone>
```

- `project` обязателен: сначала `url.searchParams.get('project')`, затем
  `body.project`; если нигде нет — `UsageError invalid_project` (400).
- Один вызов `updateMilestone` со всеми полями.
- `:ref` — имя (не id). `url.pathname` приходит percent-encoded, поэтому
  `decodeURIComponent(match[1])` обязателен (try/catch → `UsageError
  invalid_milestone`); иначе имя с пробелом/кириллицей не найдётся.

### 6.4. Остальное

- `POST /api/issues` и `PATCH /api/issues/:id`: пробросить `milestone` из body.
- 405: `PATCH/PUT /api/milestones` и `POST /api/milestones/:ref` — как у
  существующих ресурсов (`method_not_allowed`).
- SSE не менять: `issue.updated` уже покрывает перепривязку. Жизненный цикл
  милстоуна событий не пишет и в SSE не появляется — UI подтянет его следующим
  `refreshAll`/перезагрузкой.
- `Cache-Control: no-store` уже общий для API.

---

## 7. M7.4 — экспорт (`src/core/export.mjs`)

### 7.1. jsonl

- Ничего не делать сверх `serializeIssue`: поле `milestone` уже встанет после
  `ref`. Проверить, что порядок ключей совпадает с §3.2.
- События (`--events`) не меняются.

### 7.2. md

- `renderMeta(issue)`: добавить `милстоун: ${issue.milestone ?? '—'}` после
  `ref`.
- `renderProject(...)`: перед секцией «Открытые» добавить блок милстоунов,
  если у проекта они есть:

  ```md
  ## Милстоуны
  - **v1.2** · open · 3/5 (60%) · до 2026-01-01
  - **v1.1** · closed · 8/8 (100%)
  ```

  - источник — `listMilestones(wrapper, { project: project.key, state: 'all' })`
    (импорт из `query.mjs`, чтение);
  - `due_at` форматировать через существующий `formatTs` → `YYYY-MM-DD`
    (детерминизм: только данные, никакого `Date.now()`);
  - если милстоунов нет — блок не выводить;
  - прогресс — из `progress` (не пересчитывать в экспорте).
- Порядок секций: `# проект` → сводка → `## Милстоуны` → `## Открытые` →
  `## Отложенные` → `## Закрытые`.
- `buildMarkdown` считает `issues`/`events`; милстоуны в счётчики не входят.

### 7.3. Детерминизм

- Оба прогона экспорта на одной базе должны совпадать побайтово.
- Экспорт не пишет в БД: не вызывать `store.mjs`, только `query.mjs`.

---

## 8. M7.5 — web UI

Файлы: `web/index.html`, `web/app.js`, `web/tailwind.src.css` (если нужны
`@apply`), затем `npm run build:css` → закоммитить `web/app.css`.

### 8.1. Состояние и загрузка

- `state.milestone = ''` — фильтр списка (`''` — все, `'none'` — без
  милстоуна, иначе имя).
- `state.milestones = []` — открытые милстоуны текущего проекта.
- `loadMilestones(seq)`: `GET /api/milestones?state=open` (+ `&project=K`,
  если выбран проект); складывать в `state.milestones`.
- В `refreshAll()` добавить `loadMilestones(seq)` в общий `Promise.all`
  (рядом с `loadProjects`/`loadStats`). Учесть `isStale(seq)`.
- В `applyRoute`/смене проекта сбрасывать `state.milestone = ''`, если
  выбранный милстоун не принадлежит новому проекту (иначе фильтр молча
  показывает пустой список).
- SSE не меняется: `issue.created`/`issue.updated` уже вызывают
  `debouncedRefreshAll`, который теперь обновит и милстоуны. Закрытие
  милстоуна из CLI/API подхватится при следующем `refreshAll`/перезагрузке.

### 8.2. Фильтр списка

- В `#filters` (рядом с `label-filter`) добавить
  `<select id="milestone-filter">`.
- Показывать только когда выбран проект (`state.project`): имена уникальны
  только внутри проекта, глобальный фильтр по имени был бы двусмысленным.
- Опции: «все милстоуны» (`''`), «без милстоуна» (`'none'`), затем открытые
  милстоуны из `state.milestones`.
- В `renderIssueList` добавлять `params.set('milestone', state.milestone)`
  только при непустом значении.
- Сброс фильтров (`renderEmpty`) очищает и `state.milestone`.
- `renderEmpty` — добавить текст для пустой выборки по милстоуну.

### 8.3. Список задач

- В строке/карточке задачи показывать компактный чип `issue.milestone`
  (если не `null`), клик — фильтр по этому милстоуну.
- Не ломать `j/k`-навигацию: чип не должен перехватывать `Enter`.

### 8.4. Деталь задачи

- В мета-строке — чип милстоуна: `open`/`closed` визуально различать.
- Рядом со статус-панелью — `select` для назначения/снятия милстоуна
  (значения: `''` = без милстоуна, открытые милстоуны проекта).
- `change` → `PATCH /api/issues/:id { milestone: value || null }` →
  `await refreshAll()`; ошибку показать через существующий `showError`.
- Если задача привязана к закрытому милстоуну, `select` показывает его, но
  предупреждает, что он закрыт; повторное назначение закрытого вернёт 409.

### 8.5. Сайдбар

- Под каждым проектом — до 3 открытых милстоунов с мини-прогрессом
  (`done/total (N%)`) и полоской.
- Клик по милстоуну: `window.location.hash = '#/project/KEY'`,
  `state.milestone = name`, затем `renderIssueList()`.
- Прогресс обновляется тем же `refreshAll` (не отдельным таймером).

### 8.6. Модалка новой задачи

- В `web/index.html` добавить `select#new-milestone` после `new-project`.
- При смене проекта перезаполнять опции (открытые милстоуны проекта).
- В `POST /api/issues` добавить `milestone: value || null`.
- После успеха — существующий путь: закрыть модалку и `refreshAll()`.

### 8.7. Стили

- Использовать существующие утилиты (`bg-zinc-800`, `text-zinc-400`,
  `border-zinc-800`, `text-[10px]`, …).
- Если добавляются классы через `@apply` — правки в `web/tailwind.src.css`.
- После правок: `npm run build:css`; проверить, что `web/app.css` изменился
  и закоммичен.

---

## 9. M7.6 — документация

### `README.md`

- Строка состояния: «Готовы этапы **M0–M7**», убрать пометку «M7 только в
  плане».
- В таблицу команд добавить `rat milestone add|ls|edit|close|reopen`,
  `--milestone` у `add`/`edit`/`ls`.
- В раздел API — `/api/milestones`, `milestone` в issue-эндпоинтах.
- В описание экспорта — поле `milestone` и md-блок.
- В «Архитектуру» — `src/cli/commands/milestone.mjs`.

### `AGENTS.md`

- Убрать пункт «M7 … команд, API и UI ещё нет».
- Отметить M7 как готовый этап.
- В инварианты добавить: `NULL` — легальное состояние; закрытый милстоун
  нельзя назначать; прогресс `done/(total−cancelled)`; привязка — событие
  `edit {field:"milestone"}`; `name_key` вместо `COLLATE NOCASE`.
- Обновить число тестов (фактическое после M7).

### `PLAN.md`

- Требования уже описаны; менять только если реализация выявила противоречие.
  Не «подгонять» PLAN под код без причины.

---

## 10. Тесты

Новые файлы (по образцу существующих, `node:test`, своя временная БД):

### `tests/m7-store.test.mjs`

1. `createMilestone` → поля, `progress` нулевой, `due_at` из `YYYY-MM-DD`
   = 00:00 UTC.
2. Уникальность имени без учёта регистра: `v1.0` vs `V1.0` → 409/Conflict;
   **кириллица** `Бета` vs `бета` → конфликт (проверка, что не полагаемся на
   `COLLATE NOCASE`).
3. Одинаковое имя в разных проектах — норма.
4. `createIssue({ milestone })` привязывает; в `created`-событии есть
   `data.milestone`.
5. `editIssue` привязывает/отвязывает (`null`, `'-'`, `'none'`) и пишет
   ровно одно `edit {field:'milestone', from, to}`; при повторной привязке к
   тому же — событий нет.
6. `updateIssue` делает то же (вторая точка записи!).
7. Чужой проект → `UsageError invalid_milestone`.
8. Закрытый милстоун → `ConflictError milestone_closed`; после `reopen`
   привязка снова работает.
9. `close` не меняет статусы привязанных задач; `closed_at` ставится,
   `reopen` очищает.
10. Повторный `close`/`reopen` — no-op, `updated_at` не меняется.
11. Прогресс: `total=4`, `done=2`, `cancelled=1` → `percent=66`
    (floor 200/3); пустой милстоун → `percent=0`, без `NaN`.
12. Переименование не рвёт привязки (`milestone_id` тот же, задачи видят
    новое имя).
13. `searchIssues({ milestone })`: имя, `none`, регистронезависимость.

### `tests/m7-cli.test.mjs`

1. `milestone add` (в т.ч. `--body -`, `--due`), `--json`, `--quiet`.
2. `milestone ls` — таблица и `--json`, `--state closed|all`.
3. `milestone edit --name/--due/--clear-due/--body`.
4. `milestone close` / `reopen`, повторный вызов → exit 0.
5. `add --milestone v1.0`, `edit ID --milestone -`, `ls --milestone v1.0`,
   `ls --milestone none`.
6. Коды выхода: 1 (`milestone_not_found`), 2 (`invalid_milestone`,
   `invalid_due`), 3 (`milestone_closed`, `milestone_exists`).
7. `rat help milestone` содержит usage.

### `tests/m7-export.test.mjs`

1. jsonl: `milestone` присутствует и стоит после `ref`; `null` для задач без
   милстоуна.
2. md: блок `## Милстоуны` с прогрессом и `due`; в метаданных задачи
   `милстоун:`.
3. Два прогона побайтово совпадают.
4. БД после экспорта не изменилась (число строк/событий и `updated_at`
   задач).
5. Проект без милстоунов — блока нет.

### `tests/m7-api.test.mjs`

1. `POST /api/milestones` → 201, поля, `progress`.
2. `GET /api/milestones?project=K&state=all` → список, порядок.
3. `PATCH /api/milestones/:ref?project=K` — имя/срок/`state`; без `project`
   → 400 `invalid_project`; неизвестное имя → 404.
4. `GET /api/issues?milestone=...` и `=none`.
5. `POST/PATCH /api/issues` с `milestone`; ответ содержит имя.
6. Закрытый милстоун → 409 `milestone_closed`.
7. 405 на неподдерживаемые методы, 404 на `/api/milestones/x` без проекта?
   (нет — 400), на неизвестный путь — 404.
8. Схема issue из API совпадает с CLI-схемой (как в m4).

### Правки существующих тестов

- `tests/m4-api.test.mjs`: `ISSUE_KEYS` — вставить `'milestone'` после
  `'ref'`.
- `tests/m3-export.test.mjs`: `ISSUE_FIELD_ORDER` — то же.
- `tests/helpers.mjs`: `seedIssue` принимает `milestoneId = null` и пишет
  колонку (нужно для прямых фикстур).
- Прогнать все тесты; если ещё где-то есть точное сравнение ключей задачи —
  обновить осознанно, а не «чтобы прошло».

---

## 11. Порядок выполнения и проверки

Строго по шагам, после каждого — тесты:

1. **M7.1 core** → `node --test tests/m7-store.test.mjs tests/init.test.mjs`
2. **M7.2 CLI** → `node --test tests/m7-cli.test.mjs`
3. **M7.3 API** → `node --test tests/m7-api.test.mjs`
4. **M7.4 export** → `node --test tests/m7-export.test.mjs tests/m3-export.test.mjs`
5. **M7.5 UI** → `npm run build:css` + ручная проверка
6. **M7.6 docs** → полный прогон

Полная проверка:

```bash
node --test "tests/**/*.test.mjs"
npm run build:css
node bin/rat.mjs doctor --json
```

Ручная проверка на **временной** базе:

```bash
TMP=.../m7-check.db
node bin/rat.mjs init --db "$TMP"
node bin/rat.mjs project add DEMO --name "Demo" --db "$TMP"
node bin/rat.mjs milestone add v1.0 --project DEMO --due 2026-12-31 --db "$TMP"
node bin/rat.mjs add "первая" --project DEMO --milestone v1.0 --db "$TMP"
node bin/rat.mjs add "вторая" --project DEMO --milestone v1.0 --db "$TMP"
node bin/rat.mjs done DEMO-1 --db "$TMP"
node bin/rat.mjs milestone ls DEMO --db "$TMP"        # 1/2 (50%)
node bin/rat.mjs ls DEMO --milestone v1.0 --json --db "$TMP"
node bin/rat.mjs milestone close v1.0 --project DEMO --db "$TMP"
node bin/rat.mjs add "третья" --project DEMO --milestone v1.0 --db "$TMP"  # exit 3
node bin/rat.mjs export DEMO --out - --db "$TMP" | head -40
node bin/rat.mjs serve --db "$TMP" --port 4711
```

Временную базу после проверки удалить. Рабочую `data/issues.db` не трогать.

---

## 12. Definition of Done

- [ ] `node --test "tests/**/*.test.mjs"` — 0 провалов, новые тесты в наборе.
- [ ] `rat init` на v2-базе: версия 3, задачи/события/FTS целы, у старых задач
      `milestone_id = NULL`, `rat doctor` без `ok:false`.
- [ ] `rat milestone add|ls|edit|close|reopen` работают, `--json`/`--quiet`
      по общим правилам, коды выхода 1/2/3.
- [ ] `--milestone` в `add`/`edit`/`ls`; `none` фильтрует `NULL`.
- [ ] `PATCH /api/issues/:id` и `POST /api/issues` принимают `milestone`;
      `GET /api/issues` фильтрует; `GET/POST/PATCH /api/milestones` работают.
- [ ] Закрытый милстоун нельзя назначить (409/exit 3); чужой — 400/exit 2.
- [ ] Прогресс: `cancelled` не входит в знаменатель, пустой → 0%.
- [ ] jsonl: `milestone` после `ref`; md: блок милстоунов и `милстоун:` в
      метаданных; два прогона экспорта побайтово равны; БД не меняется.
- [ ] UI: фильтр (только при выбранном проекте), чип в детали, назначение в
      детали и модалке, прогресс в сайдбаре; `refreshAll` тянет милстоуны.
- [ ] `web/app.css` пересобран и закоммичен.
- [ ] README/AGENTS обновлены; пометка «M7 только в плане» удалена.
- [ ] Никаких npm-зависимостей, SQL в обход `store.mjs`, новых `events.kind`,
      изменений `SCHEMA_VERSION` (остаётся 3).

---

## 13. Вне scope M7

Не делать, даже если «по пути»:

- удаление/архивация милстоунов, перенос между проектами;
- вложенность, порядок, зависимости, «родительский» милстоун;
- автоматическое закрытие задач при `close`;
- массовое назначение (`rat milestone assign ...`);
- автоперенос незакрытых задач, velocity, timebox, спринты;
- semver-валидация имени, автонумерация версий;
- события `milestone.*` и SSE для них;
- отдельный экран управления милстоунами в UI (только CLI/API);
- изменение `projects`/`stats` API ради прогресса (UI берёт `/api/milestones`).

Если требование кажется нужным — остановись и спроси, а не расширяй M7.

---

## 14. Ловушки

1. **Две точки записи.** `editIssue` и `updateIssue` — оба должны уметь
   `milestone`. Пропуск любой = баг, который не поймает CLI-тест, но поймает
   API-тест.
2. **`editIssue` whitelist.** Без `'milestone'` в `allowedFields` правка
   упадёт с `invalid_field`.
3. **Имя поля ≠ колонка.** В событии `field: 'milestone'`, в БД —
   `milestone_id`. Использовать `column`/`value`, иначе SQL упадёт или
   запишет имя в INTEGER-колонку.
4. **Не JOIN, а подзапрос в `ISSUE_SELECT`.** `ISSUE_SELECT` используется
   десятками запросов; JOIN размножит строки и сломает пагинацию/экспорт.
5. **`name_key` в JS.** SQLite `COLLATE NOCASE` не понижает регистр
   кириллицы — тест с `Бета`/`бета` обязателен.
6. **Проект при привязке.** Искать милстоун строго в
   `issue.project_key`/`projectRow.key`, не в «текущем» проекте CLI и не
   глобально.
7. **Закрытый милстоун.** Проверять `state` при каждой привязке, а не только
   при создании; `reopen` должен снимать запрет.
8. **Идемпотентность.** Повторный `close` не должен обновлять `updated_at` и
   не должен падать — иначе UI/скрипты будут спотыкаться.
9. **`percent`.** Пустой милстоун и `total === cancelled` → 0, не `NaN` и не
   `null`. Округление — `Math.floor`.
10. **Порядок.** Списки милстоунов и секции экспорта должны иметь
    детерминированный `ORDER BY`; иначе тест детерминизма md/jsonl мигает.
11. **Не трогать `SCHEMA_VERSION`.** v3 уже в `db.mjs`; повторный bump
    сломает тесты миграции.
12. **Не пересобирать `issues`/`events`.** В v3 только `CREATE TABLE` +
    `ALTER TABLE`; FTS-триггеры не пересоздавать.
13. **`due_at`.** `YYYY-MM-DD` — это 00:00 **UTC**, не локальная полночь.
    Сравнение в тестах — по epoch ms.
14. **API `PATCH` без `project`.** Имя не глобально; без проекта — 400, не
    «первый попавшийся».
15. **Не добавлять `--idem`** милстоунам: у них нет событий, дедупликация
    невозможна.
16. **UI-фильтр по имени без проекта** двусмыслен (одинаковые имена в разных
    проектах) — показывать только при выбранном проекте.
17. **`refreshAll`.** Забыть `loadMilestones` = прогресс и фильтр не
    обновляются после мутаций/SSE.
18. **`npm run build:css`.** Без пересборки новые классы не попадут в
    `app.css`, и UI развалится только визуально — тесты этого не увидят.

---

## 15. Формат отчёта исполнителя

По завершении каждой задачи писать коротко:

```
M7.x: что сделано
Файлы: ...
Тесты: node --test ... → N pass / 0 fail
Отклонения от плана: ... (или «нет»)
Открытые вопросы: ... (или «нет»)
```

Не отмечать M7 готовым, пока не выполнены все пункты §12.
