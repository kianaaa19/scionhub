(() => {
'use strict';

// ---------- tiny DOM helpers (everything is built with textContent => no HTML injection) ----------
const h = (tag, attrs, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (kid) => {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return el;
};
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const enc = (s) => encodeURIComponent(s);
const encPath = (p) => (p ? p.split('/').map(enc).join('/') : '');
const short = (id) => (id ? id.slice(0, 10) : '');
const first = (s) => String(s || '').split('\n')[0];
const state = { user: null, config: { allowRegistration: true } };
let renderToken = 0;

function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  const t = [[31536000, 'y'], [2592000, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [n, u] of t) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return `${s}s ago`;
}
const when = (ts) => h('span', { title: new Date(ts).toLocaleString() }, ago(ts));
function bytes(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }

async function api(method, path, body, raw) {
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'scionhub', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch (_) { /* not json */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || `HTTP ${res.status}`);
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

function notice(kind, text) { return h('div', { class: `notice ${kind}`, role: kind === 'err' ? 'alert' : null }, text); }
function copyBtn(text) {
  const b = h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Copy to clipboard' }, 'Copy');
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch (_) { b.textContent = 'Press ⌘/Ctrl-C'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1400);
  });
  return b;
}
function setTitle(t) { document.title = t ? `${t} · ScionHub` : 'ScionHub'; }
function show(...nodes) { $app.replaceChildren(...nodes.flat().filter(Boolean)); }
const loading = () => show(h('p', { class: 'spin' }, 'Loading…'));
function fail(e) {
  if (e.status === 404) show(h('div', { class: 'empty' }, h('h1', {}, 'Not found'), h('p', {}, e.message), h('a', { href: '#/' }, 'Back home')));
  else show(notice('err', e.message), h('a', { href: '#/' }, 'Back home'));
}
const hostName = () => location.host;

// ---------- tiny, safe markdown ----------
function inline(text) {
  const out = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(h('code', {}, t.slice(1, -1)));
    else if (m[2]) out.push(h('strong', {}, t.slice(2, -2)));
    else if (m[3]) out.push(h('em', {}, t.slice(1, -1)));
    else {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t);
      const url = mm[2];
      if (/^(https?:\/\/|#|mailto:)/i.test(url)) out.push(h('a', { href: url, rel: 'noopener noreferrer', target: url.startsWith('#') ? null : '_blank' }, mm[1]));
      else out.push(mm[1]);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function markdown(src) {
  const root = h('div', { class: 'md' });
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; root.append(h('pre', {}, h('code', {}, buf.join('\n')))); continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(l);
    if (hm) { root.append(h(`h${hm[1].length}`, {}, inline(hm[2]))); i++; continue; }
    if (/^\s*([-*_])\1\1+\s*$/.test(l)) { root.append(h('hr')); i++; continue; }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      root.append(h('blockquote', {}, h('p', {}, inline(buf.join(' '))))); continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(h('li', {}, inline(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''))));
      root.append(h(ordered ? 'ol' : 'ul', {}, items)); continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>\s?|\s*([-*+]|\d+\.)\s+)/.test(lines[i])) buf.push(lines[i++]);
    root.append(h('p', {}, inline(buf.join(' '))));
  }
  return root;
}

// ---------- layout pieces ----------
function renderNav() {
  const u = state.user;
  $nav.replaceChildren(...(u ? [
    h('a', { class: 'btn sm primary', href: '#/new' }, '+ New repository'),
    h('a', { class: 'btn sm', href: `#/${u.name}` }, u.name),
    h('a', { class: 'btn sm', href: '#/settings' }, 'Settings'),
    h('button', { class: 'btn sm', type: 'button', onclick: async () => { await api('POST', '/logout', {}); state.user = null; renderNav(); location.hash = '#/'; route(); } }, 'Sign out'),
  ] : [h('a', { class: 'btn sm', href: '#/login' }, 'Sign in'), state.config.allowRegistration ? h('a', { class: 'btn sm primary', href: '#/login?mode=register' }, 'Sign up') : null]));
}
function repoRow(r) {
  return h('a', { class: 'row link', href: `#/${r.owner}/${r.name}`, style: 'color:inherit;text-decoration:none' },
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, h('span', { class: 'muted' }, `${r.owner} / `), r.name, ' ', r.visibility === 'private' ? h('span', { class: 'badge' }, 'private') : null),
      h('div', { class: 'muted small' }, r.description || 'No description')),
    h('div', { class: 'muted small' }, `${r.changesets} changeset${r.changesets === 1 ? '' : 's'}`));
}
const repoLink = (r, tail = '') => `#/${r.owner}/${r.name}${tail}`;

