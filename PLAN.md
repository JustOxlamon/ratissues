# RatIssues — план

Локальный трекер задач для множества мелких проектов. Одна SQLite-база на всё,
CLI с JSON-выводом для LLM + простой web UI (Tailwind, dark) для человека.
Ноль внешних зависимостей в рантайме: Node 24 + встроенный `node:sqlite`.

---

## 1. Принципы

1. **Одна база, много проектов.** `project_key` внутри записи, а не база на проект.
   Кросс-проектные выборки («что открыто везде», «что я делал вчера») — бесплатно.
2. **События — источник истории.** Каждое изменение = append-only запись в `events`.
   Удаления нет. Отмена — это статус `cancelled`, а не `DELETE`.
3. **CLI — первый интерфейс.** Web UI — тонкий клиент над тем же HTTP API.
   Агент ходит через CLI (`--json`), человек — через браузер.
4. **Офлайн и без сборки в рантайме.** Tailwind компилируется один раз в `web/app.css`
   и коммитится. Сервер отдаёт статику, ничего не собирает.
5. **ID человека и машины совпадают.** Публичный id `KEY-12` (`RAT-7`, `AXEL-3`),
   он же принимается CLI и API, он же в URL.

## 2. Структура репозитория

```
RatIssues/
  PLAN.md
  README.md                 # как поставить, как пользоваться
  AGENTS.md                 # протокол работы для LLM-агентов
  bin/rat.mjs               # CLI entrypoint (#!/usr/bin/env node)
  bin/rat.cmd               # windows-шим: node --no-warnings rat.mjs %*
  src/core/db.mjs           # коннект, pragma, миграции, schema_version
  src/core/store.mjs        # доменные операции (единственный писатель в БД)
  src/core/query.mjs        # выборки, фильтры, FTS-поиск
  src/core/events.mjs       # append/чтение истории, actor
  src/core/export.mjs       # md / jsonl дампы
  src/cli/index.mjs         # парсинг argv, роутинг команд
  src/cli/commands/*.mjs    # add, ls, show, edit, status, comment, next, ...
  src/server/http.mjs       # node:http: статика + JSON API + SSE
  src/server/api.mjs        # тонкий слой над store.mjs
  web/index.html            # SPA-подобная одна страница, vanilla JS
  web/app.js
  web/tailwind.src.css      # build-time only
  web/app.css               # скомпилированный Tailwind (в git)
  data/issues.db            # рантайм, в .gitignore
  exports/                  # снапшоты md/jsonl, в .gitignore (или в git — см. §9)
  tests/                    # node:test, временная БД на тест
  tools/build-css.mjs       # запускает standalone tailwind CLI
```

## 3. Модель данных

`meta` — `key/value`: `schema_version`, `default_project`.

**projects**

| поле | тип | смысл |
|---|---|---|
| key | TEXT PK | короткий код `RAT`, `AXEL` (uppercase, `[A-Z0-9]{2,10}`) |
| name | TEXT | человеческое имя |
| root_path | TEXT NULL | папка проекта, чтобы `rat add` без `--project` находил проект по cwd |
| color | TEXT | акцент для UI (hex/slug палитры) |
| created_at / archived_at | TEXT/INT | архив прячет из списка, но не удаляет |

**issues**

| поле | смысл |
|---|---|
| id INTEGER PK | внутренний |
| project_key + num | публичный `KEY-NUM`, UNIQUE(project_key, num) |
| title, body | до ~64 КБ, markdown |
| status | `open` \| `doing` \| `blocked` \| `done` \| `cancelled` |
| priority | 0–3 (`p0` срочно … `p3` когда-нибудь), default 2 |
| labels | JSON-массив строк, нормализованный (lowercase, sorted) |
| assignee | TEXT NULL, свободная строка (`agent:claude`, `me`) |
| ref | TEXT NULL — внешняя ссылка/путь/URL, чтобы связать с кодом |
| created_at, updated_at | epoch ms |
| closed_at, close_reason | при `done`/`cancelled`; reopen их очищает |
| meta | JSON — запасное поле без миграций |

**events** (append-only, единственный источник истории)

| поле | смысл |
|---|---|
| id INTEGER PK, issue_id | |
| ts | epoch ms |
| actor | `human`, `agent`, `agent:<model>`, `cli`, `web` |
| kind | `created` `status` `comment` `edit` `link` `claim` |
| data | JSON: `{from,to,reason}` / `{text}` / `{field,from,to}` / `{idem}` |

**issues_fts** — FTS5 (title, body, labels) + триггеры insert/update/delete.
Если сборка без FTS5 — фолбэк на `LIKE` (проверяется на старте).

Pragma на каждом коннекте: `journal_mode=WAL`, `busy_timeout=5000`,
`synchronous=NORMAL`, `foreign_keys=ON`.

