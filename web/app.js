const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STATUS_ORDER = ['open', 'doing', 'blocked', 'done', 'cancelled'];
const STATUS_LABELS = {
  open: 'open',
  doing: 'doing',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'cancelled',
};

const PROJECT_PALETTE = {
  lime: 'bg-lime-500',
  sky: 'bg-sky-500',
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
  rose: 'bg-rose-500',
  violet: 'bg-violet-500',
  zinc: 'bg-zinc-500',
};

const state = {
  project: null, // null = all projects
  q: '',
  status: 'active',
  label: '',
  sort: 'pri',
  cursor: null,
  issues: [],
  stats: null,
  projects: [],
  selectedIndex: -1,
};

const els = {
  projectList: $('#project-list'),
  drawerProjectList: $('#drawer-project-list'),
  projectSearch: $('#project-search'),
  drawerProjectSearch: $('#drawer-project-search'),
  miniStats: $('#mini-stats'),
  drawerMiniStats: $('#drawer-mini-stats'),
  search: $('#search'),
  statusChips: $('#status-chips'),
  labelFilter: $('#label-filter'),
  sort: $('#sort'),
  content: $('#content'),
  empty: $('#empty'),
  loading: $('#loading'),
  issueList: $('#issue-list'),
  issueDetail: $('#issue-detail'),
  logView: $('#log-view'),
  drawer: $('#drawer'),
  drawerOverlay: $('#drawer-overlay'),
  menuToggle: $('#menu-toggle'),
  drawerClose: $('#drawer-close'),
  newIssueBtn: $('#new-issue-btn'),
  newIssueModal: $('#new-issue-modal'),
  newIssueOverlay: $('#new-issue-overlay'),
  newIssueForm: $('#new-issue-form'),
  newProject: $('#new-project'),
  newTitle: $('#new-title'),
  newBody: $('#new-body'),
  newPriority: $('#new-priority'),
  newLabels: $('#new-labels'),
  newRef: $('#new-ref'),
  newCancel: $('#new-cancel'),
  modalError: $('#modal-error'),
};

let fetchSeq = 0;
let listAbort = null;
let sseSource = null;
let fallbackTimer = null;
let lastEventId = '';
let lastFocusedElement = null;

function nextSeq() {
  return ++fetchSeq;
}