// ---------- pages ----------
async function pageHome() {
  setTitle('');
  const q = (location.hash.split('?')[1] && new URLSearchParams(location.hash.split('?')[1]).get('q')) || '';
  loading();
  const [{ repos }, stats] = await Promise.all([api('GET', `/repos${qs({ q })}`), api('GET', '/stats')]);
  show(
    q ? null : h('section', { class: 'hero' },
      h('h1', {}, 'Source control for always-online agents.'),
      h('p', {}, 'ScionHub hosts repositories on a Scion-style server: every commit, merge and rebase happens server-side, storage is content-addressed, and checkouts are sparse by default.'),
      h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
        state.user ? h('a', { class: 'btn primary', href: '#/new' }, 'Create a repository') : h('a', { class: 'btn primary', href: '#/login?mode=register' }, 'Get started'),
        h('a', { class: 'btn', href: '#/docs' }, 'How it works')),
      h('div', { class: 'stats' },
        [['repos', 'public repositories'], ['changesets', 'changesets landed'], ['blobs', 'unique blobs'], ['users', 'users']].map(([k, label]) =>
          h('div', { class: 'stat' }, h('b', {}, String(stats[k])), h('span', {}, label))))),
    h('h2', { style: q ? 'margin-top:0' : '' }, q ? `Repositories matching “${q}”` : 'Explore repositories'),
    repos.length ? h('div', { class: 'card list' }, repos.map(repoRow))
      : h('div', { class: 'card empty' }, q ? 'No repositories match.' : 'No repositories yet. Be the first to create one.'),
    q ? null : [h('h2', {}, 'Built different from git'), h('div', { class: 'grid3' }, [
      ['Server-side commits', 'Nothing to push. Commits, merges and rebases run on the server, so a write costs the size of the change, not the size of the repo.'],
      ['Changesets, not packfiles', 'Each changeset stores only the files that changed plus content-addressed blob pointers. Immutable data caches anywhere.'],
      ['Sparse and API-first', 'Check out just the directories you need with scn, or skip the checkout entirely: blame, history and diffs are all API calls.'],
    ].map(([t, d]) => h('div', { class: 'card card-pad' }, h('h3', {}, t), h('p', { class: 'muted', style: 'margin:0' }, d))))]);
}

function pageDocs() {
  setTitle('How it works');
  const host = location.origin;
  show(h('div', { class: 'docs' },
    h('h1', {}, 'How ScionHub works'),
    h('p', { class: 'muted' }, 'ScionHub implements the design principles of Anthropic’s Scion: clients are always online, the server does the computing, and the working copy is optional.'),
    h('h2', {}, 'Model'),
    h('ul', {},
      h('li', {}, h('b', {}, 'Changeset: '), 'an entry in a write-ahead log. It lists the files changed relative to its first parent with content-addressed blob pointers.'),
      h('li', {}, h('b', {}, 'One ref: '), h('code', {}, 'main'), ' only. Moving it is a compare-and-swap. There are no branches; proposals are change requests.'),
      h('li', {}, h('b', {}, 'Derived data: '), 'tree checkpoints, the mainline index and per-path history are computed from changesets and used for fast log, blame and directory listings.'),
      h('li', {}, h('b', {}, 'Landing: '), 'if main moved since your base, the server rebases your change automatically when the paths are disjoint, and reports a conflict listing the paths otherwise.')),
    h('h2', {}, 'Use the scn CLI'),
    h('pre', {}, `# create an API token in Settings, then:
scn login ${host} <token>
scn clone ${location.host}/<owner>/<repo> --sparse src docs
cd <repo>
$EDITOR src/main.py
scn status
scn commit -m "Fix the thing"          # committed on the server (owners)
scn commit -m "Fix the thing" --propose # opens a change request
scn log; scn blame src/main.py; scn pull`),
    h('h2', {}, 'Use the HTTP API'),
    h('pre', {}, `curl -H "Authorization: Bearer $TOKEN" ${host}/api/repos/<owner>/<repo>/log
curl -H "Authorization: Bearer $TOKEN" "${host}/api/repos/<owner>/<repo>/blame?path=src/main.py"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"message":"add file","files":[{"path":"hello.txt","content":"hi\\n"}]}' \\
  ${host}/api/repos/<owner>/<repo>/changesets`),
    h('p', { class: 'muted' }, 'Other endpoints: tree, manifest, blob/:hash, changesets/:id?diff=1, merge-base, search, crs, crs/:n/land.')));
}

async function pageAuth() {
  setTitle('Sign in');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  let mode = params.get('mode') === 'register' && state.config.allowRegistration ? 'register' : 'login';
  const err = h('div');
  const name = h('input', { type: 'text', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false' });
  const pw = h('input', { type: 'password', autocomplete: mode === 'register' ? 'new-password' : 'current-password', required: true, minlength: '8' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, mode === 'register' ? 'Create account' : 'Sign in');
  const form = h('form', { class: 'card card-pad', style: 'max-width:420px;margin:30px auto' },
    h('h1', {}, mode === 'register' ? 'Create your account' : 'Sign in'), err,
    h('label', {}, 'Username'), name, h('label', {}, 'Password'), pw,
    h('div', { style: 'margin-top:18px;display:flex;gap:12px;align-items:center' }, submit,
      state.config.allowRegistration ? h('a', { href: `#/login${mode === 'register' ? '' : '?mode=register'}` }, mode === 'register' ? 'I have an account' : 'Create an account') : null));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); submit.disabled = true; err.replaceChildren();
    try {
      const r = await api('POST', mode === 'register' ? '/register' : '/login', { name: name.value, password: pw.value });
      state.user = r.user; renderNav(); location.hash = '#/';
    } catch (ex) { err.replaceChildren(notice('err', ex.message)); submit.disabled = false; }
  });
  show(form); name.focus();
}