**Аллокация номера:** `BEGIN IMMEDIATE` → `max(num)+1` для проекта → insert → commit.
Гонки между параллельными агентами закрыты, без глобального лока.

## 4. CLI (`rat`)

Формат: `rat <command> [project] [args] [--flags]`.
Глобальные флаги: `--json`, `--db <path>`, `--actor <name>`, `--quiet`.
`--json` печатает машиночитаемое, `--quiet` — только id/минимум.
Остальное — человекочитаемый вывод с цветом, если `tty`.

| команда | делает |
|---|---|
| `rat init` | создать базу, схему, проект `RAT` по умолчанию |
| `rat project add KEY --name "..." [--path ...] [--color ...]` | новый проект |
| `rat project ls [--all] [--json]` | проекты + счётчики по статусам |
| `rat project archive KEY` | скрыть из дефолтных списков |
| `rat add "title" [--project K] [--body TEXT\|-] [--label a,b] [--priority 1] [--ref ...] [--assignee ...]` | создать; `--body -` читает stdin; `--json` → `{"id":"RAT-12",...}` |
| `rat ls [project] [-s open|doing|blocked|done|cancelled\|active\|all] [--label] [--priority] [-q TEXT] [--limit N] [--sort pri\|updated]` | таблица/JSON |
| `rat show ID [--events N] [--json]` | задача + последние N событий (default 20) одним вызовом |
| `rat edit ID [--title] [--body] [--priority] [--label +x,-y] [--assignee] [--ref]` | правки, каждая → событие `edit` |
| `rat status ID <status> [--reason]` | смена статуса |
| `rat done ID [--reason]` / `rat cancel ID [--reason]` / `rat reopen ID [--reason]` | сахар над `status` |
| `rat claim ID` | `doing` + `assignee=$RAT_ACTOR` (агенту: «беру в работу») |
| `rat comment ID [text\|-] [--actor]` | комментарий; пустой текст → stdin/редактор |
| `rat next [project] [--label] [--json]` | следующая задача: `open` → `priority asc` → `updated_at asc` |
| `rat log [project] [--since 1d\|ISO] [--kind] [--json]` | лента событий (что делал агент) |
| `rat stats [--json]` | счётчики по проектам/статусам/за неделю |
| `rat export [project] [--format md\|jsonl] [--out FILE] [--all]` | снапшот для чтения/грепа/git |
| `rat serve [--port 4711] [--open] [--host 127.0.0.1]` | web UI + API |
| `rat doctor` | проверки: БД, WAL, FTS5, права, битый JSON |

**Exit codes:** `0` ok, `1` не найдено, `2` ошибка использования, `3` конфликт
(недопустимый переход статуса), `4` ошибка БД.

**Определение проекта:** `--project` → `$RAT_PROJECT` → `root_path` = cwd (самый длинный
префикс) → `default_project` из `meta`. Ничего не нашлось → ошибка с подсказкой
`rat project add`.

**Переходы статусов:** свободные, кроме `done`/`cancelled` → только через `reopen`.
`doing` без assignee автоматически ставит actor.

## 5. Web UI

Одна страница, vanilla JS, никаких фреймворков. Tailwind — скомпилированный CSS.

**Экраны**

1. **Сайдбар** — список проектов с бейджами `open/doing/blocked`, «All projects»,
   поиск по проектам, внизу `rat stats` мини-сводка.
2. **Список задач** — фильтр-чипы статусов (с счётчиками), поиск (FTS5, debounce 200ms),
   фильтр по меткам, сортировка. Строка: `RAT-12 · title · labels · priority · age · assignee`.
3. **Деталь** — правая панель/страница: заголовок, body (мини-markdown: код, списки,
   ссылки, **bold**), метаданные, лента событий (иконка по `kind`, автор, время),
   комментарий (`Ctrl+Enter`), кнопки статусов, «Close as done» / «Cancel».
4. **Новая задача** — модалка: проект, title, body, priority, labels, ref.
5. **Глобал** — `/` поиск по всем проектам, `/log` лента событий всех проектов.

**Тема:** `bg-zinc-950`, панели `zinc-900`, бордеры `zinc-800`, текст `zinc-100/zinc-400`.
Акценты: `doing` sky, `blocked` amber, `done` emerald, `cancelled` rose, `open` lime.
Моноширинный для id. Никаких градиентов и стекла — плотный, спокойный интерфейс
для десятков проектов. Адаптив: сайдбар → drawer, список → карточки.

**Клавиатура:** `/` поиск, `n` новая, `j/k` навигация, `Enter` открыть, `Esc` назад,
`c` комментарий, `s` меню статуса.

**Живость:** SSE `/api/stream` (`Last-Event-ID`), сервер шлёт `issue.updated`/`issue.created`.
Fallback — polling 5s при потере соединения. Обновление списка без перезагрузки.

## 6. HTTP API