function isStale(seq) {
  return seq !== fetchSeq;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const err = await res.json();
      if (err?.error?.message) message = err.error.message;
    } catch {
      // ignore
    }
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function formatAge(ts) {
  if (!ts) return '—';
  const diff = Math.max(0, Date.now() - Number(ts));
  const m = 60_000;
  const h = 60 * m;
  const d = 24 * h;
  const y = 365 * d;
  if (diff < m) return '0m';
  if (diff < h) return `${Math.floor(diff / m)}m`;
  if (diff < d) return `${Math.floor(diff / h)}h`;
  if (diff < y) return `${Math.floor(diff / d)}d`;
  return `${Math.floor(diff / y)}y`;
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function statusClass(status) {
  return `status-${status}`;
}

function projectColorClasses(color) {
  if (typeof color !== 'string') return PROJECT_PALETTE.zinc;
  return PROJECT_PALETTE[color.trim().toLowerCase()] ?? PROJECT_PALETTE.zinc;
}

function isHexColor(color) {
  return typeof color === 'string' && /^#/.test(color);
}

function projectDot(color, cls = 'w-2 h-2 rounded-full') {
  const node = document.createElement('span');
  node.className = cls;
  node.setAttribute('aria-hidden', 'true');
  if (isHexColor(color)) {
    node.style.backgroundColor = color;
  } else {
    node.classList.add(projectColorClasses(color));
  }
  return node;
}

function setVisible(el, visible) {
  el.classList.toggle('hidden', !visible);
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) {
    node.className = Array.isArray(cls) ? cls.filter(Boolean).join(' ') : cls;
  }
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function link(href, cls, text) {
  const a = el('a', cls, text);
  a.href = href;
  return a;
}

// ---------------------------------------------------------------------------
// Роутинг
// ---------------------------------------------------------------------------

function parseHash() {
  const raw = window.location.hash.slice(1) || '/';
  const [prefix, ...rest] = raw.split('/').filter(Boolean);
  if (prefix === 'project' && rest[0]) return { view: 'project', project: rest[0] };
  if (prefix === 'issue') return { view: 'issue', id: rest.join('/') };
  if (prefix === 'log') return { view: 'log' };
  return { view: 'home' };
}

function applyRoute() {
  const route = parseHash();
  if (route.view === 'project') state.project = route.project;
  else if (route.view === 'home') state.project = null;
  closeDrawer();
  refreshAll();
}

window.addEventListener('hashchange', applyRoute);

async function refreshAll() {
  const seq = nextSeq();
  if (listAbort) {
    listAbort.abort();
    listAbort = null;
  }

  try {
    await Promise.all([loadProjects(seq), loadStats(seq)]);
    if (isStale(seq)) return;

    const route = parseHash();
    if (route.view === 'issue') {
      await renderIssueDetail(route.id, seq);
    } else if (route.view === 'log') {
      await renderLog(seq);
    } else {
      await renderIssueList(seq);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    showError(err.message, () => refreshAll());
  }
}

const debouncedRefreshAll = debounce(() => {
  refreshAll();
}, 150);

// ---------------------------------------------------------------------------
// Сайдбар
// ---------------------------------------------------------------------------

function projectMatches(search, project) {
  const q = search.toLowerCase();
  return project.key.toLowerCase().includes(q) || project.name.toLowerCase().includes(q);
}

function renderSidebarList(root, search) {
  clear(root);
  const all = el('a', [
    'flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
    state.project === null ? 'bg-zinc-900 text-zinc-100 font-medium' : 'text-zinc-400',
  ]);
  all.href = '#/';
  all.appendChild(projectDot(null, 'w-2 h-2 rounded-full'));
  all.appendChild(el('span', 'truncate', 'Все проекты'));
  root.appendChild(all);

  for (const project of state.projects) {
    if (!projectMatches(search, project)) continue;
    const active = state.project === project.key;
    const row = el('a', [
      'flex items-center justify-between px-3 py-2 rounded text-sm hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
      active ? 'bg-zinc-900 text-zinc-100 font-medium' : 'text-zinc-400',
    ]);
    row.href = `#/project/${project.key}`;

    const left = el('span', 'flex items-center gap-2 truncate');
    left.appendChild(projectDot(project.color, 'w-2 h-2 rounded-full shrink-0'));
    const name = el('span', 'truncate', `${project.key} · ${project.name}`);
    if (project.archived_at) {
      name.textContent += ' (архив)';
      name.classList.add('opacity-60');
    }
    left.appendChild(name);
    row.appendChild(left);

    const badges = el('span', 'flex gap-1 text-[10px] font-mono shrink-0');
    for (const status of STATUS_ORDER) {
      const count = project.counts[status];
      const badge = el('span', [
        'px-1 rounded border',
        count > 0 ? statusClass(status) : 'border-zinc-800 text-zinc-600',
      ], count);
      if (count === 0) badge.classList.add('opacity-60');
      badges.appendChild(badge);
    }
    row.appendChild(badges);
    root.appendChild(row);
  }
}

function renderMiniStats(root) {
  clear(root);
  if (!state.stats) return;
  const total = state.stats.totals.total;
  const items = STATUS_ORDER.map((s) => `${s} ${state.stats.totals.byStatus[s]}`).join(' · ');
  root.textContent = `всего ${total} · ${items}`;
}

async function loadProjects(seq) {
  const data = await api('/api/projects');
  if (isStale(seq)) return;
  state.projects = data.projects;
  renderSidebarList(els.projectList, els.projectSearch.value);
  renderSidebarList(els.drawerProjectList, els.drawerProjectSearch.value);
}

async function loadStats(seq) {
  state.stats = await api('/api/stats');
  if (isStale(seq)) return;
  renderStatusChips();
  renderMiniStats(els.miniStats);
  renderMiniStats(els.drawerMiniStats);
}

// ---------------------------------------------------------------------------
// Список задач
// ---------------------------------------------------------------------------

function renderStatusChips() {
  clear(els.statusChips);
  const counts = state.stats?.totals?.byStatus || {};

  const makeChip = (value, label, count) => {
    const active = state.status === value;
    const chip = el('button', [
      'px-2 py-1 rounded text-xs border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
      active ? 'bg-zinc-800 border-zinc-600 text-zinc-100' : 'border-zinc-800 text-zinc-400 hover:border-zinc-600',
    ], `${label}${count !== undefined ? ` ${count}` : ''}`);
    chip.addEventListener('click', () => {
      state.status = value;
      state.cursor = null;
      state.selectedIndex = -1;
      window.location.hash = state.project ? `#/project/${state.project}` : '#/';
      renderIssueList();
    });
    return chip;
  };

  els.statusChips.appendChild(makeChip('active', 'active', undefined));
  els.statusChips.appendChild(makeChip('all', 'all', undefined));
  for (const status of STATUS_ORDER) {
    els.statusChips.appendChild(makeChip(status, STATUS_LABELS[status], counts[status]));
  }
}

function issueRow(issue) {
  const project = state.projects.find((p) => p.key === issue.project);
  const color = project?.color;

  const row = el('a', [
    'group block rounded border border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900 hover:border-zinc-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
  ]);
  row.href = `#/issue/${issue.id}`;
  row.dataset.issueId = issue.id;
  row.setAttribute('aria-current', 'false');

  // Десктоп: одна строка
  const desktop = el('div', 'hidden md:flex items-center gap-3 px-3 py-2');
  desktop.appendChild(projectDot(color, 'w-2 h-2 rounded-full shrink-0'));

  const id = el('span', 'font-mono text-xs text-zinc-500 shrink-0', issue.id);
  desktop.appendChild(id);

  const statusBadge = el('span', [
    'text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wide shrink-0',
    statusClass(issue.status),
  ], issue.status);
  desktop.appendChild(statusBadge);

  const title = el('span', 'flex-1 min-w-0 truncate text-sm font-medium text-zinc-100');
  title.textContent = issue.title;
  desktop.appendChild(title);

  if (issue.labels.length) {
    const labels = el('span', 'hidden lg:flex flex-wrap gap-1 shrink-0 max-w-[12rem]');
    for (const label of issue.labels) {
      labels.appendChild(el('span', 'text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-800 truncate', label));
    }
    desktop.appendChild(labels);
  }

  desktop.appendChild(el('span', 'text-xs text-zinc-500 shrink-0', `p${issue.priority}`));
  desktop.appendChild(el('span', 'text-xs text-zinc-500 shrink-0', formatAge(issue.created_at)));
  if (issue.assignee) {
    desktop.appendChild(el('span', 'text-xs text-zinc-400 truncate max-w-[10rem] shrink-0', issue.assignee));
  }
  row.appendChild(desktop);

  // Мобильная: карточка
  const mobile = el('div', 'md:hidden p-3 space-y-2');
  const top = el('div', 'flex items-center gap-2 flex-wrap');
  top.appendChild(projectDot(color, 'w-2 h-2 rounded-full'));
  top.appendChild(el('span', 'font-mono text-xs text-zinc-500', issue.id));
  top.appendChild(el('span', [
    'text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wide',
    statusClass(issue.status),
  ], issue.status));
  top.appendChild(el('span', 'text-xs text-zinc-500', `p${issue.priority}`));
  top.appendChild(el('span', 'text-xs text-zinc-500', formatAge(issue.created_at)));
  if (issue.assignee) {
    top.appendChild(el('span', 'text-xs text-zinc-400 truncate max-w-[12rem]', issue.assignee));
  }
  mobile.appendChild(top);

  const mTitle = el('div', 'text-sm font-medium text-zinc-100');
  mTitle.textContent = issue.title;
  mobile.appendChild(mTitle);

  if (issue.labels.length) {
    const labels = el('div', 'flex flex-wrap gap-1');
    for (const label of issue.labels) {
      labels.appendChild(el('span', 'text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-800', label));
    }
    mobile.appendChild(labels);
  }
  row.appendChild(mobile);

  return row;
}

function moveSelection(delta) {
  const items = $$('#issue-list > a[data-issue-id]');
  if (!items.length) return;
  if (state.selectedIndex < 0) state.selectedIndex = delta > 0 ? 0 : items.length - 1;
  else state.selectedIndex = (state.selectedIndex + delta + items.length) % items.length;
  updateSelection(items);
}

function updateSelection(items) {
  items = items || $$('#issue-list > a[data-issue-id]');
  items.forEach((node, i) => {
    const selected = i === state.selectedIndex;
    node.classList.toggle('selected', selected);
    node.setAttribute('aria-current', selected ? 'true' : 'false');
  });
  const selected = items[state.selectedIndex];
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function openSelected() {
  const items = $$('#issue-list > a[data-issue-id]');
  const selected = items[state.selectedIndex];
  if (selected) window.location.hash = selected.getAttribute('href');
}

async function renderIssueList(seq) {
  seq = seq ?? nextSeq();
  setVisible(els.loading, true);
  setVisible(els.empty, false);
  setVisible(els.issueList, false);
  setVisible(els.issueDetail, false);
  setVisible(els.logView, false);
  els.issueDetail.className = 'hidden';
  els.logView.className = 'hidden';

  // синхронизируем фильтры
  els.search.value = state.q;
  els.labelFilter.value = state.label;
  els.sort.value = state.sort;

  const controller = new AbortController();
  listAbort = controller;

  try {
    const params = new URLSearchParams();
    if (state.project) params.set('project', state.project);
    if (state.status && state.status !== 'active') params.set('status', state.status);
    if (state.label) params.set('label', state.label);
    if (state.q) params.set('q', state.q);
    params.set('sort', state.sort);
    params.set('limit', '25');
    if (state.cursor) params.set('cursor', state.cursor);

    const data = await api(`/api/issues?${params.toString()}`, { signal: controller.signal });
    if (isStale(seq)) return;
    if (controller.signal.aborted) return;

    if (!state.cursor) state.issues = data.issues;
    else state.issues.push(...data.issues);
    state.nextCursor = data.next_cursor;

    renderSidebarList(els.projectList, els.projectSearch.value);
    renderSidebarList(els.drawerProjectList, els.drawerProjectSearch.value);

    clear(els.issueList);
    if (state.issues.length === 0) {
      renderEmpty();
      setVisible(els.issueList, false);
    } else {
      setVisible(els.empty, false);
      setVisible(els.issueList, true);
      for (const issue of state.issues) {
        els.issueList.appendChild(issueRow(issue));
      }
      if (state.nextCursor) {
        const more = el('button', [
          'w-full py-2 text-xs text-zinc-400 border border-zinc-800 rounded hover:border-zinc-600 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
        ], 'Загрузить ещё');
        more.addEventListener('click', () => {
          state.cursor = state.nextCursor;
          renderIssueList();
        });
        els.issueList.appendChild(more);
      }
      if (state.selectedIndex < 0) state.selectedIndex = 0;
      if (state.selectedIndex >= state.issues.length) state.selectedIndex = state.issues.length - 1;
      updateSelection();
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    showError(err.message, () => renderIssueList());
  } finally {
    if (listAbort === controller) listAbort = null;
    setVisible(els.loading, false);
  }
}

function renderEmpty() {
  clear(els.empty);
  let text = 'Задач нет.';
  if (state.q) text = `По запросу «${state.q}» ничего не найдено.`;
  else if (state.label) text = `Нет задач с меткой «${state.label}».`;
  else if (state.status && state.status !== 'active' && state.status !== 'all') {
    text = `Нет задач со статусом ${state.status}.`;
  } else if (state.project) {
    text = `В проекте ${state.project} нет активных задач.`;
  }
  els.empty.appendChild(el('div', 'text-zinc-500 text-sm text-center mt-10', text));
  if (state.q || state.label || (state.status && state.status !== 'active' && state.status !== 'all')) {
    const reset = el('button', [
      'mt-3 px-3 py-1.5 rounded text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
    ], 'Сбросить фильтры');
    reset.addEventListener('click', () => {
      state.q = '';
      state.label = '';
      state.status = 'active';
      state.cursor = null;
      els.search.value = '';
      els.labelFilter.value = '';
      window.location.hash = state.project ? `#/project/${state.project}` : '#/';
      renderIssueList();
    });
    els.empty.appendChild(reset);
  }
  setVisible(els.empty, true);
}

function showError(message, retry) {
  clear(els.issueList);
  const box = el('div', 'text-center mt-10');
  box.appendChild(el('div', 'text-rose-400 text-sm', `Ошибка: ${message}`));
  if (retry) {
    const btn = el('button', [
      'mt-3 px-3 py-1.5 rounded text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
    ], 'Повторить');
    btn.addEventListener('click', retry);
    box.appendChild(btn);
  }
  els.issueList.appendChild(box);
  setVisible(els.issueList, true);
}

// ---------------------------------------------------------------------------
// Деталь задачи
// ---------------------------------------------------------------------------

function renderMarkdown(container, text) {
  clear(container);
  container.className = 'markdown text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap';
  const lines = String(text || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1;
      const pre = el('pre');
      const code = el('code');
      if (lang) code.className = `language-${lang}`;
      code.textContent = codeLines.join('\n');
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const ul = el('ul');
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        const li = el('li');
        renderInline(li, lines[i].slice(2));
        ul.appendChild(li);
        i += 1;
      }
      container.appendChild(ul);
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const ol = el('ol');
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        const li = el('li');
        renderInline(li, lines[i].replace(/^\d+\.\s/, ''));
        ol.appendChild(li);
        i += 1;
      }
      container.appendChild(ol);
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const p = el('p');
    renderInline(p, line);
    container.appendChild(p);
    i += 1;
  }
}

function renderInline(node, text) {
  const pattern = /(\*\*|__)(.*?)\1|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) {
      node.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    if (m[1] === '**' || m[1] === '__') {
      const strong = el('strong', 'font-semibold text-zinc-100');
      strong.textContent = m[2];
      node.appendChild(strong);
    } else if (m[3] !== undefined) {
      const code = el('code');
      code.textContent = m[3];
      node.appendChild(code);
    } else if (m[4] !== undefined) {
      const a = el('a', undefined, m[4]);
      a.href = m[5];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      node.appendChild(a);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) {
    node.appendChild(document.createTextNode(text.slice(last)));
  }
}

function kindIcon(kind) {
  const map = {
    created: '＋',
    status: '⇄',
    comment: '💬',
    edit: '✎',
    claim: '⚡',
    link: '↗',
  };
  return map[kind] || '•';
}

function describeEvent(event) {
  const data = event.data || {};
  switch (event.kind) {
    case 'created': return 'создана';
    case 'status': return `${data.from ?? '?'} → ${data.to ?? '?'}${data.reason ? ` · ${data.reason}` : ''}`;
    case 'claim': return `взята в работу: ${data.assignee ?? event.actor}`;
    case 'comment': return data.text ?? '';
    case 'edit': return data.field ? `правка ${data.field}: ${data.from ?? '—'} → ${data.to ?? '—'}` : 'правка';
    case 'link': return `связь: ${data.ref ?? data.url ?? ''}`;
    default: return JSON.stringify(data);
  }
}

async function setIssueStatus(id, status, currentStatus) {
  if (status === currentStatus) return;
  let reason = null;
  if (status === 'done' || status === 'cancelled') {
    const entered = window.prompt(`Причина закрытия как ${status} (можно оставить пустой):`);
    if (entered === null) return;
    reason = entered.trim() || null;
  }
  try {
    await api(`/api/issues/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, reason }),
    });
    await refreshAll();
  } catch (err) {
    showDetailError(err.message);
  }
}

async function postComment(id, text) {
  if (!text || !text.trim()) return;
  try {
    await api(`/api/issues/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ text: text.trim() }),
    });
    await refreshAll();
  } catch (err) {
    showDetailError(err.message);
  }
}