function needUser() {
  if (state.user) return true;
  show(h('div', { class: 'empty' }, h('h1', {}, 'Sign in required'), h('a', { class: 'btn primary', href: '#/login' }, 'Sign in')));
  return false;
}

function pageNewRepo() {
  setTitle('New repository');
  if (!needUser()) return;
  const err = h('div');
  const name = h('input', { type: 'text', required: true, pattern: '[A-Za-z0-9._\\-]{1,80}', autocapitalize: 'none', spellcheck: 'false' });
  const desc = h('input', { type: 'text', maxlength: '300' });
  const vis = h('select', {}, h('option', { value: 'public' }, 'Public: anyone can read'), h('option', { value: 'private' }, 'Private: only you'));
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Create repository');
  const form = h('form', { class: 'card card-pad', style: 'max-width:560px;margin:10px auto' },
    h('h1', {}, 'New repository'), err,
    h('label', {}, `Name (owner: ${state.user.name})`), name, h('label', {}, 'Description (optional)'), desc, h('label', {}, 'Visibility'), vis,
    h('div', { style: 'margin-top:18px' }, go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); go.disabled = true; err.replaceChildren();
    try { const r = await api('POST', '/repos', { name: name.value, description: desc.value, visibility: vis.value }); location.hash = `#/${r.owner}/${r.name}`; }
    catch (ex) { err.replaceChildren(notice('err', ex.message)); go.disabled = false; }
  });
  show(form); name.focus();
}

let freshToken = null;
async function pageSettings() {
  setTitle('Settings');
  if (!needUser()) return;
  loading();
  const { tokens } = await api('GET', '/tokens');
  const err = h('div');
  const out = freshToken ? h('div', { class: 'notice ok' }, h('b', {}, 'Copy this token now. It will not be shown again.'),
    h('div', { class: 'clone', style: 'margin-top:8px' }, h('code', {}, freshToken), copyBtn(freshToken)),
    h('div', { class: 'small', style: 'margin-top:8px' }, h('code', {}, `scn login ${location.origin} <token>`))) : null;
  freshToken = null;
  const name = h('input', { type: 'text', placeholder: 'e.g. my-agent', maxlength: '60', 'aria-label': 'Token name' });
  const form = h('form', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, name, h('button', { class: 'btn primary', type: 'submit' }, 'Create token'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.replaceChildren();
    try { const r = await api('POST', '/tokens', { name: name.value || 'cli' }); freshToken = r.token; pageSettings(); }
    catch (ex) { err.replaceChildren(notice('err', ex.message)); }
  });
  show(h('h1', {}, 'Settings'), h('h2', {}, 'API tokens'),
    h('p', { class: 'muted' }, 'Tokens let the scn CLI, agents and CI call the API as you. Send them as ', h('code', {}, 'Authorization: Bearer <token>'), '.'),
    err, out, form,
    tokens.length ? h('div', { class: 'card list', style: 'margin-top:14px' }, tokens.map((t) => h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, t.name), h('div', { class: 'muted small' }, 'created ', when(t.created))),
      h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { await api('DELETE', `/tokens/${t.id}`); pageSettings(); } }, 'Revoke')))) : h('p', { class: 'muted' }, 'No tokens yet.'));
}

async function pageProfile(owner) {
  setTitle(owner); loading();
  const { repos } = await api('GET', `/repos${qs({ owner })}`);
  show(h('h1', {}, owner), h('p', { class: 'muted' }, `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}`),
    repos.length ? h('div', { class: 'card list' }, repos.map(repoRow)) : h('div', { class: 'card empty' }, 'Nothing here yet.'));
}

// ---------- repository ----------
function repoHeader(r, tab) {
  const base = `#/${r.owner}/${r.name}`;
  const tabs = [['code', 'Code', ''], ['changesets', 'Changesets', '/changesets'], ['crs', 'Change requests', '/crs'], ['search', 'Search', '/search']];
  if (r.permissions.admin) tabs.push(['settings', 'Settings', '/settings']);
  return [
    h('h1', {}, h('a', { href: `#/${r.owner}` }, r.owner), h('span', { class: 'muted' }, ' / '), h('a', { href: base }, r.name), ' ',
      r.visibility === 'private' ? h('span', { class: 'badge' }, 'private') : null),
    r.description ? h('p', { class: 'muted', style: 'margin:0' }, r.description) : null,
    h('nav', { class: 'tabs', 'aria-label': 'Repository' }, tabs.map(([k, label, tail]) => h('a', { href: base + tail, class: k === tab ? 'on' : '', 'aria-current': k === tab ? 'page' : null }, label))),
  ];
}
function crumbs(r, ref, path, kind = 'tree') {
  const base = `#/${r.owner}/${r.name}`;
  const parts = path ? path.split('/') : [];
  const out = [h('a', { href: `${base}/tree/${ref}` }, r.name)];
  parts.forEach((p, i) => {
    out.push(h('span', { class: 'sep' }, '/'));
    const sub = parts.slice(0, i + 1).join('/');
    out.push(i === parts.length - 1 && kind !== 'tree' ? h('b', {}, p) : h('a', { href: `${base}/tree/${ref}/${encPath(sub)}` }, p));
  });
  return h('div', { class: 'crumbs' }, out);
}
function cloneBox(r) {
  const cmd = `scn clone ${location.host}/${r.owner}/${r.name}`;
  return h('div', { class: 'clone', title: 'Clone with the scn CLI' }, h('code', {}, cmd), copyBtn(cmd));
}

