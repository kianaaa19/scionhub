#!/usr/bin/env node
'use strict';
// scn: the ScionHub command-line client. Zero dependencies (Node >= 18).
// Server-centric: commits happen on the server; the working copy is sparse and optional.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CRED_FILE = path.join(os.homedir(), '.scn', 'credentials.json');
const STATE_DIR = '.scn';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const die = (m) => { process.stderr.write(`scn: ${m}\n`); process.exit(1); };

function usage() {
  process.stdout.write(`scn: ScionHub client

  scn login <server> <token>            save an API token (create one in ScionHub > Settings)
  scn whoami
  scn repo create <name> [--private] [--desc "text"]
  scn clone <server>/<owner>/<repo> [dir] [--sparse <path>...]
  scn status                            changes in your working copy (sparse scope only)
  scn pull                              fast-forward your working copy to main
  scn commit -m "msg" [--propose] [--title "t"]
                                        commit on the server (owners), or open a change request
  scn log [path] [-n 20]
  scn blame <file>

Environment: SCN_TOKEN and SCN_SERVER override saved credentials.
`);
}

// ---------- args ----------
function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' || a === '--message') flags.message = argv[++i];
    else if (a === '-n') flags.n = argv[++i];
    else if (a === '--title') flags.title = argv[++i];
    else if (a === '--desc') flags.desc = argv[++i];
    else if (a === '--propose') flags.propose = true;
    else if (a === '--private') flags.private = true;
    else if (a === '--sparse') { flags.sparse = []; while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) flags.sparse.push(argv[++i]); }
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a.startsWith('-')) die(`unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, flags };
}

// ---------- credentials & http ----------
function normServer(s) {
  s = s.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `${/^(localhost|127(\.\d+){3}|\[::1\]|[^/:]+\.local)(:\d+)?(\/|$)/i.test(s) ? 'http' : 'https'}://${s}`;
  return s;
}
function loadCreds() { try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch (_) { return {}; } }
function tokenFor(server) { return process.env.SCN_TOKEN || loadCreds()[server] || null; }

async function call(server, method, p, body, token) {
  const headers = {};
  const t = token === undefined ? tokenFor(server) : token;
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try { res = await fetch(server + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { die(`cannot reach ${server}: ${e.cause && e.cause.code ? e.cause.code : e.message}`); }
  return res;
}
async function json(server, method, p, body) {
  const res = await call(server, method, p, body);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.status = res.status; e.data = data; throw e;
  }
  return data;
}

// ---------- working copy ----------
function findRoot(start = process.cwd()) {
  let d = start;
  for (;;) {
    if (fs.existsSync(path.join(d, STATE_DIR, 'state.json'))) return d;
    const up = path.dirname(d);
    if (up === d) die('not inside an scn working copy');
    d = up;
  }
}
const loadState = (root) => JSON.parse(fs.readFileSync(path.join(root, STATE_DIR, 'state.json'), 'utf8'));
function saveState(root, st) {
  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, STATE_DIR, 'state.json'), JSON.stringify(st, null, 1));
}
const inScope = (st, p) => !st.sparse.length || st.sparse.some((x) => p === x || p.startsWith(`${x}/`));
const repoPath = (st) => `/api/repos/${encodeURIComponent(st.owner)}/${encodeURIComponent(st.repo)}`;
const safeJoin = (root, rel) => {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) die(`refusing path outside working copy: ${rel}`);
  return full;
};

async function walk(root, rel, out) {
  const full = path.join(root, rel);
  let st;
  try { st = await fsp.lstat(full); } catch (_) { return; }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const e of await fsp.readdir(full)) {
      if (!rel && e === STATE_DIR) continue;
      await walk(root, rel ? `${rel}/${e}` : e, out);
    }
  } else if (st.isFile()) out.push(rel);
}