function showDetailError(message) {
  const existing = $('#detail-error');
  if (existing) existing.remove();
  const box = el('div', 'mb-4 p-3 rounded border border-rose-500/30 bg-rose-500/10 text-rose-400 text-sm', `Ошибка: ${message}`);
  box.id = 'detail-error';
  els.issueDetail.insertBefore(box, els.issueDetail.firstChild);
}

async function renderIssueDetail(id, seq) {
  seq = seq ?? nextSeq();
  setVisible(els.loading, true);
  setVisible(els.issueList, false);
  setVisible(els.issueDetail, false);
  setVisible(els.logView, false);
  setVisible(els.empty, false);
  els.issueDetail.className = 'hidden';
  els.logView.className = 'hidden';

  try {
    const [issue, eventsData] = await Promise.all([
      api(`/api/issues/${encodeURIComponent(id)}`),
      api(`/api/issues/${encodeURIComponent(id)}/events?limit=50`),
    ]);
    if (isStale(seq)) return;

    clear(els.issueDetail);
    els.issueDetail.className = 'max-w-3xl mx-auto';

    const project = state.projects.find((p) => p.key === issue.project);

    const header = el('div', 'border-b border-zinc-800 pb-4 mb-4');
    const back = link(state.project ? `#/project/${state.project}` : '#/', 'text-sm text-zinc-500 hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded', '← назад');
    header.appendChild(back);

    const titleWrap = el('div', 'mt-3 flex items-start gap-3');
    titleWrap.appendChild(projectDot(project?.color, 'w-2.5 h-2.5 rounded-full shrink-0 mt-2'));
    const title = el('h2', 'text-xl font-semibold text-zinc-100');
    title.textContent = issue.title;
    titleWrap.appendChild(title);
    header.appendChild(titleWrap);

    const meta = el('div', 'mt-2 flex flex-wrap items-center gap-2 text-xs');
    meta.appendChild(el('span', ['px-2 py-0.5 rounded border uppercase tracking-wide', statusClass(issue.status)], issue.status));
    meta.appendChild(el('span', 'text-zinc-400', `p${issue.priority}`));
    meta.appendChild(el('span', 'font-mono text-zinc-500', issue.id));
    if (issue.assignee) meta.appendChild(el('span', 'text-zinc-400', issue.assignee));
    header.appendChild(meta);
    els.issueDetail.appendChild(header);

    if (issue.body) {
      const bodyWrap = el('div', 'mb-6');
      renderMarkdown(bodyWrap, issue.body);
      els.issueDetail.appendChild(bodyWrap);
    }

    const details = el('div', 'mb-6 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-zinc-400 border border-zinc-800 rounded p-3 bg-zinc-900/20');
    const add = (label, value) => {
      const row = el('div', 'flex gap-2');
      row.appendChild(el('span', 'text-zinc-600', label));
      row.appendChild(el('span', 'text-zinc-300 truncate', value));
      details.appendChild(row);
    };
    add('создана', formatDate(issue.created_at));
    add('обновлена', formatDate(issue.updated_at));
    if (issue.closed_at) add('закрыта', formatDate(issue.closed_at));
    if (issue.close_reason) add('причина', issue.close_reason);
    if (issue.ref) {
      const refRow = el('div', 'flex gap-2');
      refRow.appendChild(el('span', 'text-zinc-600', 'ref'));
      const refLink = el('a', 'text-sky-400 hover:text-sky-300 truncate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded', issue.ref);
      refLink.href = issue.ref;
      refLink.target = '_blank';
      refLink.rel = 'noopener noreferrer';
      refRow.appendChild(refLink);
      details.appendChild(refRow);
    }
    if (issue.labels.length) add('метки', issue.labels.join(', '));
    els.issueDetail.appendChild(details);

    const statusPanel = el('div', 'mb-6 flex flex-wrap gap-2 items-center');
    statusPanel.setAttribute('role', 'group');
    statusPanel.setAttribute('aria-label', 'Сменить статус');
    for (const status of STATUS_ORDER) {
      const active = status === issue.status;
      const btn = el('button', [
        'px-3 py-1.5 rounded text-xs border uppercase tracking-wide transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
        statusClass(status),
        active ? 'ring-1 ring-zinc-500 opacity-100' : 'hover:opacity-90 opacity-80',
      ], status);
      btn.dataset.statusBtn = status;
      btn.dataset.active = active ? 'true' : 'false';
      btn.title = active ? 'текущий статус' : `перевести в ${status}`;
      btn.addEventListener('click', () => setIssueStatus(id, status, issue.status));
      statusPanel.appendChild(btn);
    }
    const closeHint = el('span', 'text-xs text-zinc-600 self-center ml-2', 'клик или s, затем Enter · для done/cancel нужна причина');
    statusPanel.appendChild(closeHint);
    els.issueDetail.appendChild(statusPanel);

    const eventsHeader = el('h3', 'text-sm font-semibold text-zinc-200 mb-2', `События (${eventsData.events.length})`);
    els.issueDetail.appendChild(eventsHeader);
    const eventsWrap = el('div', 'space-y-2');
    if (eventsData.events.length === 0) {
      eventsWrap.appendChild(el('div', 'text-zinc-500 text-sm', 'Событий нет.'));
    } else {
      for (const event of eventsData.events) {
        const row = el('div', 'flex gap-3 text-sm border-l-2 border-zinc-800 pl-3 py-1');
        const icon = el('div', 'text-zinc-500 select-none', kindIcon(event.kind));
        row.appendChild(icon);
        const body = el('div', 'flex-1 min-w-0');
        const head = el('div', 'flex flex-wrap items-center gap-2 text-xs text-zinc-500');
        head.appendChild(el('span', 'text-zinc-300', event.actor));
        head.appendChild(el('span', undefined, formatDate(event.ts)));
        head.appendChild(el('span', 'uppercase tracking-wide text-zinc-500', event.kind));
        body.appendChild(head);
        const desc = el('div', 'mt-0.5 text-zinc-300 break-words');
        desc.textContent = describeEvent(event);
        body.appendChild(desc);
        row.appendChild(body);
        eventsWrap.appendChild(row);
      }
    }
    els.issueDetail.appendChild(eventsWrap);

    // комментарий
    const commentWrap = el('div', 'mt-6 border-t border-zinc-800 pt-4');
    const commentLabel = el('label', 'block text-sm font-medium text-zinc-200 mb-2', 'Комментарий');
    commentLabel.htmlFor = 'comment-text';
    commentWrap.appendChild(commentLabel);
    const commentArea = el('textarea', [
      'w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 focus-visible:ring-2 focus-visible:ring-sky-500',
    ]);
    commentArea.id = 'comment-text';
    commentArea.rows = 3;
    commentArea.placeholder = 'Ctrl+Enter чтобы отправить';
    commentArea.setAttribute('aria-label', 'Текст комментария');
    commentArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        postComment(id, commentArea.value);
      }
    });
    commentWrap.appendChild(commentArea);
    const commentBtn = el('button', [
      'mt-2 px-3 py-1.5 rounded text-sm bg-zinc-100 text-zinc-900 hover:bg-zinc-200 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
    ], 'Отправить');
    commentBtn.addEventListener('click', () => postComment(id, commentArea.value));
    commentWrap.appendChild(commentBtn);
    els.issueDetail.appendChild(commentWrap);

    setVisible(els.issueDetail, true);
  } catch (err) {
    if (err.name === 'AbortError') return;
    renderIssueNotFound(id, err.status === 404 || /не найдена/i.test(err.message));
  } finally {
    setVisible(els.loading, false);
  }
}