async function pageRepo(owner, name, rest, query) {
  loading();
  const r = await api('GET', `/repos/${enc(owner)}/${enc(name)}`);
  const base = `#/${owner}/${name}`;
  const sec = rest[0];
  setTitle(`${owner}/${name}`);
  const ref = (v) => (v && v !== 'main' ? v : r.head || 'main');
  if (!sec) return viewTree(r, 'main', '');
  if (sec === 'tree') return viewTree(r, rest[1] || 'main', rest.slice(2).join('/'));
  if (sec === 'blob') return viewBlob(r, rest[1] || 'main', rest.slice(2).join('/'));
  if (sec === 'blame') return viewBlame(r, rest[1] || 'main', rest.slice(2).join('/'));
  if (sec === 'edit') return viewEdit(r, rest.slice(1).join('/'), query);
  if (sec === 'changesets') return viewChangesets(r, query);
  if (sec === 'changeset') return viewChangeset(r, rest[1]);
  if (sec === 'crs') return viewCrs(r, query);
  if (sec === 'cr') return viewCr(r, rest[1]);
  if (sec === 'search') return viewSearch(r, query);
  if (sec === 'settings') return viewRepoSettings(r);
  void base; void ref;
  throw Object.assign(new Error('Page not found'), { status: 404 });
}

async function viewTree(r, refArg, path) {
  const base = `#/${r.owner}/${r.name}`;
  if (!r.head) {
    show(repoHeader(r, 'code'), h('div', { class: 'card card-pad' }, h('h2', { style: 'margin-top:0' }, 'This repository is empty'),
      h('p', { class: 'muted' }, 'Add the first files from the web or with the CLI.'), cloneBox(r),
      h('pre', { class: 'mono' }, `scn clone ${location.host}/${r.owner}/${r.name}\ncd ${r.name}\necho "# ${r.name}" > README.md\nscn commit -m "Initial commit"`),
      r.permissions.propose ? h('a', { class: 'btn primary', href: `${base}/edit/README.md?new=1` }, 'Create README.md') : null));
    return;
  }
  const data = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/tree${qs({ ref: refArg, path })}`);
  const ref = data.ref;
  const readme = data.entries.find((e) => e.type === 'file' && /^readme(\.md)?$/i.test(e.name) && e.size < 200000);
  let md = null;
  if (readme) {
    try { const res = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/blob/${readme.hash}`, undefined, true); md = await res.text(); } catch (_) { /* ignore */ }
  }
  const lastTop = data.entries.map((e) => e.last).filter(Boolean).sort((a, b) => b.ts - a.ts)[0];
  const isHead = ref === r.head;
  show(repoHeader(r, 'code'),
    h('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between' }, crumbs(r, refArg === 'main' ? 'main' : ref, path), cloneBox(r)),
    !isHead ? notice('warn', `Viewing changeset ${short(ref)}, not the latest. `) : null,
    h('div', { class: 'card' },
      h('div', { class: 'bar' },
        h('div', { class: 'grow' }, lastTop ? [h('b', {}, lastTop.author), ' ', first(lastTop.message), ' · ', when(lastTop.ts)] : `Changeset ${short(ref)}`),
        r.permissions.propose ? h('a', { class: 'btn sm', href: `${base}/edit/${encPath(path ? `${path}/` : '')}?new=1&dir=${enc(path)}` }, '+ New file') : null,
        h('a', { class: 'btn sm', href: `${base}/changesets${qs({ path })}` }, 'History')),
      h('div', { class: 'list' },
        path ? h('a', { class: 'row link', href: `${base}/tree/${refArg}/${encPath(path.split('/').slice(0, -1).join('/'))}`, style: 'color:inherit' }, h('span', { class: 'ico' }, '↰'), h('span', {}, '..')) : null,
        data.entries.map((e) => {
          const full = path ? `${path}/${e.name}` : e.name;
          return h('a', { class: 'row link', href: `${base}/${e.type === 'dir' ? 'tree' : 'blob'}/${refArg === 'main' ? 'main' : ref}/${encPath(full)}`, style: 'color:inherit;text-decoration:none' },
            h('span', { class: 'ico', 'aria-hidden': 'true' }, e.type === 'dir' ? '▸' : '·'), h('span', { class: 'grow' }, e.name, e.type === 'dir' ? '/' : ''),
            e.last ? h('span', { class: 'entry-last' }, first(e.last.message)) : null, e.last ? h('span', { class: 'entry-time' }, ago(e.last.ts)) : null);
        }))),
    md !== null ? h('div', { class: 'card', style: 'margin-top:18px' }, h('div', { class: 'bar' }, h('b', {}, readme.name)), markdown(md)) : null);
}

