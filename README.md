# RatIssues

[![tests](https://github.com/JustOxlamon/ratissues/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/JustOxlamon/ratissues/actions/workflows/test.yml)

**Русская версия:** [README.ru.md](README.ru.md)

A local issue tracker for many small projects: one SQLite database for
everything, a JSON-friendly CLI for LLMs, and a simple dark web UI (Tailwind)
for humans.

- Zero npm dependencies at runtime: only Node 24 and the built-in `node:sqlite`.
- A single domain writer — `src/core/store.mjs`; `events` is append-only history.
- Public issue id is `KEY-NUM` (`RAT-7`, `AXEL-3`); the same value is used in the
  CLI, HTTP API, and URLs.
- Nothing is deleted: issues go to `cancelled`, comments are immutable (edit by
  adding a new comment).

Implemented: schema and migrations, projects, the full issue lifecycle (create,
statuses, edits, comments), search, event feed, statistics, milestones with
progress, canon (`KEY-C#` standing project decisions), `md`/`jsonl` export,
automatic backups, HTTP API, `rat serve`, a
write-capable web UI (new issue, statuses, milestones, comments), SSE, keyboard
navigation, and responsive layout.

Milestones are named checkpoints inside a project (for example `v1.0`): an
issue can belong to one milestone, and progress is calculated as
`done / (total − cancelled)`. Nothing is deleted: a milestone is either `open`
or `closed`.

Canon holds a project's standing decisions from forks ("do it this way / not
that"). Each canon entry is a short directive (`title`) plus context (`body` and
an optional `--source` issue), addressed to operators and LLM agents working in
the project. A canon entry is `KEY-C1`, `KEY-C2`, … (unique per project). It is
`active` unless explicitly `repealed`; nothing is deleted. `rat canon add …
--supersedes KEY-Cn` retires an old rule while adding a new one and records the
link on both. Canon entries are project-scoped attributes like milestones: they
write no events (their audit lives in the entry fields), and a rule's text is
editable with `rat canon edit`.

## Requirements

- Node.js **24+** (needs the built-in `node:sqlite`).
- Windows, Linux, or macOS. On Windows the `bin\rat.cmd` shim is convenient.
- No `npm install` required — there are no external runtime dependencies.

`node:sqlite` is still marked experimental in Node 24, so running
`node bin/rat.mjs ...` directly prints an `ExperimentalWarning` to stderr. The
`bin\rat.cmd` shim runs `node --no-warnings` and suppresses it.

## Quick start

```bash
git clone https://github.com/JustOxlamon/ratissues.git
cd ratissues

node bin/rat.mjs init
node bin/rat.mjs project add AXEL --name "Axel" --path ../axel --color sky

node bin/rat.mjs add "Fix export" --project AXEL \
  --body "md and jsonl must diff cleanly in git" --priority 1 --label backend,docs
node bin/rat.mjs ls AXEL
node bin/rat.mjs show AXEL-1

node bin/rat.mjs next AXEL             # what to do next
node bin/rat.mjs claim AXEL-1          # doing + assignee = $RAT_ACTOR
node bin/rat.mjs comment AXEL-1 "Done: src/core/export.mjs, commit abc123"
node bin/rat.mjs done AXEL-1 --reason "export works"

node bin/rat.mjs export                # exports/RAT.md
node bin/rat.mjs export AXEL --format jsonl --out -
```

On Windows the same commands work as `bin\rat.cmd init`, `bin\rat.cmd add ...`
(or add the `bin` directory to `PATH`).

## Global usage (from any directory)

There is no installation step: global setup is just thin wrappers that invoke
`node --no-warnings <repo>/bin/rat.mjs`. Code and tests stay in the repository.

- `C:\Users\<user>\bin\rat.cmd` — for cmd/PowerShell;
- `C:\Users\<user>\bin\rat` — for git-bash and the opencode shell tool;
- add that directory to your user `PATH`.

The wrappers provide defaults only when a variable is not already set:

```bash
RAT_SRC   # repository root (update it if the repository moves)
RAT_DB    # %USERPROFILE%\.rat\issues.db — a stable database outside the repo
```

Keeping `RAT_DB` outside the repository is intentional: `data/` is ignored by
git, and the database should survive code moves and reinstalls. Verify it with:

```bash
cd /d/any/other/project && rat project ls --json && rat ls --json
```

For opencode agents: the `rat` skill lives in this repository at
`.opencode/skills/rat/SKILL.md`. It documents the workflow (`next → claim →
comment → done`), milestones, exit codes, `--actor`, and `--idem`. To make the
same rules available in every session, copy the directory to
`~/.config/opencode/skills/rat/`.

## Commands

Format: `rat <command> [project] [arguments] [flags]`.

| Command | What it does | Main flags |
|---|---|---|
| `rat init` | create the database, schema, and default `RAT` project (idempotent) | `--json`, `--quiet`, `--db` |
| `rat doctor` | checks: schema, WAL, FTS5, JSON integrity, write access | `--json` |
| `rat backup` | take a database snapshot now | `--list` (history), `--keep N`, `--json` |
| `rat project add KEY --name "..."` | create a project | `--path DIR`, `--color SLUG`, `--json` |
| `rat project ls` | projects and per-status counts | `--all` (include archived), `--json` |
| `rat project archive KEY` | hide a project from lists without deleting issues | `--json` |
| `rat milestone add NAME` | create a project milestone | `--project K`, `--body T\|-`, `--due YYYY-MM-DD`, `--json` |
| `rat milestone ls [project]` | milestones and `done/total (N%)` progress | `--state open\|closed\|all`, `--json` |
| `rat milestone edit NAME` | rename, describe, or reschedule (all fields optional) | `--project K`, `--name`, `--body T\|-`, `--due`, `--clear-due`, `--json` |
| `rat milestone close NAME` / `reopen NAME` | close/reopen a milestone (repeat is a no-op) | `--project K`, `--json` |
| `rat canon add TITLE` | create an active canon rule | `--project K`, `--body TEXT\|-`, `--priority 0..3`, `--label a,b`, `--source RAT-7`, `--supersedes KEY-Cn`, `--json` |
| `rat canon ls [project]` | current canon (active rules) | `--state active\|repealed\|all`, `--label x`, `-q TEXT`, `--json` |
| `rat canon show REF` | one rule, full fields | `--project K`, `--json` |
| `rat canon edit REF` | edit rule fields | `--title T\|-`, `--body T\|-`, `--priority`, `--label +a,-b`, `--project K`, `--json` |
| `rat canon repeal REF` / `reactivate REF` | retire / restore a rule (repeat is a no-op) | `--project K`, `--reason TEXT` (repeal), `--json` |
| `rat add "title"` | create an issue | `--project K`, `--body TEXT\|-`, `--label a,b`, `--priority 0..3`, `--ref`, `--milestone NAME`, `--assignee`, `--idem UUID`, `--json` |
| `rat ls [project]` | list issues | `-s open\|doing\|blocked\|deferred\|done\|cancelled\|active\|all`, `--label`, `--milestone NAME\|none`, `--priority N\|pN\|0..1`, `-q TEXT`, `--limit N`, `--sort pri\|updated`, `--cursor C`, `--all`, `--json` |
| `rat show ID` | an issue plus its latest events | `--events N` (default 20), `--json` |
| `rat edit ID` | edit fields; each change emits an `edit` event | `--title T\|-`, `--body T\|-`, `--priority`, `--label +x,-y`, `--assignee`, `--ref`, `--milestone NAME\|-`, `--json` |
| `rat status ID <status>` | change status | `--reason TEXT`, `--json` |
| `rat done ID` / `rat cancel ID` / `rat reopen ID` | sugar over `status` | `--reason TEXT`, `--json` |
| `rat claim ID` | start work: `doing` + `assignee=$RAT_ACTOR` | `--json` |
| `rat comment ID [text\|-]` | add an immutable comment | `--idem UUID`, `--json` |
| `rat next [project]` | next open issue (`priority asc`, then oldest) | `--label`, `--json` |
| `rat log [project]` | event feed | `--since 1d\|ISO`, `--kind K`, `--limit N`, `--json` |
| `rat stats` | counts by project/status/priority and for the last 7 days | `--json` |
| `rat export [project]` | snapshot for reading, grepping, and git | `--format md\|jsonl`, `--out FILE\|-`, `--events`, `--all`, `--limit N`, `--json` |
| `rat serve` | start the web UI + JSON API (loopback only) | `--port 4711`, `--host 127.0.0.1`, `--open`, `--quiet` |

Global flags (accepted anywhere in argv): `--json` (machine-readable output),
`--quiet` (minimal output), `--db <path>` (database path), `--actor <name>`
(event author), `--no-backup` (skip the automatic backup before a command),
`-h`/`--help`.

After upgrading `rat`, bring an existing database schema up to date with
`rat init` (migrations are applied only by that command; your data is kept).
Until the schema version matches, other commands exit with code `4` and
`schema_outdated`, and `rat doctor` reports a schema FAIL.

`--body -` (in `add`/`edit`) and `--title -` (in `edit`) read from stdin — handy
when the text contains quotes or newlines. `--idem <uuid>` makes `add` and
`comment` idempotent: repeating the same id does not create a duplicate.

## Statuses and priorities

- Statuses: `open`, `doing`, `blocked`, `deferred`, `done`, `cancelled`.
- Priorities: `0..3` (`p0` urgent, `p3` someday); default is `2`.
- Transitions are free except leaving `done`/`cancelled`, which requires
  `rat reopen`. `deferred` behaves like `open`: you can leave it freely, and it
  is excluded from `active` and `rat next`.
- `doing` without an explicit assignee sets `assignee = actor`.
- `done`/`cancelled` fill `closed_at` and `close_reason`; `reopen` clears them.

## Project resolution

Order: `--project KEY` → the `RAT_PROJECT` environment variable → the longest
`root_path` that is a prefix of the current directory → `meta.default_project`
(usually `RAT`). If nothing matches, the command fails with a hint to run
`rat project add`.

## Environment variables

| Variable | Meaning |
|---|---|
| `RAT_DB` | database path; defaults to `data/issues.db` under the repository root (a global wrapper may set `%USERPROFILE%\.rat\issues.db`) |
| `RAT_ACTOR` | event author; defaults to `cli` |
| `RAT_PROJECT` | default project when `--project` is omitted |
| `RAT_BACKUP` | `off`/`0`/`false`/`no` disables automatic backups |
| `RAT_BACKUP_INTERVAL` | backup cadence: `24h`, `90m`, `3600` (seconds); default `24h` |
| `RAT_BACKUP_KEEP` | number of snapshots to keep (rotation); default `7` |
| `RAT_BACKUP_DIR` | snapshot directory; default `<database directory>/backups` |
| `NO_COLOR` / `FORCE_COLOR` | control ANSI colors in human-readable output |

Always use a separate database for experiments and tests:
`RAT_DB=/tmp/rat-test.db node bin/rat.mjs ...` (on Windows, quote the path).
`-wal`/`-shm` files next to the database are normal (WAL mode); do not delete
them manually.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | not found (issue, project, database not initialized) |
| `2` | usage error (flags, arguments, format) |
| `3` | conflict (invalid status transition, project already archived, closed milestone) |
| `4` | database/file write error (including `schema_outdated`) |

With `--json`, errors are printed to stderr as
`{"error":{"code":"...","message":"...","hint":"..."}}`.

## Export

Snapshots are written under `exports/` **relative to the repository root**, not
the current directory. The directory is created automatically and the file is
written atomically (temporary file + rename).

| Command | Writes |
|---|---|
| `rat export` | `exports/<KEY>.md` for the default project |
| `rat export AXEL` | `exports/AXEL.md` |
| `rat export --all` | `exports/all.md` — all projects, including archived |
| `rat export --format jsonl` | `exports/all.jsonl` — the whole database without archived projects |
| `rat export AXEL --format jsonl` | `exports/AXEL.jsonl` |
| `rat export --format jsonl --all` | `exports/all.jsonl` — including archived projects |
| `rat export ... --out FILE` | the specified file |
| `rat export ... --out -` | stdout: exactly the snapshot, no banners (for piping) |

`md` is a human-readable file: project heading and summary, a “Canon” block
(active `KEY-C#` rules with priority, source and body) when the project has any,
a “Milestones” block (when the project has any: state, `done/total (N%)`, and
due date), then “Open” (`open`/`doing`/`blocked`, by priority and update age),
“Deferred” (`deferred`, by update age), and “Closed” (`done`/`cancelled`, by
close time). Each issue includes metadata (with `milestone:`), its body, and
the last 10 events. `jsonl` is one JSON object per line with a stable field
order: an issue matches `rat ls --json` (`milestone` is the milestone name or
`null`, placed after `ref`), an event (`--events`) is
`id, issue, project, ts, actor, kind, data`, and a canon entry is
`{"type":"canon", …}`. Record order is stable too: canon first by `project`
then `num`, then issues by `project` then `num`, then events by `ts` then `id`.
This makes snapshots deterministic for git diffs and lets you feed the whole
jsonl into an LLM context — the canon records put the project's rules first.

`--events` is allowed only with `--format jsonl` (otherwise exit code `2`).
When writing to a file, `--json` prints
`{path, format, bytes, projects, issues, events}`; it cannot be combined with
`--out -`.

Recommendation: commit `exports/` to your project's git repository — you get a
free tracker history without GitHub Issues. In this repository `exports/` is
currently in `.gitignore`; remove that line if you want history in git.

## Backups

Automatic backups are on by default and run **before** a command: if the newest
snapshot is older than `RAT_BACKUP_INTERVAL` (one day by default), or no
snapshots exist yet, a new one is taken. The snapshot captures the state *before*
the write, so you can roll back a bad edit. Frequent calls (`rat ls`,
`rat next`) do not create extra files.

- A snapshot uses `VACUUM INTO` on a separate short-lived connection — a
  consistent copy even under WAL and concurrent processes, and a regular SQLite
  file (openable with `sqlite3` or `rat --db`).
- Directory: `<database directory>/backups`; with the global wrapper,
  `%USERPROFILE%\.rat\backups`. Override with `RAT_BACKUP_DIR`.
- File name: `<database>-YYYYMMDD-HHMMSS-mmm.db`, so the directory sorts by
  time and old snapshots are easy to spot.
- Rotation: the newest `RAT_BACKUP_KEEP` snapshots (7) are kept; older ones are
  removed. Only files matching this database's name pattern are touched.
- A failed snapshot never breaks the command: the exit code is unchanged and a
  warning goes to stderr (except with `--quiet`). For scripts and tests, use
  `--no-backup` or `RAT_BACKUP=off`.

| Task | How |
|---|---|
| take a snapshot now | `rat backup` |
| list existing snapshots | `rat backup --list` |
| keep more history | `RAT_BACKUP_KEEP=30` |
| change cadence | `RAT_BACKUP_INTERVAL=6h` |
| use another directory | `RAT_BACKUP_DIR=D:/rat-backups` |

Restore: stop `rat serve`, replace the database file with a fresh snapshot, and
delete the adjacent `-wal`/`-shm` files (they belong to the old database) —
those files are normal in WAL mode but are not needed after swapping the main
file.

## Web UI

`rat serve` starts a local server bound to loopback only (`127.0.0.1`,
`localhost`, `::1`) and serves static files from `web/` plus the JSON API from
`src/server/`. The UI lets you browse projects, the issue list, search, issue
details, and the event feed, and lets you create issues, change statuses, assign
milestones, and leave comments. The sidebar shows up to three open milestones
per project with progress; the list has a milestone filter (within a project
only) and milestone chips on issues. Changes are broadcast to all clients via
SSE at `/api/stream`.

```bash
npm run build:css   # rebuild web/app.css from web/tailwind.src.css
rat serve --open    # open the browser
```

### Keyboard

- `/` — focus issue search.
- `n` — new issue (does not fire in input/textarea/select).
- `j` / `k` — move down/up the list, highlighting the current row.
- `Enter` — open the highlighted issue.
- `Esc` — close the modal, close the mobile drawer, return from issue details
  to the list, or blur the focused input.
- `c` — focus the comment field (in issue details).
- `s` — focus the status panel (in issue details).

Key hints are available in the `title` attributes of buttons and fields.

### Theme and responsiveness

Dark theme: `bg-zinc-950`, panels `zinc-900`, borders `zinc-800`, and accent
colors per status (`open` lime, `doing` sky, `blocked` amber, `done` emerald,
`cancelled` rose, `deferred` violet). Projects have a color (`--color` when
creating): a palette slug (`lime`, `sky`, `amber`, `emerald`, `rose`, `violet`,
`zinc`) or a hex value, shown as a dot next to ids and in the sidebar.

At ≥768px the sidebar is always visible and the list uses compact rows. Below
768px the sidebar becomes a drawer with an overlay, the list becomes cards, and
issue details use the full width.

Tailwind is a devDependency (`tailwindcss` + `@tailwindcss/cli`), compiled once;
`web/app.css` is committed. The server never builds anything at runtime.

## HTTP API

Loopback only (`127.0.0.1`/`localhost`/`::1`), no authentication,
`Cache-Control: no-store`. JSON responses; errors use
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

On issues, `milestone` is the milestone name (unique within a project) or
`null`; `milestone=none` in `GET /api/issues` selects issues without a
milestone. For `PATCH /api/milestones/:ref`, pass the project in the query
string (`?project=K`) or in the body. For `PATCH /api/canon/:ref`, the project
is always required (query or body); `state: "repealed" | "active"` retires or
restores a rule.

CLI and API share one domain layer, `src/core/store.mjs`, so behavior and
validation never diverge. The UI never writes to the database directly.

## Architecture

```
bin/rat.mjs            CLI entrypoint (#!/usr/bin/env node)
bin/rat.cmd            Windows shim: node --no-warnings rat.mjs %*
src/core/db.mjs        connection, pragmas, migrations, schema_version, errors/codes
src/core/store.mjs     domain operations — the ONLY database writer
src/core/query.mjs     queries, filters, FTS5 with LIKE fallback
src/core/events.mjs    append-only events, actor, since/kind/limit
src/core/export.mjs    md/jsonl snapshots — read-only
src/core/backup.mjs    automatic backups: VACUUM INTO, interval, rotation
src/server/api.mjs     JSON API + SSE
src/server/http.mjs    node:http server: API + static files
src/cli/index.mjs      argv parsing, routing, help, exit codes
src/cli/commands/*.mjs one file per command
src/cli/commands/milestone.mjs  add/ls/edit/close/reopen for milestones
src/cli/commands/canon.mjs      add/ls/show/edit/repeal/reactivate for canon
src/cli/args.mjs       flags, stdin
src/cli/ui.mjs         colors, time and event formatting
web/index.html         SPA UI
web/app.js             vanilla JS interface
web/app.css            compiled Tailwind (committed)
web/tailwind.src.css   Tailwind source CSS
tools/build-css.mjs    Tailwind CLI runner
tests/                 node:test on temporary databases
.opencode/skills/rat/  opencode skill: how to work with rat
data/issues.db         runtime database (.gitignore)
data/backups/          automatic database snapshots (inside .gitignore)
exports/               snapshots (.gitignore in this repository)
```

Key invariants:

- `store.mjs` is the only writer; the CLI and HTTP API call it instead of
  running SQL directly. Export and queries are read-only.
- `events` is append-only: create, status, edit, and comment always leave an
  event; history is never rewritten.
- Issue numbers are allocated inside `BEGIN IMMEDIATE` via `max(num)+1` per
  project, so concurrent processes never get duplicates.
- Every connection sets: `journal_mode=WAL`, `busy_timeout=5000`,
  `synchronous=NORMAL`, `foreign_keys=ON`.

## Development and tests

```bash
node --test "tests/**/*.test.mjs"     # all tests (a glob, not a directory!)
node --test tests/m3-export.test.mjs  # one file
node --test --test-name-pattern="idem" "tests/**/*.test.mjs"   # one test
npm run build:css                                             # rebuild CSS
```

`node --test tests/` with a directory does not work — pass the quoted glob as
shown above. Every test opens its own temporary database; the working
`data/issues.db` is never touched. CI (GitHub Actions) runs `npm test` on pushes
to `main` and on pull requests.

There is no build step. `tools/build-css.mjs` and `web/app.css` already exist;
Tailwind is compiled by the standalone CLI, the result is committed, and the
server builds nothing at runtime.

## Limitations

No authentication, sync, notifications, attachments, subtask trees, sprints,
time tracking, git integration, or Electron/Tauri wrapper. Nothing is deleted:
“garbage” is `cancelled`.

## License

MIT — see [LICENSE](LICENSE).