function renderIssueNotFound(id, isNotFound) {
  clear(els.issueDetail);
  els.issueDetail.className = 'max-w-3xl mx-auto text-center mt-10';
  const title = el('h2', 'text-lg font-semibold text-zinc-100', isNotFound ? 'Задача не найдена' : 'Ошибка загрузки');
  els.issueDetail.appendChild(title);
  els.issueDetail.appendChild(el('p', 'text-sm text-zinc-400 mt-2', isNotFound ? `${id}: задачи с таким идентификатором нет.` : 'Не удалось загрузить задачу.'));
  const back = link(state.project ? `#/project/${state.project}` : '#/', 'inline-block mt-4 text-sm text-sky-400 hover:text-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded', '← назад к списку');
  els.issueDetail.appendChild(back);
  setVisible(els.issueDetail, true);
}

// ---------------------------------------------------------------------------
// Лента
// ---------------------------------------------------------------------------

async function renderLog(seq) {
  seq = seq ?? nextSeq();
  setVisible(els.loading, true);
  setVisible(els.issueList, false);
  setVisible(els.issueDetail, false);
  setVisible(els.logView, false);
  setVisible(els.empty, false);
  els.issueDetail.className = 'hidden';

  try {
    const data = await api('/api/log?limit=100');
    if (isStale(seq)) return;
    clear(els.logView);
    els.logView.className = 'max-w-3xl mx-auto';
    const header = el('h2', 'text-lg font-semibold text-zinc-100 mb-4', 'Лента событий');
    els.logView.appendChild(header);

    if (data.events.length === 0) {
      els.logView.appendChild(el('div', 'text-zinc-500 text-sm', 'Событий нет.'));
    } else {
      for (const event of data.events) {
        const row = el('div', 'flex gap-3 text-sm border-b border-zinc-800 py-2');
        const icon = el('div', 'text-zinc-500 select-none', kindIcon(event.kind));
        row.appendChild(icon);
        const body = el('div', 'flex-1 min-w-0');
        const head = el('div', 'flex flex-wrap items-center gap-2 text-xs text-zinc-500');
        if (event.issue) {
          const issueLink = link(`#/issue/${event.issue}`, 'font-mono text-sky-400 hover:text-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded', event.issue);
          head.appendChild(issueLink);
        }
        head.appendChild(el('span', 'text-zinc-300', event.actor));
        head.appendChild(el('span', undefined, formatDate(event.ts)));
        head.appendChild(el('span', 'uppercase tracking-wide text-zinc-500', event.kind));
        body.appendChild(head);
        const desc = el('div', 'mt-0.5 text-zinc-300 break-words');
        desc.textContent = describeEvent(event);
        body.appendChild(desc);
        row.appendChild(body);
        els.logView.appendChild(row);
      }
    }
    setVisible(els.logView, true);
  } catch (err) {
    if (err.name === 'AbortError') return;
    showError(err.message, () => renderLog());
  } finally {
    setVisible(els.loading, false);
  }
}