Только `127.0.0.1`, без авторизации, `Cache-Control: no-store`. JSON, ошибки
`{"error":{"code":"not_found","message":"..."}}`.

```
GET    /api/projects
POST   /api/projects                      {key,name,root_path,color}
GET    /api/issues?project&status&label&q&priority&limit&cursor
POST   /api/issues                        {project,title,body,priority,labels,ref,actor}
GET    /api/issues/:id                    :id = RAT-12 | 12
PATCH  /api/issues/:id                    {status,title,body,priority,labels,assignee,ref,actor,reason}
POST   /api/issues/:id/comments           {text,actor}
GET    /api/issues/:id/events?limit
GET    /api/log?project&since&kind
GET    /api/stats
GET    /api/export?format=md|jsonl&project
GET    /api/stream                        SSE
```

Один доменный слой `store.mjs` для CLI и API — поведение и валидация не расходятся.
UI никогда не пишет в базу напрямую.

## 7. Протокол для LLM (`AGENTS.md`)

- **Кто пишет:** агент создаёт/меняет/закрывает задачи; человек в основном читает
  и комментирует. Автор всегда пишется в `events.actor` (`RAT_ACTOR` или `--actor`).
- **Дисциплина:** взять `rat next --json` → `rat claim` → работа → `rat comment`
  с итогом (что сделано, файлы, коммит) → `rat done --reason`.
- **Без прямого SQL.** Агент видит только CLI/API, поэтому схема может меняться.
- **Чтение дёшево:** `rat show ID --json` отдаёт задачу + последние события,
  `rat ls --json` — компактный список, `rat log --since 1d --json` — история.
- **Идемпотентность:** `--idem <uuid>`; повтор с тем же id не создаёт дубль
  (проверка по `events.data.idem`).
- **Массовые операции:** `--body -` и `--title -` читают stdin — не надо экранировать
  кавычки в shell.
- **Экспорт как контекст:** `rat export --format jsonl` — один файл, который можно
  целиком загрузить в контекст, когда нужно «всё про проект».

## 8. Экспорт и история

- `md` — по проекту: заголовок, открытые по приоритету, затем закрытые, у каждой
  задачи метаданные и последние 10 событий. Читаемо человеком, диффается в git.
- `jsonl` — строка на задачу или событие (`--events`), стабильный порядок полей.
- По умолчанию в `exports/<KEY>.md` и `exports/all.jsonl`; `--out -` → stdout.
- Рекомендация: коммитить `exports/` в git проекта — получается бесплатная
  история изменений трекера без использования GitHub Issues.

## 9. Этапы

| # | Объём | Готово, когда |
|---|---|---|
| **M0** | каркас, `db.mjs`, миграции, `rat init`, `doctor` | база создаётся, повторный запуск идемпотентен |
| **M1** | `project add/ls`, `add`, `show`, `status/done/cancel/reopen`, `comment` | полный цикл задачи из терминала + `--json` |
| **M2** | `ls` с фильтрами, `next`, `log`, `stats`, `edit`, FTS5 | агент может работать без UI |
| **M3** | `export` md/jsonl, `AGENTS.md`, `README` | экспорт читается, инструкция протокола готова |
| **M4** | HTTP API + `serve` + статика, read-only UI (список/деталь/поиск) | можно смотреть задачи в браузере |
| **M5** | запись из UI: новая задача, статусы, комментарии, SSE | человек живёт в браузере, не в терминале |
| **M6** | полировка: клавиатура, `--open`, project из cwd, цвета, адаптив, тесты | `node --test` зелёный, UX не бесит |

Порядок сознательный: M1–M3 уже дают рабочую систему для агента, UI — сверху.

## 10. Тесты и приёмка

- `node:test` на временной БД: нумерация под параллелизмом (10 «одновременных»
  insert → 10 разных номеров), переходы статусов, `--idem`, FTS-поиск, экспорт.
- CLI-контракт: `--json` схемы полей фиксированы, коды выхода проверяются.
- Ручная приёмка: создать 3 проекта, 20 задач, закрыть/отменить, перезапустить
  сервер, убедиться что история и нумерация целы.

## 11. Чего не делаем

Нет авторизации, мультипользовательности, синхронизации, уведомлений, вложений,
подзадач-дерева, спринтов, time-tracking, git-интеграции, Electron/Tauri-обёртки,
сборки бандла в рантайме. Всё это — только если реально понадобится.

## 12. Решения по умолчанию

- Имя бинаря `rat`, база `Q:\Sources\AI\RatIssues\data\issues.db` (override `RAT_DB`).
- Порт `4711`, только loopback.
- Статусы: `open/doing/blocked/done/cancelled`; приоритеты `0..3`, default `2`.
- Комментарии неизменяемы; исправление — новый комментарий.
- Удаления нет; «мусор» → `cancelled`.
- Tailwind — standalone CLI при разработке, результат в git; рантайм офлайн.