const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
async function viewBlob(r, refArg, path) {
  const base = `#/${r.owner}/${r.name}`;
  const f = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/manifest${qs({ ref: refArg, prefix: path })}`);
  const meta = f.files[path];
  if (!meta) throw Object.assign(new Error('File not found at this revision'), { status: 404 });
  const ext = (path.split('.').pop() || '').toLowerCase();
  const rawUrl = `/api/repos/${enc(r.owner)}/${enc(r.name)}/blob/${meta.h}`;
  const isHead = f.ref === r.head;
  let body;
  if (meta.s > 1048576) body = h('div', { class: 'empty' }, `File is too large to display (${bytes(meta.s)}).`);
  else {
    const res = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/blob/${meta.h}`, undefined, true);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (IMG[ext]) body = h('div', { class: 'empty' }, h('img', { src: URL.createObjectURL(new Blob([buf], { type: IMG[ext] })), alt: path, style: 'max-width:100%;max-height:70vh' }));
    else if (buf.subarray(0, 8000).includes(0)) body = h('div', { class: 'empty' }, 'Binary file. Use Raw to download.');
    else {
      const text = new TextDecoder().decode(buf);
      const lines = text.split('\n'); if (lines[lines.length - 1] === '') lines.pop();
      body = h('div', { class: 'codebox' }, h('table', { class: 'code' }, h('tbody', {}, lines.map((l, i) => h('tr', { id: `L${i + 1}` }, h('td', { class: 'ln' }, i + 1), h('td', {}, l || ' '))))));
    }
  }
  const refSeg = refArg === 'main' ? 'main' : f.ref;
  show(repoHeader(r, 'code'), crumbs(r, refSeg, path, 'blob'),
    !isHead ? notice('warn', `Viewing changeset ${short(f.ref)}, not the latest.`) : null,
    h('div', { class: 'card' },
      h('div', { class: 'bar' }, h('div', { class: 'grow' }, `${bytes(meta.s)}`),
        h('a', { class: 'btn sm', href: rawUrl, download: path.split('/').pop() }, 'Raw'),
        h('a', { class: 'btn sm', href: `${base}/blame/${refSeg}/${encPath(path)}` }, 'Blame'),
        h('a', { class: 'btn sm', href: `${base}/changesets${qs({ path })}` }, 'History'),
        r.permissions.propose && isHead ? h('a', { class: 'btn sm primary', href: `${base}/edit/${encPath(path)}` }, 'Edit') : null),
      body));
}

async function viewBlame(r, refArg, path) {
  const base = `#/${r.owner}/${r.name}`;
  const b = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/blame${qs({ ref: refArg, path })}`);
  let prev = null;
  show(repoHeader(r, 'code'), crumbs(r, refArg === 'main' ? 'main' : b.ref, path, 'blame'),
    h('div', { class: 'card' },
      h('div', { class: 'bar' }, h('div', { class: 'grow' }, 'Blame is computed server-side from path history'),
        h('a', { class: 'btn sm', href: `${base}/blob/${refArg === 'main' ? 'main' : b.ref}/${encPath(path)}` }, 'Normal view')),
      h('div', { class: 'codebox' }, h('table', { class: 'code' }, h('tbody', {}, b.lines.map((l, i) => {
        const newBlock = !prev || prev !== l.cs.id; prev = l.cs.id;
        return h('tr', { class: newBlock && i ? 'first' : '' },
          h('td', { class: 'bl', title: `${l.cs.author}: ${l.cs.message}` }, newBlock ? [h('a', { href: `${base}/changeset/${l.cs.id}` }, short(l.cs.id).slice(0, 7)), ` ${l.cs.author} · ${ago(l.cs.ts)}`] : ''),
          h('td', { class: 'ln' }, i + 1), h('td', {}, l.text || ' '));
      }))))));
}

async function viewEdit(r, path, query) {
  const base = `#/${r.owner}/${r.name}`;
  if (!needUser()) return;
  const isNew = !!query.new;
  let content = '';
  let baseId = r.head;
  if (!isNew) {
    const f = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/manifest${qs({ prefix: path })}`);
    const meta = f.files[path];
    if (!meta) throw Object.assign(new Error('File not found'), { status: 404 });
    if (meta.s > 1048576) throw new Error('File too large to edit in the browser. Use scn.');
    const res = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/blob/${meta.h}`, undefined, true);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.subarray(0, 8000).includes(0)) throw new Error('Binary files cannot be edited in the browser. Use scn.');
    content = new TextDecoder().decode(buf); baseId = f.ref;
  }
  const err = h('div');
  const pathIn = h('input', { type: 'text', value: isNew ? (path || '') : path, readonly: isNew ? null : true, required: true, placeholder: 'dir/file.txt', spellcheck: 'false' });
  const ta = h('textarea', { class: 'editor', spellcheck: 'false', 'aria-label': 'File contents' }); ta.value = content;
  const msg = h('input', { type: 'text', placeholder: isNew ? `Add ${path || 'file'}` : `Update ${path}`, maxlength: '300' });
  const mode = r.permissions.push ? 'main' : 'propose';
  let chosen = mode;
  const title = h('input', { type: 'text', placeholder: 'Change request title (defaults to the message)', maxlength: '200' });
  const titleWrap = h('div', { style: chosen === 'propose' ? '' : 'display:none' }, h('label', {}, 'Change request title'), title);
  const radios = r.permissions.push ? h('div', {},
    h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'mode', value: 'main', checked: true, onchange: () => { chosen = 'main'; titleWrap.style.display = 'none'; } }), h('span', {}, h('b', {}, 'Commit directly to main'), h('br'), h('span', { class: 'muted small' }, 'Created on the server and landed immediately.'))),
    h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'mode', value: 'propose', onchange: () => { chosen = 'propose'; titleWrap.style.display = ''; } }), h('span', {}, h('b', {}, 'Propose as a change request'), h('br'), h('span', { class: 'muted small' }, 'Review first, then land.')))) :
    notice('', 'You don’t have push access. Your edit will be submitted as a change request for the owner to review.');
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const del = !isNew && r.permissions.push ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
    if (!confirm(`Delete ${path} on main?`)) return;
    try { const res = await api('POST', `/repos/${enc(r.owner)}/${enc(r.name)}/changesets`, { base: baseId, message: msg.value || `Delete ${path}`, files: [{ path, delete: true }] }); location.hash = `${base}/changeset/${res.id}`; }
    catch (ex) { err.replaceChildren(notice('err', ex.message)); }
  } }, 'Delete file') : null;
  const form = h('form', {}, err, h('label', {}, 'Path'), pathIn, h('label', {}, 'Contents'), ta, h('label', {}, 'Commit message'), msg, radios, titleWrap,
    h('div', { style: 'margin-top:16px;display:flex;gap:10px' }, go, h('a', { class: 'btn', href: isNew ? base : `${base}/blob/main/${encPath(path)}` }, 'Cancel'), del));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); go.disabled = true; err.replaceChildren();
    const p = pathIn.value.trim();
    const message = msg.value.trim() || (isNew ? `Add ${p}` : `Update ${p}`);
    try {
      const res = await api('POST', `/repos/${enc(r.owner)}/${enc(r.name)}/changesets`, {
        mode: chosen, base: baseId, message, title: title.value || undefined, files: [{ path: p, content: ta.value }] });
      location.hash = chosen === 'propose' ? `${base}/cr/${res.number}` : `${base}/changeset/${res.id}`;
    } catch (ex) {
      const extra = ex.data && ex.data.conflicts ? ` (${ex.data.conflicts.join(', ')})` : '';
      err.replaceChildren(notice('err', ex.message + extra)); go.disabled = false;
    }
  });
  show(repoHeader(r, 'code'), h('h2', { style: 'margin-top:0' }, isNew ? 'New file' : `Edit ${path}`), form);
}