// ---------------------------------------------------------------------------
// Новая задача (модалка)
// ---------------------------------------------------------------------------

function openNewIssueModal() {
  lastFocusedElement = document.activeElement;
  clear(els.newProject);
  const projects = state.projects.length ? state.projects : [];
  for (const project of projects) {
    const opt = document.createElement('option');
    opt.value = project.key;
    opt.textContent = `${project.key} · ${project.name}`;
    if (state.project === project.key) opt.selected = true;
    els.newProject.appendChild(opt);
  }
  if (!els.newProject.value && projects[0]) {
    els.newProject.value = projects[0].key;
  }
  els.newTitle.value = '';
  els.newBody.value = '';
  els.newPriority.value = '2';
  els.newLabels.value = '';
  els.newRef.value = '';
  setVisible(els.modalError, false);
  els.modalError.textContent = '';
  setVisible(els.newIssueModal, true);
  els.newTitle.focus();
}

function closeNewIssueModal() {
  setVisible(els.newIssueModal, false);
  if (lastFocusedElement && lastFocusedElement.focus) {
    lastFocusedElement.focus();
  }
}

function showModalError(message) {
  els.modalError.textContent = message;
  setVisible(els.modalError, true);
}

async function submitNewIssue(e) {
  e.preventDefault();
  const title = els.newTitle.value.trim();
  if (!title) {
    showModalError('Заголовок обязателен.');
    return;
  }
  const labelsRaw = els.newLabels.value.trim();
  const labels = labelsRaw ? labelsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const body = {
    project: els.newProject.value,
    title,
    body: els.newBody.value,
    priority: Number(els.newPriority.value),
    labels,
    ref: els.newRef.value.trim() || null,
  };
  try {
    const issue = await api('/api/issues', { method: 'POST', body: JSON.stringify(body) });
    closeNewIssueModal();
    window.location.hash = `#/issue/${issue.id}`;
    await refreshAll();
  } catch (err) {
    showModalError(err.message);
  }
}

