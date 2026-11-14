---
name: rat
description: "Use when tracking work in the local rat task tracker (RAT-1 style ids, `rat` CLI): listing or picking the next task, claiming/starting work, commenting progress, closing tasks, adding tasks, searching the backlog, managing milestones (вехи v1.0), managing project canon rules (канон — «делай так / не делай так»), or exporting project context. Also use when the user says «возьми задачу», «что дальше», «заведи задачу», «закоммить итог в трекер», mentions rat, RAT-n, a milestone, a canon rule (канон), or a project tracked in the local issue DB."
---

# rat — локальный трекер задач

`rat` — CLI поверх SQLite. Его можно поставить глобально тонкой обёрткой над
`bin/rat.mjs`, а в этом репозитории без установки используй
`node bin/rat.mjs …` (на Windows — `bin\rat.cmd …`).

База: `--db <path>` или `$RAT_DB`; иначе дефолт запуска — `data/issues.db`
в репозитории (глобальная обёртка обычно подставляет `~/.rat/issues.db`).

Правила: **никакого прямого SQL** — только CLI (или HTTP API через `rat serve`).
Задачи не удаляются: закрытие — `done`/`cancel`, ошибка в статусе — `reopen`.
Комментарии неизменяемы: уточнение — новый комментарий.

Статусы: `open | doing | blocked | deferred | done | cancelled`. `deferred`
(отложено) — открытый статус: в `active` и `rat next` не попадает, `closed_at`
не заполняет, и уйти из него можно свободно (без `reopen`). Отложенная задача —
это «припарковано на потом», а не закрыто.

## Цикл работы

```bash
rat next --json                 # что делать дальше (priority asc, затем старые)
rat claim RAT-7                 # doing + assignee = $RAT_ACTOR
# ... работа ...
rat comment RAT-7 --body - <<'EOF'
Сделано: ...
Файлы: ...
Коммит: ...
EOF
rat done RAT-7 --reason "тесты зелёные"
```

`--actor <name>` или `$RAT_ACTOR` пишется в `events.actor`. **Всегда** передавай
свой идентификатор (например `--actor opencode`), иначе событие подпишется `cli`
и в `rat log` будет непонятно, кто что сделал.

## Команды

| Команда | Что делает |
|---|---|
| `rat init` | создать/мигрировать базу (идемпотентно) |
| `rat doctor` | проверки: схема, WAL, FTS5, целостность |
| `rat project add KEY --name "..."` | новый проект (`--path DIR` — якорь для автодетекта) |
| `rat project ls` | проекты и счётчики (`--all` с архивом) |
| `rat project archive KEY` | скрыть проект, задачи остаются |
| `rat milestone add NAME` | новая веха (`--project K`, `--due YYYY-MM-DD`, `--body TEXT\|-`) |
| `rat milestone ls [project]` | вехи с прогрессом `done/total (N%)` (`--state open\|closed\|all`) |
| `rat milestone edit NAME` | `--name`, `--body`, `--due`, `--clear-due`; пустой вызов — показать |
| `rat milestone close NAME` / `reopen NAME` | закрыть/открыть (повтор — no-op) |
| `rat canon add TITLE` | новое канон-правило (`--body T\|-`, `--priority 0..3`, `--label a,b`, `--source RAT-7`, `--supersedes KEY-Cn`) |
| `rat canon ls [project]` | активные правила канона (`--state active\|repealed\|all`, `--label`, `-q`) |
| `rat canon show REF` | одно правило (поля, источник, замена/отмена) |
| `rat canon edit REF` | правка полей правила (`--title`, `--body`, `--priority`, `--label +a,-b`) |
| `rat canon repeal REF` / `reactivate REF` | отменить / вернуть правило (`--reason`) |
| `rat add "title"` | создать (`--project K`, `--body TEXT\|-`, `--label a,b`, `--priority 0..3`, `--ref`, `--milestone NAME`, `--assignee`, `--idem UUID`) |
| `rat ls [project]` | список (`-s open\|doing\|blocked\|deferred\|done\|cancelled\|active\|all`, `--label`, `--milestone NAME\|none`, `--priority`, `-q TEXT`, `--limit`, `--sort pri\|updated`, `--all`) |
| `rat show ID` | задача + последние события (`--events N`), в выводе есть милстоун |
| `rat edit ID` | правка полей (`--title`, `--body`, `--priority`, `--label +x,-y`, `--assignee`, `--ref`, `--milestone NAME\|-`) |
| `rat status ID <status>` | `open \| doing \| blocked \| deferred \| done \| cancelled` (`--reason`) |
| `rat done/cancel/reopen ID` | сахар над `status` |
| `rat claim ID` | `doing` + assignee = actor |
| `rat comment ID [text\|-]` | неизменяемый комментарий |
| `rat next [project]` | следующая открытая задача |
| `rat log [project]` | лента событий (`--since 1d\|ISO`, `--kind`, `--limit`) |
| `rat stats` | счётчики по проектам/статусам/приоритетам |
| `rat export [project]` | снапшот (`--format md\|jsonl`, `--out -`, `--events`, `--all`) |
| `rat serve` | web UI + JSON API, только loopback (`--port 4711`) |

Глобальные флаги в любом месте argv: `--json`, `--quiet`, `--db <path>`,
`--actor <name>`, `-h`.