async function localChanges(root, st) {
  const roots = st.sparse.length ? st.sparse : [''];
  const present = [];
  for (const r of roots) await walk(root, r, present);
  const seen = new Set(present);
  const added = [], modified = [], deleted = [];
  for (const p of present) {
    const tracked = st.files[p];
    if (!tracked) { added.push(p); continue; }
    const buf = await fsp.readFile(safeJoin(root, p));
    if (sha(buf) !== tracked.h) modified.push(p);
  }
  for (const p of Object.keys(st.files)) if (!seen.has(p) && inScope(st, p)) deleted.push(p);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

async function fetchBlobs(st, list, root) {
  let i = 0, done = 0;
  const worker = async () => {
    while (i < list.length) {
      const [p, h] = list[i++];
      const res = await call(st.server, 'GET', `${repoPath(st)}/blob/${h}`);
      if (!res.ok) die(`failed to fetch ${p} (HTTP ${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha(buf) !== h) die(`integrity check failed for ${p}`);
      const full = safeJoin(root, p);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, buf);
      done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
  return done;
}

async function pull(root, quiet) {
  const st = loadState(root);
  const m = await json(st.server, 'GET', `${repoPath(st)}/manifest?prefix=${encodeURIComponent(st.sparse.join('\n'))}`);
  const remote = m.files;
  const toFetch = [], conflicts = [], removals = [];
  const next = { ...st.files };
  for (const [p, meta] of Object.entries(remote)) {
    const old = st.files[p];
    if (old && old.h === meta.h) continue;
    const full = safeJoin(root, p);
    let localHash = null;
    try { localHash = sha(await fsp.readFile(full)); } catch (_) { /* absent */ }
    const locallyModified = old ? localHash !== null && localHash !== old.h : localHash !== null;
    if (locallyModified && localHash !== meta.h) { conflicts.push(p); continue; }
    toFetch.push([p, meta.h]); next[p] = meta;
  }
  for (const p of Object.keys(st.files)) {
    if (remote[p] || !inScope(st, p)) continue;
    let localHash = null;
    try { localHash = sha(await fsp.readFile(safeJoin(root, p))); } catch (_) { /* gone */ }
    if (localHash === null) { delete next[p]; continue; }
    if (localHash === st.files[p].h) { removals.push(p); delete next[p]; } else conflicts.push(p);
  }
  const n = await fetchBlobs(st, toFetch, root);
  for (const p of removals) {
    await fsp.rm(safeJoin(root, p), { force: true });
    for (let d = path.dirname(p); d && d !== '.'; d = path.dirname(d)) { try { await fsp.rmdir(safeJoin(root, d)); } catch (_) { break; } }
  }
  st.files = next;
  if (!conflicts.length) st.base = m.ref;
  saveState(root, st);
  if (!quiet || conflicts.length) {
    process.stdout.write(`${n} file(s) updated, ${removals.length} removed at ${m.ref ? m.ref.slice(0, 10) : 'empty'}\n`);
    for (const p of conflicts) process.stdout.write(`  conflict (local edits kept): ${p}\n`);
    if (conflicts.length) process.stdout.write('Resolve by committing your edit (it will be checked against main) or restoring the file, then pull again.\n');
  }
}

// ---------- commands ----------
async function cmdLogin(pos) {
  if (pos.length < 2) die('usage: scn login <server> <token>');
  const server = normServer(pos[0]);
  const res = await call(server, 'GET', '/api/me', undefined, pos[1]);
  const me = res.ok ? await res.json() : null;
  if (!me || !me.user) die('token rejected by server');
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true, mode: 0o700 });
  const creds = loadCreds(); creds[server] = pos[1];
  fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 1), { mode: 0o600 });
  process.stdout.write(`Logged in to ${server} as ${me.user.name}\n`);
}

async function cmdWhoami() {
  const server = process.env.SCN_SERVER ? normServer(process.env.SCN_SERVER) : Object.keys(loadCreds())[0];
  if (!server) die('not logged in');
  const me = await json(server, 'GET', '/api/me');
  process.stdout.write(me.user ? `${me.user.name} @ ${server}\n` : `not authenticated @ ${server}\n`);
}

async function cmdRepo(pos, flags) {
  if (pos[0] !== 'create' || !pos[1]) die('usage: scn repo create <name> [--private] [--desc text]');
  const server = process.env.SCN_SERVER ? normServer(process.env.SCN_SERVER) : Object.keys(loadCreds())[0];
  if (!server) die('not logged in');
  const r = await json(server, 'POST', '/api/repos', { name: pos[1], description: flags.desc || '', visibility: flags.private ? 'private' : 'public' });
  process.stdout.write(`Created ${r.owner}/${r.name}\nClone: scn clone ${server.replace(/^https?:\/\//, '')}/${r.owner}/${r.name}\n`);
}

async function cmdClone(pos, flags) {
  if (!pos[0]) die('usage: scn clone <server>/<owner>/<repo> [dir] [--sparse path...]');
  const m = /^(.*?)\/([^/]+)\/([^/]+?)\/?$/.exec(pos[0].replace(/\.git$/, ''));
  if (!m) die('expected <server>/<owner>/<repo>');
  const server = normServer(m[1]);
  const st = { server, owner: m[2], repo: m[3], base: null, sparse: (flags.sparse || []).map((s) => s.replace(/^\.?\/+|\/+$/g, '')).filter(Boolean), files: {} };
  const dir = path.resolve(pos[1] || st.repo);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) die(`${dir} already exists and is not empty`);
  await json(server, 'GET', repoPath(st)); // existence + access check before touching disk
  fs.mkdirSync(dir, { recursive: true });
  saveState(dir, st);
  await pull(dir, true);
  const after = loadState(dir);
  process.stdout.write(`Cloned ${st.owner}/${st.repo} into ${path.relative(process.cwd(), dir) || '.'}: ${Object.keys(after.files).length} file(s)${st.sparse.length ? ` (sparse: ${st.sparse.join(', ')})` : ''}\n`);
}

async function cmdStatus() {
  const root = findRoot(); const st = loadState(root);
  const c = await localChanges(root, st);
  process.stdout.write(`${st.owner}/${st.repo} @ ${st.base ? st.base.slice(0, 10) : 'empty'}${st.sparse.length ? `  sparse: ${st.sparse.join(' ')}` : ''}\n`);
  if (!c.added.length && !c.modified.length && !c.deleted.length) return process.stdout.write('clean\n');
  for (const p of c.added) process.stdout.write(`  A ${p}\n`);
  for (const p of c.modified) process.stdout.write(`  M ${p}\n`);
  for (const p of c.deleted) process.stdout.write(`  D ${p}\n`);
}

async function cmdCommit(flags) {
  if (!flags.message) die('commit message required: scn commit -m "message"');
  const root = findRoot(); const st = loadState(root);
  const c = await localChanges(root, st);
  const files = [];
  for (const p of [...c.added, ...c.modified]) files.push({ path: p, content_b64: (await fsp.readFile(safeJoin(root, p))).toString('base64') });
  for (const p of c.deleted) files.push({ path: p, delete: true });
  if (!files.length) return process.stdout.write('nothing to commit\n');
  const body = { base: st.base, message: flags.message, files, mode: flags.propose ? 'propose' : 'main', title: flags.title };
  let r;
  try { r = await json(st.server, 'POST', `${repoPath(st)}/changesets`, body); }
  catch (e) {
    if (e.status === 403) die(`${e.message}. You can't push to ${st.owner}/${st.repo}; use --propose to open a change request.`);
    if (e.data && e.data.conflicts) die(`${e.message}: ${e.data.conflicts.join(', ')}\nRun "scn pull" to see upstream changes.`);
    die(e.message);
  }
  if (flags.propose) {
    process.stdout.write(`Opened change request #${r.number} (changeset ${r.id.slice(0, 10)})\n${st.server}/#/${st.owner}/${st.repo}/cr/${r.number}\n`);
    return;
  }
  process.stdout.write(`Committed ${r.id.slice(0, 10)} to main${r.rebased ? ' (rebased onto newer main)' : ''}: ${r.files} file(s)\n`);
  await pull(root, true);
}

async function cmdLog(pos, flags) {
  const root = findRoot(); const st = loadState(root);
  const p = pos[0] ? pos[0].replace(/\/+$/, '') : '';
  const qs = new URLSearchParams({ limit: String(Number(flags.n) || 20) });
  if (p) qs.set('path', p);
  const r = await json(st.server, 'GET', `${repoPath(st)}/log?${qs}`);
  for (const c of r.changesets) process.stdout.write(`${c.id.slice(0, 10)}  ${new Date(c.ts).toISOString().slice(0, 16).replace('T', ' ')}  ${c.author.padEnd(12)} ${c.message.split('\n')[0]}\n`);
  if (r.more) process.stdout.write('… more (use -n)\n');
}

async function cmdBlame(pos) {
  if (!pos[0]) die('usage: scn blame <file>');
  const root = findRoot(); const st = loadState(root);
  const rel = path.relative(root, path.resolve(pos[0])).split(path.sep).join('/');
  const r = await json(st.server, 'GET', `${repoPath(st)}/blame?path=${encodeURIComponent(rel)}`);
  const w = String(r.lines.length).length;
  r.lines.forEach((l, i) => process.stdout.write(`${l.cs.id.slice(0, 8)} ${l.cs.author.padEnd(10).slice(0, 10)} ${String(i + 1).padStart(w)}: ${l.text}\n`));
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help' || flags.help) return usage();
  try {
    if (cmd === 'login') await cmdLogin(pos);
    else if (cmd === 'whoami') await cmdWhoami();
    else if (cmd === 'repo') await cmdRepo(pos, flags);
    else if (cmd === 'clone') await cmdClone(pos, flags);
    else if (cmd === 'status') await cmdStatus();
    else if (cmd === 'pull') await pull(findRoot(), false);
    else if (cmd === 'commit') await cmdCommit(flags);
    else if (cmd === 'log') await cmdLog(pos, flags);
    else if (cmd === 'blame') await cmdBlame(pos);
    else die(`unknown command "${cmd}" (try scn help)`);
  } catch (e) { die(e.message); }
})();