els.newIssueBtn.addEventListener('click', openNewIssueModal);
els.newCancel.addEventListener('click', closeNewIssueModal);
els.newIssueOverlay.addEventListener('click', closeNewIssueModal);
els.newIssueForm.addEventListener('submit', submitNewIssue);

els.newIssueModal.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeNewIssueModal();
  }
});

els.newBody.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault();
    submitNewIssue(e);
  }
});

// ---------------------------------------------------------------------------
// Живость (SSE + fallback polling)
// ---------------------------------------------------------------------------

function startFallbackPolling() {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => {
    refreshAll();
  }, 5000);
}

function stopFallbackPolling() {
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
}

function connectEventSource() {
  if (sseSource) {
    try {
      sseSource.close();
    } catch {
      // ignore
    }
  }
  const url = lastEventId ? `/api/stream?lastEventId=${encodeURIComponent(lastEventId)}` : '/api/stream';
  sseSource = new EventSource(url);
  sseSource.addEventListener('issue.created', (e) => {
    if (e.lastEventId) lastEventId = e.lastEventId;
    debouncedRefreshAll();
  });
  sseSource.addEventListener('issue.updated', (e) => {
    if (e.lastEventId) lastEventId = e.lastEventId;
    debouncedRefreshAll();
  });
  sseSource.onopen = () => {
    stopFallbackPolling();
  };
  sseSource.onerror = () => {
    if (sseSource.readyState === EventSource.CLOSED) {
      startFallbackPolling();
    }
  };
}