## Милстоуны (вехи)

Милстоун — необязательная веха внутри проекта (`v1.0`, `M7`, «релиз»). У задачи
не больше одной вехи; имя уникально внутри проекта без учёта регистра (включая
кириллицу).

```bash
rat milestone add v1.0 --project AXEL --due 2026-12-31
rat milestone ls AXEL --state all
rat add "Починить экспорт" --project AXEL --milestone v1.0
rat ls AXEL --milestone v1.0 --json     # только задачи вехи
rat ls AXEL --milestone none --json     # только задачи без вехи
rat edit AXEL-3 --milestone -           # снять веху ('-' или 'none')
rat milestone close v1.0 --project AXEL
rat milestone reopen v1.0 --project AXEL
```

- Прогресс: `done / (total − cancelled)`, процент округляется вниз; пустая веха
  даёт `0/0 (0%)`. Закрытие вехи не меняет статусы задач.
- Закрытую веху нельзя назначить новой задаче — exit `3` (`milestone_closed`).
  Сначала `rat milestone reopen`.
- `--milestone -` / `none` при правке снимает привязку; у `add` значение только имя.
- В истории привязка/отвязка — обычное событие `edit` с `field: "milestone"`,
  отдельного `kind` нет.
- Удаления нет: веха бывает `open` или `closed`, `rat milestone close` — это
  архив, а не удаление.
- API: `GET/POST /api/milestones`, `PATCH /api/milestones/:ref?project=K`; в
  задачах поле `milestone` (имя или `null`), фильтр `?milestone=none`.
- Экспорт: в `md` — блок `## Милстоуны` и `милстоун:` в мете задачи; в `jsonl`
  поле `milestone` стоит после `ref`.

## Канон (правила проекта)

Канон — актуальные решения проекта из развилок («делай так / вот так не
делай»). У правила есть директива (`title`), контекст (`--body`), приоритет,
метки и опциональный источник развилки (`--source RAT-7`). Адрес — `KEY-C1`
(номер по проекту). Это то, что оператор и LLM должны знать о проекте наверняка.

```bash
rat canon ls --project AXEL --json           # актуальные правила (читай перед работой)
rat canon add "Не добавлять npm-зависимости" --project AXEL --body "только node:*" --source AXEL-7
rat canon add "Перешли на vite" --project AXEL --supersedes AXEL-C1   # ставит AXEL-C1 в repealed
rat canon show AXEL-C2 --json
rat canon edit AXEL-C2 --body "..." --label +runtime,-deps
rat canon repeal AXEL-C2 --reason "развилка решена иначе"   # повтор — no-op
rat canon reactivate AXEL-C2                                 # вернуть в активные
```

- Перед работой в проекте читай активные правила: `rat canon ls --project K
  --json`; после прохождения развилки фиксируй решение `rat canon add …`.
- `active`/`repealed`: отменённое правило остаётся видимым (`rat canon ls
  --state all`), удаления нет. `--supersedes` помечает заменённое правило
  «заменено правилом KEY-Cn» и ставит ссылку на новое.
- Канон не пишет событий в `events` (как милстоуны): аудит — в полях записи
  (`created_by`/`repealed_by`/`repeal_reason` + `supersedes`/`superseded_by`).
- API: `GET/POST /api/canon`, `PATCH /api/canon/:ref?project=K`
  (`state: "repealed" | "active"`; `project` обязателен в query или теле).
- В контекст LLM правила попадают первыми: `rat export --format jsonl --events
  --out -` начинается с `{"type":"canon",…}`; в `md` — блок `## Канон`.

## Дешёвое чтение

- `rat show ID --json` — задача + последние события;
- `rat ls --json` — компактный список;
- `rat log --since 1d --json` — что произошло;
- `rat export --format jsonl --events --out -` — весь контекст проекта одним
  потоком для загрузки в контекст.

## Идемпотентность и stdin

- `--idem <uuid>` у `add`/`comment`: повтор с тем же uuid не создаёт дубль.
- `--body -` и `--title -` читают stdin — длинные тексты без экранирования кавычек.

## Коды выхода (важнее текста ошибки)

`0` ok · `1` не найдено · `2` ошибка использования · `3` конфликт перехода
статуса/состояния (в т.ч. `milestone_closed`) · `4` ошибка БД/записи (в т.ч.
`schema_outdated`).

## Обновление схемы после апгрейда rat

Миграции применяет только `rat init` — остальные команды схему не догоняют.
Если после обновления `rat` команда падает с `schema_outdated` (exit `4`),
выполни:

```bash
rat init        # идемпотентно, данные сохраняются
rat doctor      # проверить: схема, WAL, FTS5, milestones
```

То же касается базы, созданной старой версией: `doctor` покажет FAIL по схеме,
а не «no such table». Перед миграцией рабочей базы можно снять `rat backup`.

## Проект определяется автоматически

`--project` → `$RAT_PROJECT` → самый длинный `root_path`, являющийся префиксом cwd →
`meta.default_project`. Если cwd не привязан ни к одному проекту — передавай
`--project KEY` явно (или заведи `rat project add KEY --name "..." --path $PWD`).

## Новая база / новый проект

```bash
rat init
rat project add AXEL --name "Axel" --path "/path/to/axel"   # якорь для автодетекта
rat add "Первый шаг" --project AXEL --priority 1 --label setup
```
