'use strict';
// ScionHub core: a Scion-style, server-centric version control store.
//  - content-addressed, immutable blobs (gzip, sha256)
//  - changesets: entries of a write-ahead log, storing only files changed vs. first parent
//  - one authoritative ref (main) moved by compare-and-swap; no branches
//  - derived data (tree checkpoints, mainline index, path history) computed from changesets
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { splitLines, diffOps, hunks, isBinary } = require('./diff');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const CHECKPOINT_EVERY = 16;
const MAX_BLOB = 25 * 1024 * 1024;
const MAX_FILES_PER_CHANGESET = 5000;
const MAX_DIFF_BYTES = 512 * 1024;

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'scionhub.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, pass TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER);
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'public',
      head TEXT, created INTEGER NOT NULL, UNIQUE(owner_id, name));
    CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, data BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS repo_blobs (
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, hash TEXT NOT NULL, PRIMARY KEY (repo_id, hash));
    CREATE TABLE IF NOT EXISTS changesets (
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, id TEXT NOT NULL, parent TEXT,
      depth INTEGER NOT NULL, author TEXT NOT NULL, message TEXT NOT NULL, ts INTEGER NOT NULL, files TEXT NOT NULL,
      PRIMARY KEY (repo_id, id));
    CREATE TABLE IF NOT EXISTS mainline (
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, depth INTEGER NOT NULL, cs TEXT NOT NULL,
      PRIMARY KEY (repo_id, depth));
    CREATE UNIQUE INDEX IF NOT EXISTS mainline_cs ON mainline(repo_id, cs);
    CREATE TABLE IF NOT EXISTS path_history (
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, path TEXT NOT NULL, cs TEXT NOT NULL,
      hash TEXT, PRIMARY KEY (repo_id, path, cs));
    CREATE TABLE IF NOT EXISTS tree_checkpoints (
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, cs TEXT NOT NULL, tree TEXT NOT NULL,
      PRIMARY KEY (repo_id, cs));
    CREATE TABLE IF NOT EXISTS crs (
      id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, number INTEGER NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', cs TEXT NOT NULL, author TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', landed_cs TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      UNIQUE(repo_id, number));
    CREATE TABLE IF NOT EXISTS cr_comments (
      id INTEGER PRIMARY KEY, cr_id INTEGER NOT NULL REFERENCES crs(id) ON DELETE CASCADE,
      author TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL);
  `);

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE name = ?'),
    userById: db.prepare('SELECT id, name, created FROM users WHERE id = ?'),
    insUser: db.prepare('INSERT INTO users (name, pass, created) VALUES (?, ?, ?)'),
    insToken: db.prepare('INSERT INTO tokens (hash, user_id, kind, name, created, expires) VALUES (?, ?, ?, ?, ?, ?)'),
    tokenByHash: db.prepare('SELECT * FROM tokens WHERE hash = ?'),
    delTokenByHash: db.prepare('DELETE FROM tokens WHERE hash = ?'),
    listTokens: db.prepare("SELECT id, name, created FROM tokens WHERE user_id = ? AND kind = 'api' ORDER BY id DESC"),
    delApiToken: db.prepare("DELETE FROM tokens WHERE id = ? AND user_id = ? AND kind = 'api'"),
    purgeTokens: db.prepare('DELETE FROM tokens WHERE expires IS NOT NULL AND expires < ?'),
    insRepo: db.prepare('INSERT INTO repos (owner_id, name, description, visibility, created) VALUES (?, ?, ?, ?, ?)'),
    repoByName: db.prepare(`SELECT r.*, u.name AS owner FROM repos r JOIN users u ON u.id = r.owner_id
                            WHERE u.name = ? AND r.name = ?`),
    updRepo: db.prepare('UPDATE repos SET description = ?, visibility = ? WHERE id = ?'),
    delRepo: db.prepare('DELETE FROM repos WHERE id = ?'),
    casHead: db.prepare('UPDATE repos SET head = ? WHERE id = ? AND head IS ?'),
    repoHead: db.prepare('SELECT head FROM repos WHERE id = ?'),
    hasBlob: db.prepare('SELECT 1 FROM blobs WHERE hash = ?'),
    insBlob: db.prepare('INSERT OR IGNORE INTO blobs (hash, size, data) VALUES (?, ?, ?)'),
    getBlob: db.prepare('SELECT size, data FROM blobs WHERE hash = ?'),
    insRepoBlob: db.prepare('INSERT OR IGNORE INTO repo_blobs (repo_id, hash) VALUES (?, ?)'),
    hasRepoBlob: db.prepare('SELECT 1 FROM repo_blobs WHERE repo_id = ? AND hash = ?'),
    insCs: db.prepare(`INSERT INTO changesets (repo_id, id, parent, depth, author, message, ts, files)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    getCs: db.prepare('SELECT * FROM changesets WHERE repo_id = ? AND id = ?'),
    csByPrefix: db.prepare("SELECT id FROM changesets WHERE repo_id = ? AND id LIKE ? ESCAPE '\\' LIMIT 2"),
    insMainline: db.prepare('INSERT INTO mainline (repo_id, depth, cs) VALUES (?, ?, ?)'),
    mainlineByCs: db.prepare('SELECT depth FROM mainline WHERE repo_id = ? AND cs = ?'),
    mainlineSince: db.prepare(`SELECT c.files FROM mainline m JOIN changesets c ON c.repo_id = m.repo_id AND c.id = m.cs
                               WHERE m.repo_id = ? AND m.depth > ? ORDER BY m.depth`),
    insPH: db.prepare('INSERT OR IGNORE INTO path_history (repo_id, path, cs, hash) VALUES (?, ?, ?, ?)'),
    getCheckpoint: db.prepare('SELECT tree FROM tree_checkpoints WHERE repo_id = ? AND cs = ?'),
    insCheckpoint: db.prepare('INSERT OR IGNORE INTO tree_checkpoints (repo_id, cs, tree) VALUES (?, ?, ?)'),
    logPage: db.prepare(`SELECT c.id, c.parent, c.depth, c.author, c.message, c.ts, m.depth AS mdepth
                         FROM mainline m JOIN changesets c ON c.repo_id = m.repo_id AND c.id = m.cs
                         WHERE m.repo_id = ? AND m.depth <= ? ORDER BY m.depth DESC LIMIT ?`),
    pathLogPage: db.prepare(`SELECT c.id, c.parent, c.depth, c.author, c.message, c.ts, m.depth AS mdepth
                         FROM path_history ph JOIN mainline m ON m.repo_id = ph.repo_id AND m.cs = ph.cs
                         JOIN changesets c ON c.repo_id = m.repo_id AND c.id = m.cs
                         WHERE ph.repo_id = ? AND (ph.path = ? OR (ph.path >= ? AND ph.path < ?)) AND m.depth <= ?
                         GROUP BY c.id ORDER BY m.depth DESC LIMIT ?`),
    versions: db.prepare(`SELECT ph.hash, c.id, c.author, c.ts, c.message, m.depth AS mdepth
                          FROM path_history ph JOIN mainline m ON m.repo_id = ph.repo_id AND m.cs = ph.cs
                          JOIN changesets c ON c.repo_id = m.repo_id AND c.id = m.cs
                          WHERE ph.repo_id = ? AND ph.path = ? AND m.depth <= ? ORDER BY m.depth LIMIT 1001`),
    lastFile: db.prepare(`SELECT MAX(m.depth) AS d FROM path_history ph JOIN mainline m
                          ON m.repo_id = ph.repo_id AND m.cs = ph.cs
                          WHERE ph.repo_id = ? AND ph.path = ? AND m.depth <= ?`),
    lastDir: db.prepare(`SELECT MAX(m.depth) AS d FROM path_history ph JOIN mainline m
                         ON m.repo_id = ph.repo_id AND m.cs = ph.cs
                         WHERE ph.repo_id = ? AND ph.path >= ? AND ph.path < ? AND m.depth <= ?`),
    csAtDepth: db.prepare(`SELECT c.id, c.author, c.message, c.ts FROM mainline m
                           JOIN changesets c ON c.repo_id = m.repo_id AND c.id = m.cs
                           WHERE m.repo_id = ? AND m.depth = ?`),
    nextCr: db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM crs WHERE repo_id = ?'),
    insCr: db.prepare(`INSERT INTO crs (repo_id, number, title, body, cs, author, created, updated)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    getCr: db.prepare('SELECT * FROM crs WHERE repo_id = ? AND number = ?'),
    listCrs: db.prepare('SELECT * FROM crs WHERE repo_id = ? AND (? = \'all\' OR status = ?) ORDER BY number DESC LIMIT 200'),
    updCr: db.prepare('UPDATE crs SET status = ?, landed_cs = ?, updated = ? WHERE id = ?'),
    insComment: db.prepare('INSERT INTO cr_comments (cr_id, author, body, ts) VALUES (?, ?, ?, ?)'),
    listComments: db.prepare('SELECT id, author, body, ts FROM cr_comments WHERE cr_id = ? ORDER BY id'),
    listRepos: db.prepare(`SELECT r.id, r.name, r.description, r.visibility, r.head, r.created, u.name AS owner, u.id AS owner_id,
                           (SELECT COUNT(*) FROM mainline m WHERE m.repo_id = r.id) AS changesets
                           FROM repos r JOIN users u ON u.id = r.owner_id
                           WHERE (r.visibility = 'public' OR r.owner_id = ?) AND (? = '' OR u.name = ?)
                           AND (? = '' OR r.name LIKE ? OR r.description LIKE ?)
                           ORDER BY COALESCE((SELECT MAX(depth) FROM mainline m WHERE m.repo_id = r.id), -1) DESC, r.created DESC
                           LIMIT 100`),
    stats: db.prepare(`SELECT (SELECT COUNT(*) FROM users) AS users,
                              (SELECT COUNT(*) FROM repos WHERE visibility = 'public') AS repos,
                              (SELECT COUNT(*) FROM mainline) AS changesets,
                              (SELECT COUNT(*) FROM blobs) AS blobs`),
  };

  // ---------- helpers ----------
  const txn = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ } throw e; }
  };

  function cleanPath(p) {
    if (typeof p !== 'string') throw new HttpError(400, 'path must be a string');
    p = p.replace(/\\/g, '/');
    if (!p || p.length > 1024 || p.startsWith('/') || p.endsWith('/')) throw new HttpError(400, `invalid path: ${p.slice(0, 80)}`);
    for (const s of p.split('/')) {
      if (!s || s === '.' || s === '..' || s === '.scn' || /[\u0000-\u001f]/.test(s)) throw new HttpError(400, `invalid path: ${p.slice(0, 80)}`);
    }
    return p;
  }

  // ---------- users & tokens ----------
  function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
  }
  function checkPassword(pw, stored) {
    const [s, h] = stored.split(':');
    const got = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
    return crypto.timingSafeEqual(got, Buffer.from(h, 'hex'));
  }
  const RESERVED = new Set(['api', 'admin', 'new', 'login', 'register', 'settings', 'explore', 'static', 'assets', 'healthz', 'scionhub', 'scion']);
  function createUser(name, password) {
    name = String(name || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,38}$/.test(name)) throw new HttpError(400, 'username: 2-39 chars, a-z 0-9 and "-"');
    if (RESERVED.has(name)) throw new HttpError(400, 'that username is reserved');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new HttpError(400, 'password must be 8-200 characters');
    if (q.userByName.get(name)) throw new HttpError(409, 'username taken');
    const r = q.insUser.run(name, hashPassword(password), Date.now());
    return { id: Number(r.lastInsertRowid), name };
  }
  function verifyUser(name, password) {
    const u = q.userByName.get(String(name || '').toLowerCase());
    // always do the scrypt work to keep timing uniform
    const stored = u ? u.pass : `${'00'.repeat(16)}:${'00'.repeat(64)}`;
    let ok = false;
    try { ok = checkPassword(String(password || ''), stored); } catch (_) { ok = false; }
    return ok && u ? { id: u.id, name: u.name } : null;
  }
  function issueToken(userId, kind, name, ttlMs) {
    const token = (kind === 'api' ? 'scn_' : 'ses_') + crypto.randomBytes(32).toString('hex');
    q.insToken.run(sha256(token), userId, kind, name, Date.now(), ttlMs ? Date.now() + ttlMs : null);
    return token;
  }
  function userForToken(token) {
    if (!token) return null;
    const t = q.tokenByHash.get(sha256(token));
    if (!t) return null;
    if (t.expires && t.expires < Date.now()) { q.delTokenByHash.run(t.hash); return null; }
    const u = q.userById.get(t.user_id);
    return u ? { id: u.id, name: u.name, via: t.kind } : null;
  }

  // ---------- repos ----------
  function createRepo(owner, name, description, visibility) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(name || '') || name === '.' || name === '..') throw new HttpError(400, 'repo name: 1-80 chars of A-Z a-z 0-9 . _ -');
    if (!['public', 'private'].includes(visibility)) throw new HttpError(400, 'visibility must be public or private');
    description = String(description || '').slice(0, 300);
    if (q.repoByName.get(owner.name, name)) throw new HttpError(409, 'repository already exists');
    q.insRepo.run(owner.id, name, description, visibility, Date.now());
    return q.repoByName.get(owner.name, name);
  }
  function getRepo(owner, name) {
    const r = q.repoByName.get(owner, name);
    if (!r) throw new HttpError(404, 'repository not found');
    return r;
  }
  const freshRepo = (repo) => ({ ...repo, head: q.repoHead.get(repo.id).head });

  // ---------- blobs ----------
  function putBlob(repoId, buf) {
    if (buf.length > MAX_BLOB) throw new HttpError(413, 'file too large (max 25 MB)');
    const hash = sha256(buf);
    if (!q.hasBlob.get(hash)) q.insBlob.run(hash, buf.length, zlib.gzipSync(buf, { level: 6 }));
    q.insRepoBlob.run(repoId, hash);
    return { hash, size: buf.length };
  }
  function readBlob(repoId, hash) {
    if (!/^[0-9a-f]{64}$/.test(hash) || !q.hasRepoBlob.get(repoId, hash)) throw new HttpError(404, 'blob not found');
    const row = q.getBlob.get(hash);
    if (!row) throw new HttpError(404, 'blob not found');
    return zlib.gunzipSync(row.data);
  }

  // ---------- changesets & trees (derived data) ----------
  const treeCache = new Map(); // key -> Map(path -> [hash, size]); values are immutable
  function cacheTree(key, tree) {
    treeCache.set(key, tree);
    if (treeCache.size > 24) treeCache.delete(treeCache.keys().next().value);
  }
  const applyFiles = (tree, files) => {
    for (const f of files) {
      if (f.h === null) tree.delete(f.p); else tree.set(f.p, [f.h, f.s]);
    }
  };

  function resolveCs(repo, ref) {
    if (ref === undefined || ref === null || ref === '' || ref === 'main' || ref === 'head') return freshRepo(repo).head;
    if (!/^[0-9a-f]{8,64}$/.test(ref)) throw new HttpError(400, 'bad changeset id');
    if (ref.length === 64) {
      if (!q.getCs.get(repo.id, ref)) throw new HttpError(404, 'changeset not found');
      return ref;
    }
    const rows = q.csByPrefix.all(repo.id, `${ref}%`);
    if (!rows.length) throw new HttpError(404, 'changeset not found');
    if (rows.length > 1) throw new HttpError(400, 'ambiguous changeset id');
    return rows[0].id;
  }

  function treeAt(repoId, id) {
    if (!id) return new Map();
    const key = `${repoId}:${id}`;
    if (treeCache.has(key)) return treeCache.get(key);
    const chain = [];
    let cur = id, base = null;
    while (cur) {
      const k = `${repoId}:${cur}`;
      if (treeCache.has(k)) { base = treeCache.get(k); break; }
      const cp = q.getCheckpoint.get(repoId, cur);
      if (cp) { base = new Map(JSON.parse(cp.tree)); break; }
      const row = q.getCs.get(repoId, cur);
      if (!row) throw new HttpError(500, 'corrupt history');
      chain.push(row);
      cur = row.parent;
    }
    const tree = new Map(base || []);
    for (let i = chain.length - 1; i >= 0; i--) applyFiles(tree, JSON.parse(chain[i].files));
    cacheTree(key, tree);
    return tree;
  }

  function csView(row) {
    return { id: row.id, parent: row.parent, depth: row.depth, author: row.author, message: row.message, ts: row.ts };
  }
  function getCs(repo, ref) {
    const id = resolveCs(repo, ref);
    if (!id) throw new HttpError(404, 'repository is empty');
    const row = q.getCs.get(repo.id, id);
    return { ...csView(row), files: JSON.parse(row.files), onMain: !!q.mainlineByCs.get(repo.id, id) };
  }

  // Validate that applying `changes` to `baseTree` does not create file/dir collisions.
  function checkCollisions(baseTree, changes) {
    const adds = changes.filter((c) => c.h !== null).map((c) => c.p);
    if (!adds.length) return;
    const addSet = new Set(adds);
    for (const p of adds) {
      const segs = p.split('/');
      for (let i = 1; i < segs.length; i++) {
        const anc = segs.slice(0, i).join('/');
        if (baseTree.has(anc) && !changes.some((c) => c.p === anc && c.h === null)) throw new HttpError(409, `"${anc}" is a file, cannot create "${p}"`);
        if (addSet.has(anc)) throw new HttpError(400, `"${anc}" and "${p}" collide`);
      }
    }
    const prefixes = new Set();
    for (const p of adds) prefixes.add(`${p}/`);
    const deleted = new Set(changes.filter((c) => c.h === null).map((c) => c.p));
    for (const k of baseTree.keys()) {
      if (deleted.has(k)) continue;
      const segs = k.split('/');
      for (let i = 1; i < segs.length; i++) {
        if (addSet.has(segs.slice(0, i).join('/'))) throw new HttpError(409, `"${segs.slice(0, i).join('/')}" is a directory, cannot write it as a file`);
      }
    }
  }

  // Insert one changeset (caller owns the transaction).
  function insertChangeset(repoId, parent, parentDepth, author, message, changes, baseTree) {
    const files = changes.map((c) => ({ p: c.p, h: c.h, s: c.s })).sort((a, b) => (a.p < b.p ? -1 : 1));
    const ts = Date.now();
    const depth = parent ? parentDepth + 1 : 0;
    const id = sha256(JSON.stringify([parent, author, message, ts, files, crypto.randomBytes(8).toString('hex')]));
    q.insCs.run(repoId, id, parent, depth, author, message, ts, JSON.stringify(files));
    for (const f of files) q.insPH.run(repoId, f.p, id, f.h);
    if (depth % CHECKPOINT_EVERY === 0) {
      const tree = new Map(baseTree);
      applyFiles(tree, files);
      q.insCheckpoint.run(repoId, id, JSON.stringify([...tree]));
      cacheTree(`${repoId}:${id}`, tree);
    }
    return { id, depth, ts };
  }

  function normalizeChanges(repoId, input) {
    if (!Array.isArray(input) || !input.length) throw new HttpError(400, 'no files given');
    if (input.length > MAX_FILES_PER_CHANGESET) throw new HttpError(413, `too many files (max ${MAX_FILES_PER_CHANGESET})`);
    const seen = new Set();
    return input.map((f) => {
      const p = cleanPath(f && f.path);
      if (seen.has(p)) throw new HttpError(400, `duplicate path: ${p}`);
      seen.add(p);
      if (f.delete) return { p, h: null, s: 0 };
      let buf;
      if (typeof f.content_b64 === 'string') buf = Buffer.from(f.content_b64, 'base64');
      else if (typeof f.content === 'string') buf = Buffer.from(f.content, 'utf8');
      else throw new HttpError(400, `file ${p}: need content, content_b64, or delete`);
      const b = putBlob(repoId, buf);
      return { p, h: b.hash, s: b.size };
    });
  }

  const dropNoops = (baseTree, changes) => changes.filter((c) => {
    const cur = baseTree.get(c.p);
    return c.h === null ? !!cur : !cur || cur[0] !== c.h;
  });

  // Rebase `changes` (made against `base`, on main) onto the current head. Throws 409 on real conflicts.
  function rebaseOntoHead(repoId, base, head, changes) {
    if (base === head) return changes;
    let baseDepth = -1;
    if (base) {
      const m = q.mainlineByCs.get(repoId, base);
      if (!m) throw new HttpError(409, 'base changeset is not on main; recreate your change on top of main');
      baseDepth = m.depth;
    }
    const mainChanged = new Map();
    for (const row of q.mainlineSince.all(repoId, baseDepth)) {
      for (const f of JSON.parse(row.files)) mainChanged.set(f.p, f.h);
    }
    const conflicts = [];
    const out = [];
    for (const c of changes) {
      if (!mainChanged.has(c.p)) { out.push(c); continue; }
      if (mainChanged.get(c.p) === c.h) continue; // main already has exactly this
      conflicts.push(c.p);
    }
    if (conflicts.length) throw new HttpError(409, 'conflict: main changed these paths since your base', { conflicts });
    return out;
  }

  // Create a changeset directly on main (owner action). Server-side: nothing to push.
  function commitMain(repo, { base, files, message, author }) {
    message = cleanMessage(message);
    const changes = normalizeChanges(repo.id, files);
    return txn(() => {
      const head = q.repoHead.get(repo.id).head;
      if (base === undefined) base = head;
      if (base !== null && !q.getCs.get(repo.id, base)) throw new HttpError(404, 'base changeset not found');
      let eff = rebaseOntoHead(repo.id, base, head, changes);
      const headTree = treeAt(repo.id, head);
      eff = dropNoops(headTree, eff);
      if (!eff.length) throw new HttpError(422, 'no changes');
      checkCollisions(headTree, eff);
      const headRow = head ? q.getCs.get(repo.id, head) : null;
      const cs = insertChangeset(repo.id, head, headRow ? headRow.depth : -1, author, message, eff, headTree);
      q.insMainline.run(repo.id, cs.depth, cs.id);
      if (q.casHead.run(cs.id, repo.id, head).changes !== 1) throw new HttpError(409, 'main moved; retry');
      return { id: cs.id, depth: cs.depth, rebased: base !== head, files: eff.length };
    });
  }

  // Propose a change: stored as a changeset off main, plus a change request.
  function propose(repo, { base, files, message, title, body, author }) {
    message = cleanMessage(message);
    title = String(title || message.split('\n')[0]).trim().slice(0, 200);
    if (!title) throw new HttpError(400, 'title required');
    body = String(body || '').slice(0, 20000);
    const changes = normalizeChanges(repo.id, files);
    return txn(() => {
      const head = q.repoHead.get(repo.id).head;
      if (base === undefined) base = head;
      let baseDepth = -1;
      if (base !== null) {
        const m = q.mainlineByCs.get(repo.id, base);
        if (!m) throw new HttpError(409, 'base must be a changeset on main');
        baseDepth = m.depth;
      } else if (head !== null) throw new HttpError(409, 'base required: repository is not empty');
      const baseTree = treeAt(repo.id, base);
      const eff = dropNoops(baseTree, changes);
      if (!eff.length) throw new HttpError(422, 'no changes');
      checkCollisions(baseTree, eff);
      const cs = insertChangeset(repo.id, base, baseDepth, author, message, eff, baseTree);
      const number = q.nextCr.get(repo.id).n;
      const now = Date.now();
      q.insCr.run(repo.id, number, title, body, cs.id, author, now, now);
      return { id: cs.id, number };
    });
  }

  function cleanMessage(m) {
    m = String(m || '').trim();
    if (!m) throw new HttpError(400, 'commit message required');
    return m.slice(0, 10000);
  }

  // ---------- change requests ----------
  function crView(cr, withComments) {
    const v = { number: cr.number, title: cr.title, body: cr.body, cs: cr.cs, author: cr.author, status: cr.status,
      landed_cs: cr.landed_cs, created: cr.created, updated: cr.updated };
    if (withComments) v.comments = q.listComments.all(cr.id);
    return v;
  }
  function getCr(repo, number) {
    const cr = q.getCr.get(repo.id, Number(number));
    if (!cr) throw new HttpError(404, 'change request not found');
    return cr;
  }
  function landCr(repo, number, actor) {
    return txn(() => {
      const cr = getCr(repo, number);
      if (cr.status !== 'open') throw new HttpError(409, `change request is ${cr.status}`);
      const cs = q.getCs.get(repo.id, cr.cs);
      const head = q.repoHead.get(repo.id).head;
      const changes = JSON.parse(cs.files);
      let eff = rebaseOntoHead(repo.id, cs.parent, head, changes);
      const headTree = treeAt(repo.id, head);
      eff = dropNoops(headTree, eff);
      if (!eff.length) {
        q.updCr.run('landed', head, Date.now(), cr.id);
        return { landed: head, note: 'already applied' };
      }
      checkCollisions(headTree, eff);
      let landed;
      if (cs.parent === head) {
        // fast-forward: the proposed changeset itself becomes the new main tip
        q.insMainline.run(repo.id, cs.depth, cs.id);
        landed = cs.id;
        if (q.casHead.run(cs.id, repo.id, head).changes !== 1) throw new HttpError(409, 'main moved; retry');
      } else {
        const headRow = q.getCs.get(repo.id, head);
        const n = insertChangeset(repo.id, head, headRow.depth, cs.author, cs.message, eff, headTree);
        q.insMainline.run(repo.id, n.depth, n.id);
        landed = n.id;
        if (q.casHead.run(n.id, repo.id, head).changes !== 1) throw new HttpError(409, 'main moved; retry');
      }
      q.updCr.run('landed', landed, Date.now(), cr.id);
      q.insComment.run(cr.id, actor, `Landed as ${landed.slice(0, 10)}`, Date.now());
      return { landed };
    });
  }
  function closeCr(repo, number, actor) {
    const cr = getCr(repo, number);
    if (cr.status !== 'open') throw new HttpError(409, `change request is ${cr.status}`);
    q.updCr.run('closed', null, Date.now(), cr.id);
    q.insComment.run(cr.id, actor, 'Closed', Date.now());
  }
  function comment(repo, number, author, body) {
    body = String(body || '').trim();
    if (!body || body.length > 20000) throw new HttpError(400, 'comment must be 1-20000 characters');
    const cr = getCr(repo, number);
    q.insComment.run(cr.id, author, body, Date.now());
    q.updCr.run(cr.status, cr.landed_cs, Date.now(), cr.id);
  }

  // ---------- queries ----------
  function listDir(repo, ref, dir) {
    const id = resolveCs(repo, ref);
    if (!id) return { ref: null, entries: [] };
    const tree = treeAt(repo.id, id);
    dir = dir ? cleanPath(dir) : '';
    const prefix = dir ? `${dir}/` : '';
    const entries = new Map();
    for (const [p, [h, s]] of tree) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const i = rest.indexOf('/');
      if (i === -1) entries.set(rest, { name: rest, type: 'file', hash: h, size: s });
      else {
        const n = rest.slice(0, i);
        if (!entries.has(n)) entries.set(n, { name: n, type: 'dir' });
      }
    }
    if (dir && !entries.size) {
      if (tree.has(dir)) throw new HttpError(400, 'not a directory');
      throw new HttpError(404, 'path not found');
    }
    const list = [...entries.values()].sort((a, b) => (a.type === b.type ? (a.name < b.name ? -1 : 1) : a.type === 'dir' ? -1 : 1));
    const m = q.mainlineByCs.get(repo.id, id);
    if (m) {
      for (const e of list.slice(0, 100)) {
        const full = prefix + e.name;
        const d = e.type === 'file' ? q.lastFile.get(repo.id, full, m.depth).d : q.lastDir.get(repo.id, `${full}/`, `${full}0`, m.depth).d;
        if (d !== null && d !== undefined) {
          const c = q.csAtDepth.get(repo.id, d);
          if (c) e.last = { id: c.id, message: c.message.split('\n')[0], author: c.author, ts: c.ts };
        }
      }
    }
    return { ref: id, entries: list };
  }

  function manifest(repo, ref, prefixes) {
    const id = resolveCs(repo, ref);
    const tree = treeAt(repo.id, id);
    const ps = (prefixes || []).filter(Boolean).map((p) => p.replace(/\/+$/, ''));
    const files = {};
    for (const [p, [h, s]] of tree) {
      if (!ps.length || ps.some((x) => p === x || p.startsWith(`${x}/`))) files[p] = { h, s };
    }
    return { ref: id, files };
  }

  function fileAt(repo, ref, p) {
    const id = resolveCs(repo, ref);
    const e = treeAt(repo.id, id).get(cleanPath(p));
    if (!e) throw new HttpError(404, 'file not found');
    return { ref: id, hash: e[0], size: e[1] };
  }

  function log(repo, { ref, path: p, limit, before }) {
    const id = resolveCs(repo, ref);
    if (!id) return { changesets: [], more: false };
    const m = q.mainlineByCs.get(repo.id, id);
    if (!m) throw new HttpError(400, 'ref is not on main');
    limit = Math.max(1, Math.min(Number(limit) || 30, 100));
    const maxDepth = before !== undefined && before !== '' ? Math.min(m.depth, Number(before) - 1) : m.depth;
    const rows = p
      ? q.pathLogPage.all(repo.id, cleanPath(p), `${p}/`, `${p}0`, maxDepth, limit + 1)
      : q.logPage.all(repo.id, maxDepth, limit + 1);
    const more = rows.length > limit;
    return { changesets: rows.slice(0, limit).map((r) => ({ ...csView(r), mdepth: r.mdepth })), more };
  }

  function diffChangeset(repo, ref) {
    const cs = getCs(repo, ref);
    const baseTree = treeAt(repo.id, cs.parent);
    const out = [];
    for (const f of cs.files) {
      const old = baseTree.get(f.p);
      const entry = { path: f.p, status: f.h === null ? 'deleted' : old ? 'modified' : 'added', size: f.s };
      const oldBuf = old ? readBlob(repo.id, old[0]) : Buffer.alloc(0);
      const newBuf = f.h ? readBlob(repo.id, f.h) : Buffer.alloc(0);
      if (isBinary(oldBuf) || isBinary(newBuf)) entry.binary = true;
      else if (oldBuf.length > MAX_DIFF_BYTES || newBuf.length > MAX_DIFF_BYTES) entry.tooLarge = true;
      else {
        const d = hunks(splitLines(oldBuf.toString('utf8')), splitLines(newBuf.toString('utf8')));
        Object.assign(entry, d);
      }
      out.push(entry);
    }
    return { changeset: { id: cs.id, parent: cs.parent, author: cs.author, message: cs.message, ts: cs.ts, onMain: cs.onMain }, files: out };
  }

  function blame(repo, ref, p) {
    p = cleanPath(p);
    const id = resolveCs(repo, ref);
    const m = id && q.mainlineByCs.get(repo.id, id);
    if (!m) throw new HttpError(400, 'blame needs a changeset on main');
    const vs = q.versions.all(repo.id, p, m.depth);
    if (!vs.length) throw new HttpError(404, 'file has no history');
    if (vs.length > 1000) throw new HttpError(413, 'too many revisions to blame');
    let lines = [], attr = [];
    const meta = [];
    for (let vi = 0; vi < vs.length; vi++) {
      const v = vs[vi];
      meta.push({ id: v.id, author: v.author, ts: v.ts, message: v.message.split('\n')[0] });
      if (v.hash === null) { lines = []; attr = []; continue; }
      const buf = readBlob(repo.id, v.hash);
      if (isBinary(buf)) throw new HttpError(415, 'binary file');
      const nl = splitLines(buf.toString('utf8'));
      if (nl.length > 20000) throw new HttpError(413, 'file too long to blame');
      const ops = diffOps(lines, nl);
      const na = new Array(nl.length);
      for (const [t, ai, bi] of ops) {
        if (t === '=') na[bi] = attr[ai]; else if (t === '+') na[bi] = vi;
      }
      lines = nl; attr = na;
    }
    if (vs[vs.length - 1].hash === null) throw new HttpError(404, 'file is deleted at this revision');
    return { path: p, ref: id, lines: lines.map((text, i) => ({ text, cs: meta[attr[i]] })) };
  }

  function mergeBase(repo, a, b) {
    const x = resolveCs(repo, a), y = resolveCs(repo, b);
    if (!x || !y) return { base: null };
    const anc = new Set();
    for (let c = x; c;) { anc.add(c); c = q.getCs.get(repo.id, c).parent; }
    for (let c = y; c;) { if (anc.has(c)) return { base: c }; c = q.getCs.get(repo.id, c).parent; }
    return { base: null };
  }

  function search(repo, ref, term) {
    term = String(term || '').trim();
    if (term.length < 2) throw new HttpError(400, 'query too short');
    const id = resolveCs(repo, ref);
    const tree = treeAt(repo.id, id);
    const needle = term.toLowerCase();
    const results = [];
    let scanned = 0;
    for (const [p, [h, s]] of tree) {
      if (results.length >= 100 || scanned > 50 * 1024 * 1024) break;
      if (p.toLowerCase().includes(needle)) results.push({ path: p, line: 0, text: '(path match)' });
      if (s > 256 * 1024) continue;
      scanned += s;
      const buf = readBlob(repo.id, h);
      if (isBinary(buf)) continue;
      const ls = splitLines(buf.toString('utf8'));
      for (let i = 0; i < ls.length && results.length < 100; i++) {
        if (ls[i].toLowerCase().includes(needle)) results.push({ path: p, line: i + 1, text: ls[i].slice(0, 300) });
      }
    }
    return { ref: id, results };
  }

  function listRepos(viewerId, owner, term) {
    term = String(term || '').slice(0, 100);
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return q.listRepos.all(viewerId || 0, owner || '', owner || '', term, like, like).map((r) => ({
      owner: r.owner, name: r.name, description: r.description, visibility: r.visibility, head: r.head,
      created: r.created, changesets: r.changesets }));
  }

  return {
    db, q, txn, HttpError, cleanPath,
    createUser, verifyUser, issueToken, userForToken,
    revokeToken: (t) => q.delTokenByHash.run(sha256(t)),
    listTokens: (uid) => q.listTokens.all(uid),
    deleteApiToken: (id, uid) => q.delApiToken.run(id, uid).changes,
    purgeTokens: () => q.purgeTokens.run(Date.now()),
    userByName: (n) => q.userByName.get(String(n).toLowerCase()),
    createRepo, getRepo, freshRepo,
    updateRepo: (repo, description, visibility) => {
      if (!['public', 'private'].includes(visibility)) throw new HttpError(400, 'bad visibility');
      q.updRepo.run(String(description || '').slice(0, 300), visibility, repo.id);
    },
    deleteRepo: (repo) => { q.delRepo.run(repo.id); for (const k of [...treeCache.keys()]) if (k.startsWith(`${repo.id}:`)) treeCache.delete(k); },
    readBlob, resolveCs, getCs, listDir, manifest, fileAt, log, diffChangeset, blame, mergeBase, search, listRepos,
    commitMain, propose, getCr, crView, listCrs: (repo, status) => q.listCrs.all(repo.id, status, status).map((c) => crView(c)),
    landCr, closeCr, comment, treeAt,
    stats: () => q.stats.get(),
  };
}

module.exports = { open, HttpError, sha256 };