// ---------------------------------------------------------------------------
// События UI
// ---------------------------------------------------------------------------

function closeDrawer() {
  els.drawer.classList.add('-translate-x-full');
  els.drawerOverlay.classList.add('hidden');
  els.menuToggle.setAttribute('aria-expanded', 'false');
}

function openDrawer() {
  els.drawer.classList.remove('-translate-x-full');
  els.drawerOverlay.classList.remove('hidden');
  els.menuToggle.setAttribute('aria-expanded', 'true');
}

els.menuToggle.addEventListener('click', openDrawer);
els.drawerClose.addEventListener('click', closeDrawer);
els.drawerOverlay.addEventListener('click', closeDrawer);

els.projectSearch.addEventListener('input', (e) => {
  renderSidebarList(els.projectList, e.target.value);
});
els.drawerProjectSearch.addEventListener('input', (e) => {
  renderSidebarList(els.drawerProjectList, e.target.value);
});

const debouncedSearch = debounce((value) => {
  state.q = value;
  state.cursor = null;
  state.selectedIndex = -1;
  renderIssueList();
}, 200);

els.search.addEventListener('input', (e) => {
  debouncedSearch(e.target.value);
});

const debouncedLabel = debounce((value) => {
  state.label = value;
  state.cursor = null;
  state.selectedIndex = -1;
  renderIssueList();
}, 200);