function diffView(files) {
  if (!files.length) return h('div', { class: 'card empty' }, 'No file changes.');
  const add = files.reduce((n, f) => n + (f.additions || 0), 0), del = files.reduce((n, f) => n + (f.deletions || 0), 0);
  return h('div', {},
    h('p', { class: 'muted' }, `${files.length} file${files.length === 1 ? '' : 's'} changed, `, h('span', { class: 'plus' }, `+${add}`), ' ', h('span', { class: 'minus' }, `−${del}`)),
    files.map((f) => h('div', { class: 'file-diff' },
      h('div', { class: 'bar' }, h('span', { class: 'badge' }, f.status), h('b', { class: 'mono grow' }, f.path),
        f.additions !== undefined ? [h('span', { class: 'plus' }, `+${f.additions}`), h('span', { class: 'minus' }, `−${f.deletions}`)] : null),
      f.binary ? h('div', { class: 'empty' }, `Binary file (${bytes(f.size)})`)
        : f.tooLarge ? h('div', { class: 'empty' }, 'Diff too large to display.')
          : !f.hunks.length ? h('div', { class: 'empty' }, f.status === 'added' ? 'Empty file.' : 'No textual changes.')
            : h('div', { class: 'codebox' }, h('table', { class: 'code' }, h('tbody', {}, f.hunks.map((hk) => [
              h('tr', { class: 'hunk' }, h('td', { class: 'ln' }, '…'), h('td', {}, hk.header)),
              hk.lines.map((l) => h('tr', { class: l.t === '+' ? 'add' : l.t === '-' ? 'del' : '' }, h('td', { class: 'ln' }, l.t === ' ' ? '' : l.t), h('td', {}, l.text || ' '))),
            ])))))));
}

