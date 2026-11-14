# RatIssues

[![tests](https://github.com/JustOxlamon/ratissues/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/JustOxlamon/ratissues/actions/workflows/test.yml)

**English version:** [README.md](README.md)

Локальный трекер задач для множества мелких проектов: одна SQLite-база на всё,
CLI с JSON-выводом для LLM и простой web UI (Tailwind, dark) для человека.

- Ноль npm-зависимостей в рантайме: только Node 24 и встроенный `node:sqlite`.
- Один доменный писатель — `src/core/store.mjs`; `events` — append-only история.
- Публичный id задачи — `KEY-NUM` (`RAT-7`, `AXEL-3`); он же в CLI, API и URL.
- Удаления нет: задача уходит в `cancelled`, комментарии неизменяемы (правка —
  новый комментарий).

Реализовано: схема и миграции, проекты, полный цикл задач (создание, статусы,
правка, комментарии), поиск, лента событий, статистика, милстоуны с прогрессом,
канон (`KEY-C#` — актуальные решения проекта), экспорт `md`/`jsonl`,
автобекапы, HTTP API, `rat serve`, web UI с записью
(новая задача, статусы, милстоуны, комментарии), SSE, клавиатура, адаптив.

Милстоуны — это именованные вехи внутри проекта (например `v1.0`):
задача может быть привязана к одной вехе, прогресс считается как
`done / (total − cancelled)`. Удаления нет: веха бывает `open` или `closed`.

Канон — актуальные решения проекта из развилок («делай так / вот так не делай»).
Каждое правило — короткая директива (`title`) + контекст (`body` и опциональный
`--source` задачи), адресовано оператору и агентам-LLM, работающим в проекте.
Правило адресуется `KEY-C1`, `KEY-C2`, … (уникально в проекте). Оно `active`,
пока явно не отменено `repealed`; удаления нет. `rat canon add … --supersedes
KEY-Cn` одной операцией добавляет новое правило и «выходит из строя» старое,
ставя на обоих ссылку. Правила канона — атрибуты проектного уровня, как
милстоуны: собственных событий в `events` не пишут (аудит — в полях записи), а
текст правила правится через `rat canon edit`.

## Требования

- Node.js **24+** (нужен встроенный `node:sqlite`).
- Windows, Linux или macOS. На Windows удобен шим `bin\rat.cmd`.
- `npm install` не нужен — внешних зависимостей нет.

`node:sqlite` в Node 24 ещё помечен экспериментальным, поэтому при прямом
`node bin/rat.mjs ...` в stderr появляется `ExperimentalWarning`. Шим
`bin\rat.cmd` запускает `node --no-warnings` и это предупреждение подавляет.

## Быстрый старт

```bash
git clone https://github.com/JustOxlamon/ratissues.git
cd ratissues

node bin/rat.mjs init
node bin/rat.mjs project add AXEL --name "Axel" --path ../axel --color sky

node bin/rat.mjs add "Починить экспорт" --project AXEL \
  --body "md и jsonl должны диффаться в git" --priority 1 --label backend,docs
node bin/rat.mjs ls AXEL
node bin/rat.mjs show AXEL-1

node bin/rat.mjs next AXEL             # что делать дальше
node bin/rat.mjs claim AXEL-1          # doing + assignee = $RAT_ACTOR
node bin/rat.mjs comment AXEL-1 "Готово: src/core/export.mjs, коммит abc123"
node bin/rat.mjs done AXEL-1 --reason "экспорт работает"

node bin/rat.mjs export                # exports/RAT.md
node bin/rat.mjs export AXEL --format jsonl --out -
```

На Windows те же команды: `bin\rat.cmd init`, `bin\rat.cmd add ...` (или
добавьте каталог `bin` в `PATH`).

## Глобальный запуск (из любого каталога)

Установки нет: глобально ставятся только тонкие обёртки, которые вызывают
`node --no-warnings <repo>/bin/rat.mjs`. Код и тесты остаются в репозитории.

- `C:\Users\<user>\bin\rat.cmd` — для cmd/PowerShell;
- `C:\Users\<user>\bin\rat` — для git-bash и shell-инструмента opencode;
- каталог добавлен в пользовательский `PATH`.

Обёртки задают значения по умолчанию только если переменная не задана:

```bash
RAT_SRC   # корень репозитория (поправить, если репозиторий переедет)
RAT_DB    # %USERPROFILE%\.rat\issues.db — стабильная база вне репозитория
```

`RAT_DB` вне репозитория — сознательно: `data/` в `.gitignore`, а база должна
переживать переезд/переустановку кода. Проверка:

```bash
cd /d/any/other/project && rat project ls --json && rat ls --json
```

Для агентов opencode: скилл `rat` лежит в репозитории —
`.opencode/skills/rat/SKILL.md`. Он описывает протокол работы (цикл
`next → claim → comment → done`, милстоуны, коды выхода, `--actor`, `--idem`).
Чтобы правила были доступны в любой сессии, скопируйте каталог в
`~/.config/opencode/skills/rat/`.

## Команды

Формат: `rat <команда> [project] [аргументы] [флаги]`.

| Команда | Что делает | Основные флаги |
|---|---|---|
| `rat init` | создать базу, схему и проект `RAT` по умолчанию (идемпотентно) | `--json`, `--quiet`, `--db` |
| `rat doctor` | проверки: схема, WAL, FTS5, целостность JSON, запись | `--json` |
| `rat backup` | резервная копия базы сейчас | `--list` (история), `--keep N`, `--json` |
| `rat project add KEY --name "..."` | новый проект | `--path DIR`, `--color SLUG`, `--json` |
| `rat project ls` | проекты и счётчики по статусам | `--all` (с архивом), `--json` |
| `rat project archive KEY` | скрыть проект из списков, не удаляя задачи | `--json` |
| `rat milestone add NAME` | новый милстоун проекта | `--project K`, `--body T\|-`, `--due YYYY-MM-DD`, `--json` |
| `rat milestone ls [project]` | милстоуны и прогресс `done/total (N%)` | `--state open\|closed\|all`, `--json` |
| `rat milestone edit NAME` | имя, описание, срок (все поля опциональны) | `--project K`, `--name`, `--body T\|-`, `--due`, `--clear-due`, `--json` |
| `rat milestone close NAME` / `reopen NAME` | закрыть/открыть веху (повтор — no-op) | `--project K`, `--json` |
| `rat canon add TITLE` | создать активное канон-правило | `--project K`, `--body TEXT\|-`, `--priority 0..3`, `--label a,b`, `--source RAT-7`, `--supersedes KEY-Cn`, `--json` |
| `rat canon ls [project]` | актуальные правила (канон) | `--state active\|repealed\|all`, `--label x`, `-q TEXT`, `--json` |
| `rat canon show REF` | одно правило со всеми полями | `--project K`, `--json` |
| `rat canon edit REF` | правка полей правила | `--title T\|-`, `--body T\|-`, `--priority`, `--label +a,-b`, `--project K`, `--json` |
| `rat canon repeal REF` / `reactivate REF` | отменить / вернуть правило (повтор — no-op) | `--project K`, `--reason TEXT` (repeal), `--json` |
| `rat add "title"` | создать задачу | `--project K`, `--body TEXT\|-`, `--label a,b`, `--priority 0..3`, `--ref`, `--milestone NAME`, `--assignee`, `--idem UUID`, `--json` |
| `rat ls [project]` | список задач | `-s open\|doing\|blocked\|deferred\|done\|cancelled\|active\|all`, `--label`, `--milestone NAME\|none`, `--priority N\|pN\|0..1`, `-q TEXT`, `--limit N`, `--sort pri\|updated`, `--cursor C`, `--all`, `--json` |
| `rat show ID` | задача + последние события | `--events N` (default 20), `--json` |
| `rat edit ID` | правка полей, каждое изменение → событие `edit` | `--title T\|-`, `--body T\|-`, `--priority`, `--label +x,-y`, `--assignee`, `--ref`, `--milestone NAME\|-`, `--json` |
| `rat status ID <status>` | сменить статус | `--reason TEXT`, `--json` |
| `rat done ID` / `rat cancel ID` / `rat reopen ID` | сахар над `status` | `--reason TEXT`, `--json` |
| `rat claim ID` | взять в работу: `doing` + `assignee=$RAT_ACTOR` | `--json` |
| `rat comment ID [text\|-]` | неизменяемый комментарий | `--idem UUID`, `--json` |
| `rat next [project]` | следующая открытая задача (`priority asc`, затем старая) | `--label`, `--json` |
| `rat log [project]` | лента событий | `--since 1d\|ISO`, `--kind K`, `--limit N`, `--json` |
| `rat stats` | счётчики по проектам/статусам/приоритетам и за 7 дней | `--json` |
| `rat export [project]` | снапшот в `md`/`jsonl` для чтения, грепа и git | `--format md\|jsonl`, `--out FILE\|-`, `--events`, `--all`, `--limit N`, `--json` |
| `rat serve` | запустить web UI + JSON API (только loopback) | `--port 4711`, `--host 127.0.0.1`, `--open`, `--quiet` |

Глобальные флаги (в любом месте argv): `--json` (машиночитаемый вывод),
`--quiet` (минимум), `--db <path>` (путь к базе), `--actor <name>` (автор
события), `--no-backup` (не делать автобекап перед командой), `-h`/`--help`.

После обновления `rat` схему существующей базы нужно догнать командой
`rat init` (миграции применяются только ею, данные сохраняются). Пока версия
схемы не совпадает с текущей, остальные команды завершаются кодом `4` с
`schema_outdated` и подсказкой, а `rat doctor` показывает FAIL по схеме.

`--body -` (в `add`/`edit`) и `--title -` (в `edit`) читают stdin — удобно, когда
текст содержит кавычки и переносы. `--idem <uuid>` делает `add` и `comment`
идемпотентными: повтор с тем же id не создаёт дубль.

## Статусы и приоритеты

- Статусы: `open`, `doing`, `blocked`, `deferred`, `done`, `cancelled`.
- Приоритеты: `0..3` (`p0` — срочно, `p3` — когда-нибудь), по умолчанию `2`.
- Переходы свободные, кроме выхода из `done`/`cancelled` — только через
  `rat reopen`. `deferred` (отложено) — как `open`: уходить можно свободно,
  в `active` и `rat next` он не попадает.
- `doing` без явного исполнителя ставит `assignee = actor`.
- `done`/`cancelled` заполняют `closed_at` и `close_reason`; `reopen` их очищает.

## Определение проекта

Порядок: `--project KEY` → переменная `RAT_PROJECT` → самый длинный `root_path`,
являющийся префиксом текущего каталога → `meta.default_project` (обычно `RAT`).
Если ничего не найдено — ошибка с подсказкой `rat project add`.

## Переменные окружения

| Переменная | Смысл |
|---|---|
| `RAT_DB` | путь к базе; по умолчанию `data/issues.db` от корня репозитория (глобальная обёртка подставляет `%USERPROFILE%\.rat\issues.db`) |
| `RAT_ACTOR` | автор событий; по умолчанию `cli` |
| `RAT_PROJECT` | проект по умолчанию, если не задан `--project` |
| `RAT_BACKUP` | `off`/`0`/`false`/`no` — выключить автобекапы |
| `RAT_BACKUP_INTERVAL` | как часто делать автобекап: `24h`, `90m`, `3600` (секунды); по умолчанию `24h` |
| `RAT_BACKUP_KEEP` | сколько копий хранить (ротация); по умолчанию `7` |
| `RAT_BACKUP_DIR` | каталог копий; по умолчанию `<каталог БД>/backups` |
| `NO_COLOR` / `FORCE_COLOR` | управление ANSI-цветом в человекочитаемом выводе |

Для экспериментов и тестов всегда используйте отдельную базу:
`RAT_DB=/tmp/rat-test.db node bin/rat.mjs ...` (Windows: путь в кавычках).
Файлы `-wal`/`-shm` рядом с базой — норма (WAL), руками их не удаляйте.

## Коды выхода

| Код | Значение |
|---|---|
| `0` | успех |
| `1` | не найдено (задача, проект, база не инициализирована) |
| `2` | ошибка использования (флаги, аргументы, формат) |
| `3` | конфликт (недопустимый переход статуса, проект уже в архиве, закрытый милстоун) |
| `4` | ошибка БД или записи файла (включая `schema_outdated`) |

С `--json` ошибки печатаются в stderr как
`{"error":{"code":"...","message":"...","hint":"..."}}`.

## Экспорт

Снапшоты создаются в `exports/` **от корня репозитория**, а не от текущего
каталога; каталог создаётся автоматически, файл пишется атомарно
(временный файл + переименование).

| Команда | Куда пишет |
|---|---|
| `rat export` | `exports/<KEY>.md` для проекта по умолчанию |
| `rat export AXEL` | `exports/AXEL.md` |
| `rat export --all` | `exports/all.md` — все проекты, включая архивные |
| `rat export --format jsonl` | `exports/all.jsonl` — вся база без архивных проектов |
| `rat export AXEL --format jsonl` | `exports/AXEL.jsonl` |
| `rat export --format jsonl --all` | `exports/all.jsonl` — включая архивные проекты |
| `rat export ... --out FILE` | указанный файл |
| `rat export ... --out -` | stdout, ровно снапшот, без баннеров (для piping) |

`md` — человекочитаемый файл: заголовок проекта и сводка, блок «Канон»
(активные `KEY-C#` правила с приоритетом, источником и телом), блок
«Милстоуны» (если у проекта они есть: состояние, `done/total (N%)` и срок),
затем «Открытые» (`open`/`doing`/`blocked`, по приоритету и давности
обновления), «Отложенные» (`deferred`, по давности обновления) и «Закрытые»
(`done`/`cancelled`, по времени закрытия), у каждой задачи метаданные (включая
`милстоун:`), тело и последние 10 событий. `jsonl` — по одному JSON-объекту в
строке со стабильным порядком полей: задача — как в `rat ls --json` (поле
`milestone` — имя вехи или `null`, стоит после `ref`), событие (`--events`) —
`id, issue, project, ts, actor, kind, data`, канон-правило —
`{"type":"canon", …}`. Порядок записей тоже стабилен: канон — `project`, затем
`num`; задачи — `project`, затем `num`; события — `ts`, затем `id`. Это
позволяет детерминированно диффать снапшоты и целиком загружать jsonl в
контекст LLM — правила канона идут первыми.

`--events` допустим только с `--format jsonl` (иначе код выхода `2`).
`--json` при записи в файл печатает объект
`{path, format, bytes, projects, issues, events, canon}`; с `--out -` он
несовместим.

Рекомендация: коммитить `exports/` в git проекта — получается
бесплатная история трекера без GitHub Issues. В этом репозитории `exports/`
пока в `.gitignore`; если нужна история в git, уберите эту строку.

## Резервные копии

Автобекап включён по умолчанию и срабатывает **перед** выполнением команды:
если самой свежей копии больше `RAT_BACKUP_INTERVAL` (по умолчанию сутки) или
копий ещё нет — снимается новая. Копия фиксирует состояние *до* записи, поэтому
ею можно откатить неудачную правку. Частые вызовы (`rat ls`, `rat next`) лишних
файлов не плодят.

- Копия делается через `VACUUM INTO` на отдельном коротком коннекте — это
  целостный снапшот даже при WAL и параллельных процессах, и обычный файл
  SQLite (его можно открыть `sqlite3`/`rat --db`).
- Каталог: `<каталог базы>/backups`, для глобальной обёртки —
  `%USERPROFILE%\.rat\backups`. Переопределяется `RAT_BACKUP_DIR`.
- Имя файла: `<база>-ГГГГММДД-ЧЧММСС-ммм.db`, поэтому каталог сортируется по
  времени, а старое легко найти глазами.
- Ротация: хранятся `RAT_BACKUP_KEEP` самых свежих копий (7), остальные
  удаляются. Удаляются только файлы, подходящие под шаблон имени этой базы.
- Сбой копии не ломает команду: код выхода не меняется, в stderr уходит
  предупреждение (кроме `--quiet`). Для скриптов и тестов — `--no-backup` или
  `RAT_BACKUP=off`.

| Что | Как |
|---|---|
| снять копию сейчас | `rat backup` |
| что уже есть | `rat backup --list` |
| изменить глубину истории | `RAT_BACKUP_KEEP=30` |
| реже/чаще | `RAT_BACKUP_INTERVAL=6h` |
| в другой каталог | `RAT_BACKUP_DIR=D:/rat-backups` |

Восстановление: остановить `rat serve`, заменить файл базы свежей копией и
удалить рядом с базой `-wal`/`-shm` (они принадлежат старой базе) — эти файлы
нормальны при работе WAL, но после подмены основного файла не нужны.

## Web UI

`rat serve` поднимает локальный сервер только на loopback (`127.0.0.1`,
`localhost`, `::1`) и отдаёт статику из `web/` + JSON API из `src/server/`.
Интерфейс позволяет смотреть проекты, список задач, поиск, детальную карточку,
ленту событий, а также создавать задачи, менять статусы, назначать милстоуны
и оставлять комментарии. В сайдбаре у каждого проекта видны до трёх открытых
милстоунов с прогрессом; в списке есть фильтр по милстоуну (только внутри
проекта) и чипы у задач. Изменения рассылаются всем клиентам через SSE
`/api/stream`.

```bash
npm run build:css   # пересобрать web/app.css из web/tailwind.src.css
rat serve --open    # открыть браузер
serve.bat           # Windows: то же, что `rat serve --open`; лишние флаги пробрасываются
```

`serve.bat` берёт базу из `%RAT_DB%`, иначе `%USERPROFILE%\.rat\issues.db`, если она
есть, иначе `<repo>\data\issues.db`; выбранный путь печатается в консоль.
Переопределить можно флагом: `serve.bat --db data\issues.db`.

### Клавиатура

- `/` — фокус в поиск задач.
- `n` — новая задача (не срабатывает в input/textarea/select).
- `j` / `k` — вниз/вверх по списку с подсветкой текущей строки.
- `Enter` — открыть выделенную задачу.
- `Esc` — закрыть модалку, закрыть мобильный drawer, вернуться из детали
  к списку или снять фокус с поля ввода.
- `c` — фокус в поле комментария (в детали задачи).
- `s` — фокус на панель статусов (в детали задачи).

Подсказки клавиш есть в `title` кнопок и полей.

### Тема и адаптив

Тёмная тема: `bg-zinc-950`, панели `zinc-900`, бордеры `zinc-800`, акцентные
цвета статусов (`open` lime, `doing` sky, `blocked` amber, `done` emerald,
`cancelled` rose, `deferred` violet). У проектов есть цвет (`--color` при создании): слаг палитры
(`lime`, `sky`, `amber`, `emerald`, `rose`, `violet`, `zinc`) или hex, который
отображается точкой у id и в сайдбаре.

На экранах ≥768px сайдбар виден постоянно, список — компактные строки.
На экранах <768px сайдбар превращается в drawer с оверлеем, список — карточки,
деталь занимает всю ширину.

Tailwind — devDependency (`tailwindcss` + `@tailwindcss/cli`), компилируется
один раз, `web/app.css` коммитится; в рантайме сервер ничего не собирает.

## HTTP API

Только `127.0.0.1`/`localhost`/`::1`, без авторизации,
`Cache-Control: no-store`. JSON, ошибки
`{"error":{"code":"...","message":"..."}}`.

```
GET    /api/projects
POST   /api/projects                      {key,name,root_path,color}
GET    /api/issues?project&status&label&q&priority&milestone&limit&cursor&sort
POST   /api/issues                        {project,title,body,priority,labels,ref,milestone,actor,idem}
GET    /api/issues/:id                    :id = RAT-12 | 12
PATCH  /api/issues/:id                    {status,title,body,priority,labels,assignee,ref,milestone,actor,reason}
POST   /api/issues/:id/comments           {text,actor,idem}
GET    /api/issues/:id/events?limit
GET    /api/milestones?project&state&all
POST   /api/milestones                    {project,name,body,due_at}
PATCH  /api/milestones/:ref?project       {name,body,due_at,clear_due,state}
GET    /api/canon?project&state&label&q
POST   /api/canon                         {project,title,body,priority,labels,source,supersedes,actor}
PATCH  /api/canon/:ref?project            {title,body,priority,labels,state,reason,actor}
GET    /api/log?project&since&kind&limit
GET    /api/stats
GET    /api/export?format=md|jsonl&project&events&all&limit
GET    /api/stream                        SSE (Last-Event-ID)
```

`milestone` в задачах — имя вехи (уникально внутри проекта) или `null`;
`milestone=none` в `GET /api/issues` — задачи без вехи. Для
`PATCH /api/milestones/:ref` проект передаётся в query (`?project=K`) или в теле.
Для `PATCH /api/canon/:ref` проект обязателен всегда (query или тело);
`state: "repealed" | "active"` отменяет или возвращает правило.

Один доменный слой `src/core/store.mjs` для CLI и API — поведение и валидация
не расходятся. UI никогда не пишет в базу напрямую.

## Архитектура

```
bin/rat.mjs            entrypoint CLI (#!/usr/bin/env node)
bin/rat.cmd            Windows-шим: node --no-warnings rat.mjs %*
src/core/db.mjs        коннект, pragma, миграции, schema_version, ошибки/коды
src/core/store.mjs     доменные операции — ЕДИНСТВЕННЫЙ писатель в БД
src/core/query.mjs     выборки, фильтры, FTS5 с фолбэком на LIKE
src/core/events.mjs    append-only события, actor, since/kind/limit
src/core/export.mjs    md/jsonl-снапшоты — только чтение
src/core/backup.mjs    автобекапы: VACUUM INTO, интервал, ротация
src/server/api.mjs     JSON API + SSE
src/server/http.mjs    node:http сервер: API + статика
src/cli/index.mjs      разбор argv, роутинг, help, коды выхода
src/cli/commands/*.mjs по команде на файл
src/cli/commands/milestone.mjs  add/ls/edit/close/reopen милстоунов
src/cli/commands/canon.mjs      add/ls/show/edit/repeal/reactivate канона
src/cli/args.mjs       флаги, stdin
src/cli/ui.mjs         цвета, форматирование времени и событий
web/index.html         SPA UI
web/app.js             vanilla JS интерфейс
web/app.css            скомпилированный Tailwind (в git)
web/tailwind.src.css   исходный CSS для Tailwind
tools/build-css.mjs    запуск Tailwind CLI
tests/                 node:test на временной БД
.opencode/skills/rat/  скилл opencode: протокол работы с rat
data/issues.db         рантайм-база (.gitignore)
data/backups/          автобекапы базы (внутри .gitignore)
exports/               снапшоты (.gitignore в этом репозитории)
```

Ключевые инварианты:

- `store.mjs` — единственный писатель; CLI и HTTP API вызывают его, а не
  SQL напрямую. Экспорт и выборки — только чтение.
- `events` append-only: создание, статус, правка и комментарий всегда оставляют
  событие; история задним числом не правится.
- Номер задачи выделяется в `BEGIN IMMEDIATE` через `max(num)+1` по проекту —
  параллельные процессы не получают дублей.
- На каждом коннекте: `journal_mode=WAL`, `busy_timeout=5000`,
  `synchronous=NORMAL`, `foreign_keys=ON`.

## Разработка и тесты

```bash
node --test "tests/**/*.test.mjs"     # все тесты (шаблон, не каталог!)
node --test tests/m3-export.test.mjs  # один файл
node --test --test-name-pattern="idem" "tests/**/*.test.mjs"   # один тест
npm run build:css                                             # пересобрать CSS
```

`node --test tests/` с каталогом не работает — передавайте шаблон в кавычках,
как показано выше. Каждый тест открывает свою временную базу; рабочая
`data/issues.db` не затрагивается. CI (GitHub Actions) гоняет `npm test` на
push в `main` и на pull request.

Сборки нет. `tools/build-css.mjs` и `web/app.css` уже есть; Tailwind
компилируется standalone CLI, результат попадаёт в git, а сервер не собирает
ничего в рантайме.

## Ограничения

Нет авторизации, синхронизации, уведомлений, вложений, подзадач-дерева,
спринтов, time-tracking, git-интеграции и Electron/Tauri-обёртки. Удаления нет:
«мусор» — это `cancelled`.

## Лицензия

MIT — см. [LICENSE](LICENSE).