els.labelFilter.addEventListener('input', (e) => {
  debouncedLabel(e.target.value);
});

els.sort.addEventListener('change', (e) => {
  state.sort = e.target.value;
  state.cursor = null;
  state.selectedIndex = -1;
  renderIssueList();
});

function handleGlobalKey(e) {
  const tag = e.target.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  // Esc и Ctrl+Enter обрабатываем всегда
  if (e.key === 'Escape') {
    if (!els.newIssueModal.classList.contains('hidden')) {
      e.preventDefault();
      closeNewIssueModal();
      return;
    }
    if (!els.drawer.classList.contains('-translate-x-full')) {
      e.preventDefault();
      closeDrawer();
      return;
    }
    if (typing) {
      e.preventDefault();
      e.target.blur();
      return;
    }
    if (window.location.hash !== '#/') {
      e.preventDefault();
      window.location.hash = state.project ? `#/project/${state.project}` : '#/';
      return;
    }
    return;
  }

  if (typing) return;

  if (e.key === '/') {
    e.preventDefault();
    els.search.focus();
    return;
  }
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    openNewIssueModal();
    return;
  }
  if (e.key === 'j' || e.key === 'J') {
    e.preventDefault();
    moveSelection(1);
    return;
  }
  if (e.key === 'k' || e.key === 'K') {
    e.preventDefault();
    moveSelection(-1);
    return;
  }
  if (e.key === 'Enter') {
    // Если фокус на кнопке/ссылке, не перехватываем
    if (tag === 'BUTTON' || tag === 'A') return;
    e.preventDefault();
    openSelected();
    return;
  }
  if (e.key === 'c' || e.key === 'C') {
    const ta = $('#comment-text');
    if (ta) {
      e.preventDefault();
      ta.focus();
    }
    return;
  }
  if (e.key === 's' || e.key === 'S') {
    const btns = $$('[data-status-btn]');
    if (btns.length) {
      e.preventDefault();
      const current = btns.find((b) => b.dataset.active === 'true');
      (current || btns[0]).focus();
    }
    return;
  }
}

document.addEventListener('keydown', handleGlobalKey);

// ---------------------------------------------------------------------------
// Инициализация
// ---------------------------------------------------------------------------

async function init() {
  applyRoute();
  connectEventSource();
}

init().catch((err) => {
  document.body.innerHTML = `<div class="p-4 text-rose-400">Ошибка инициализации: ${escapeHtml(err.message)}</div>`;
});