async function viewChangesets(r, query) {
  const base = `#/${r.owner}/${r.name}`;
  if (!r.head) { show(repoHeader(r, 'changesets'), h('div', { class: 'card empty' }, 'No changesets yet.')); return; }
  const data = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/log${qs({ path: query.path, before: query.before, limit: 30 })}`);
  const lastDepth = data.changesets.length ? data.changesets[data.changesets.length - 1].mdepth : 0;
  show(repoHeader(r, 'changesets'),
    query.path ? notice('', ['History of ', h('code', {}, query.path), ' · ', h('a', { href: `${base}/changesets` }, 'clear filter')]) : null,
    data.changesets.length ? h('div', { class: 'card list' }, data.changesets.map((c) => h('a', { class: 'row link', href: `${base}/changeset/${c.id}`, style: 'color:inherit;text-decoration:none' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, first(c.message)), h('div', { class: 'muted small' }, c.author, ' · ', when(c.ts))),
      h('code', { class: 'muted' }, short(c.id).slice(0, 7))))) : h('div', { class: 'card empty' }, 'No changesets.'),
    data.more ? h('div', { style: 'margin-top:14px' }, h('a', { class: 'btn', href: `${base}/changesets${qs({ path: query.path, before: lastDepth })}` }, 'Older changesets →')) : null);
}

async function viewChangeset(r, id) {
  const base = `#/${r.owner}/${r.name}`;
  const d = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/changesets/${enc(id)}${qs({ diff: 1 })}`);
  const c = d.changeset;
  const lines = c.message.split('\n');
  show(repoHeader(r, 'changesets'),
    h('div', { class: 'card card-pad' }, h('h2', { style: 'margin-top:0' }, lines[0]),
      lines.length > 1 ? h('pre', { style: 'white-space:pre-wrap;font-family:var(--sans);margin:0 0 10px' }, lines.slice(1).join('\n').trim()) : null,
      h('div', { class: 'muted small' }, h('b', {}, c.author), ' · ', when(c.ts), ' · ', h('code', {}, short(c.id)), c.parent ? [' · parent ', h('a', { href: `${base}/changeset/${c.parent}` }, short(c.parent).slice(0, 7))] : ' · root',
        ' ', c.onMain ? h('span', { class: 'badge open' }, 'on main') : h('span', { class: 'badge' }, 'proposed'))),
    diffView(d.files));
}

async function viewCrs(r, query) {
  const base = `#/${r.owner}/${r.name}`;
  const status = ['open', 'landed', 'closed', 'all'].includes(query.status) ? query.status : 'open';
  const { crs } = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/crs${qs({ status })}`);
  show(repoHeader(r, 'crs'),
    h('div', { style: 'display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap' }, ['open', 'landed', 'closed', 'all'].map((s) => h('a', { class: `btn sm ${s === status ? 'primary' : ''}`, href: `${base}/crs?status=${s}` }, s))),
    crs.length ? h('div', { class: 'card list' }, crs.map((c) => h('a', { class: 'row link', href: `${base}/cr/${c.number}`, style: 'color:inherit;text-decoration:none' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, c.title), h('div', { class: 'muted small' }, `#${c.number} by ${c.author} · `, when(c.created))),
      h('span', { class: `badge ${c.status}` }, c.status))))
      : h('div', { class: 'card empty' }, h('p', {}, status === 'open' ? 'No open change requests.' : 'Nothing here.'),
        state.user ? h('p', { class: 'small' }, 'Propose a change by editing any file, or run ', h('code', {}, 'scn commit --propose'), '.') : null));
}

async function viewCr(r, n) {
  const base = `#/${r.owner}/${r.name}`;
  const cr = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/crs/${enc(n)}`);
  const err = h('div');
  const act = async (fn) => { err.replaceChildren(); try { await fn(); viewCr(r, n); } catch (ex) { err.replaceChildren(notice('err', ex.message + (ex.data && ex.data.conflicts ? `: ${ex.data.conflicts.join(', ')}` : ''))); } };
  const canClose = state.user && (r.permissions.admin || state.user.name === cr.author);
  const ta = h('textarea', { rows: '3', placeholder: 'Leave a comment', maxlength: '20000' });
  const cform = h('form', { style: 'margin-top:12px' }, ta, h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn primary', type: 'submit' }, 'Comment')));
  cform.addEventListener('submit', (e) => { e.preventDefault(); if (ta.value.trim()) act(() => api('POST', `/repos/${enc(r.owner)}/${enc(r.name)}/crs/${cr.number}/comments`, { body: ta.value })); });
  show(repoHeader(r, 'crs'),
    h('div', { style: 'display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap' },
      h('div', { style: 'flex:1;min-width:240px' }, h('h2', { style: 'margin:0' }, cr.title, h('span', { class: 'muted' }, ` #${cr.number}`)),
        h('div', { class: 'muted small', style: 'margin-top:4px' }, h('span', { class: `badge ${cr.status}` }, cr.status), ' ', h('b', {}, cr.author), ' · ', when(cr.created), ' · changeset ', h('a', { href: `${base}/changeset/${cr.cs}` }, short(cr.cs).slice(0, 7)),
          cr.landed_cs ? [' · landed as ', h('a', { href: `${base}/changeset/${cr.landed_cs}` }, short(cr.landed_cs).slice(0, 7))] : null)),
      cr.status === 'open' ? h('div', { style: 'display:flex;gap:8px' },
        r.permissions.admin ? h('button', { class: 'btn primary', type: 'button', onclick: (e) => { e.target.disabled = true; act(() => api('POST', `/repos/${enc(r.owner)}/${enc(r.name)}/crs/${cr.number}/land`, {})).finally(() => { e.target.disabled = false; }); } }, 'Land change') : null,
        canClose ? h('button', { class: 'btn danger', type: 'button', onclick: () => act(() => api('POST', `/repos/${enc(r.owner)}/${enc(r.name)}/crs/${cr.number}/close`, {})) }, 'Close') : null) : null),
    err, cr.body ? h('div', { class: 'card card-pad', style: 'margin-top:12px' }, h('div', { style: 'white-space:pre-wrap' }, cr.body)) : null,
    h('h2', {}, 'Changes'), diffView(cr.diff.files),
    h('h2', {}, `Discussion (${cr.comments.length})`),
    cr.comments.length ? h('div', { class: 'card list' }, cr.comments.map((c) => h('div', { class: 'comment' }, h('div', {}, h('span', { class: 'who' }, c.author), h('span', { class: 'muted small' }, ' · ', when(c.ts))), h('pre', {}, c.body)))) : null,
    state.user ? cform : h('p', { class: 'muted' }, h('a', { href: '#/login' }, 'Sign in'), ' to comment.'));
}

async function viewSearch(r, query) {
  const base = `#/${r.owner}/${r.name}`;
  const input = h('input', { type: 'search', value: query.q || '', placeholder: 'Search paths and file contents…', style: 'flex:1', 'aria-label': 'Search code' });
  const form = h('form', { style: 'display:flex;gap:8px;margin-bottom:14px' }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Search'));
  form.addEventListener('submit', (e) => { e.preventDefault(); location.hash = `${base}/search${qs({ q: input.value })}`; });
  let res = null, error = null;
  if (query.q && r.head) { try { res = await api('GET', `/repos/${enc(r.owner)}/${enc(r.name)}/search${qs({ q: query.q })}`); } catch (e) { error = e; } }
  show(repoHeader(r, 'search'), form, error ? notice('err', error.message) : null,
    res ? (res.results.length ? h('div', { class: 'card list' }, res.results.map((x) => h('a', { class: 'row link', href: `${base}/blob/main/${encPath(x.path)}`, style: 'color:inherit;text-decoration:none;align-items:flex-start' },
      h('div', { class: 'grow' }, h('div', { class: 'mono' }, x.path, x.line ? h('span', { class: 'muted' }, `:${x.line}`) : null), h('div', { class: 'mono muted', style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, x.text))))) : h('div', { class: 'card empty' }, 'No matches.')) : null);
  input.focus();
}

async function viewRepoSettings(r) {
  if (!r.permissions.admin) throw Object.assign(new Error('Owner only'), { status: 404 });
  const err = h('div');
  const desc = h('input', { type: 'text', value: r.description, maxlength: '300' });
  const vis = h('select', {}, h('option', { value: 'public', selected: r.visibility === 'public' ? true : null }, 'Public'), h('option', { value: 'private', selected: r.visibility === 'private' ? true : null }, 'Private'));
  const form = h('form', { class: 'card card-pad' }, err, h('label', {}, 'Description'), desc, h('label', {}, 'Visibility'), vis, h('div', { style: 'margin-top:16px' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save changes')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('PATCH', `/repos/${enc(r.owner)}/${enc(r.name)}`, { description: desc.value, visibility: vis.value }); err.replaceChildren(notice('ok', 'Saved.')); }
    catch (ex) { err.replaceChildren(notice('err', ex.message)); }
  });
  const confirmIn = h('input', { type: 'text', placeholder: `${r.owner}/${r.name}`, style: 'width:260px' });
  const danger = h('div', { class: 'card card-pad', style: 'margin-top:18px;border-color:var(--bad)' }, h('h3', { style: 'margin-top:0;color:var(--bad)' }, 'Delete this repository'),
    h('p', { class: 'muted small' }, 'This permanently deletes all changesets. Type the full name to confirm.'), confirmIn, ' ',
    h('button', { class: 'btn danger', type: 'button', onclick: async () => { try { await api('DELETE', `/repos/${enc(r.owner)}/${enc(r.name)}`, { confirm: confirmIn.value }); location.hash = '#/'; } catch (ex) { err.replaceChildren(notice('err', ex.message)); scrollTo(0, 0); } } }, 'Delete'));
  show(repoHeader(r, 'settings'), form, danger);
}

// ---------- router ----------
async function route() {
  const token = ++renderToken;
  const raw = location.hash.replace(/^#/, '') || '/';
  const [p, q] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(q || ''));
  const seg = p.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch (_) { return s; } });
  try {
    if (!seg.length) await pageHome();
    else if (seg[0] === 'login') await pageAuth();
    else if (seg[0] === 'new') pageNewRepo();
    else if (seg[0] === 'settings') await pageSettings();
    else if (seg[0] === 'docs') pageDocs();
    else if (seg.length === 1) await pageProfile(seg[0]);
    else await pageRepo(seg[0], seg[1], seg.slice(2), query);
  } catch (e) { if (token === renderToken) fail(e); }
  if (token === renderToken) window.scrollTo(0, 0);
}

document.getElementById('gsearch').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = document.getElementById('gq').value.trim();
  location.hash = v ? `#/?q=${enc(v)}` : '#/';
});

(async () => {
  try {
    const [me, cfg] = await Promise.all([api('GET', '/me'), api('GET', '/config')]);
    state.user = me.user; state.config = cfg;
  } catch (_) { /* offline or API down: render anyway */ }
  renderNav();
  window.addEventListener('hashchange', route);
  route();
})();
})();
