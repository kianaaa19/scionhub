'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open, HttpError } = require('./store');

const cfg = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  allowRegistration: process.env.ALLOW_REGISTRATION !== '0',
  secureCookie: process.env.COOKIE_SECURE === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
  maxBodyBytes: Number(process.env.MAX_BODY_MB || 64) * 1024 * 1024,
};
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'scionhub_session';
const SESSION_TTL = 30 * 24 * 3600 * 1000;

function createApp(options = {}) {
  const c = { ...cfg, ...options };
  const store = open(c.dataDir);
  const limiter = new Map();

  const clientIp = (req) => (c.trustProxy && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?';
  function rateLimit(req, key, max, windowMs) {
    const k = `${key}:${clientIp(req)}`;
    const now = Date.now();
    let e = limiter.get(k);
    if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; limiter.set(k, e); }
    if (++e.n > max) throw new HttpError(429, 'too many attempts, slow down');
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of limiter) if (e.reset < now) limiter.delete(k);
    store.purgeTokens();
  }, 10 * 60 * 1000).unref();

  // ---------- http helpers ----------
  const SEC_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  function send(res, status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      ...SEC_HEADERS,
      'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  }
  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on('data', (d) => {
        n += d.length;
        if (n > c.maxBodyBytes) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; }
        chunks.push(d);
      });
      req.on('end', () => {
        if (!n) return resolve({});
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
        catch (_) { reject(new HttpError(400, 'invalid JSON')); }
      });
      req.on('error', reject);
    });
  }
  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  function authenticate(req) {
    const h = req.headers.authorization;
    if (h && /^Bearer /i.test(h)) {
      const u = store.userForToken(h.slice(7).trim());
      if (!u) throw new HttpError(401, 'invalid token');
      return { user: u, bearer: true };
    }
    const tok = parseCookies(req)[SESSION_COOKIE];
    const u = tok ? store.userForToken(tok) : null;
    return { user: u, bearer: false, sessionToken: tok };
  }
  const cookie = (value, maxAge) =>
    `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${c.secureCookie ? '; Secure' : ''}`;

  function requireUser(ctx) {
    if (!ctx.user) throw new HttpError(401, 'sign in required');
    return ctx.user;
  }
  function canRead(repo, user) { return repo.visibility === 'public' || (user && user.id === repo.owner_id); }
  function loadRepo(ctx, owner, name, need = 'read') {
    const repo = store.getRepo(owner, name);
    const isOwner = ctx.user && ctx.user.id === repo.owner_id;
    if (!canRead(repo, ctx.user)) throw new HttpError(404, 'repository not found');
    if (need === 'owner' && !isOwner) { if (!ctx.user) throw new HttpError(401, 'sign in required'); throw new HttpError(403, 'only the owner can do that'); }
    if (need === 'propose' && !ctx.user) throw new HttpError(401, 'sign in required');
    return { repo, isOwner: !!isOwner };
  }
  const repoInfo = (repo, isOwner, user) => {
    const fresh = store.freshRepo(repo);
    return {
      owner: repo.owner, name: repo.name, description: repo.description, visibility: repo.visibility,
      head: fresh.head, created: repo.created,
      permissions: { admin: isOwner, push: isOwner, propose: !!user },
    };
  };

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/healthz', async () => ({ status: 200, body: { ok: true } }));
  route('GET', '/api/stats', async () => ({ status: 200, body: store.stats() }));
  route('GET', '/api/config', async () => ({ status: 200, body: { allowRegistration: c.allowRegistration } }));

  // auth
  route('POST', '/api/register', async (ctx) => {
    if (!c.allowRegistration) throw new HttpError(403, 'registration is disabled');
    rateLimit(ctx.req, 'reg', 10, 3600 * 1000);
    const b = await readJson(ctx.req);
    const u = store.createUser(b.name, b.password);
    const tok = store.issueToken(u.id, 'session', 'web', SESSION_TTL);
    return { status: 201, body: { user: u }, headers: { 'Set-Cookie': cookie(tok, SESSION_TTL / 1000) } };
  });
  route('POST', '/api/login', async (ctx) => {
    rateLimit(ctx.req, 'login', 20, 10 * 60 * 1000);
    const b = await readJson(ctx.req);
    const u = store.verifyUser(b.name, b.password);
    if (!u) throw new HttpError(401, 'wrong username or password');
    const tok = store.issueToken(u.id, 'session', 'web', SESSION_TTL);
    return { status: 200, body: { user: u }, headers: { 'Set-Cookie': cookie(tok, SESSION_TTL / 1000) } };
  });
  route('POST', '/api/logout', async (ctx) => {
    if (ctx.sessionToken) store.revokeToken(ctx.sessionToken);
    return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': cookie('', 0) } };
  });
  route('GET', '/api/me', async (ctx) => ({ status: 200, body: { user: ctx.user ? { id: ctx.user.id, name: ctx.user.name } : null } }));
  route('GET', '/api/tokens', async (ctx) => ({ status: 200, body: { tokens: store.listTokens(requireUser(ctx).id) } }));
  route('POST', '/api/tokens', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const name = String(b.name || 'cli').slice(0, 60);
    return { status: 201, body: { token: store.issueToken(u.id, 'api', name, null), name } };
  });
  route('DELETE', '/api/tokens/:id', async (ctx, p) => {
    const n = store.deleteApiToken(Number(p.id), requireUser(ctx).id);
    if (!n) throw new HttpError(404, 'token not found');
    return { status: 200, body: { ok: true } };
  });

  // repos
  route('GET', '/api/repos', async (ctx) => ({
    status: 200, body: { repos: store.listRepos(ctx.user && ctx.user.id, ctx.query.owner, ctx.query.q) },
  }));
  route('POST', '/api/repos', async (ctx) => {
    const u = requireUser(ctx);
    const b = await readJson(ctx.req);
    const repo = store.createRepo(u, b.name, b.description, b.visibility || 'public');
    return { status: 201, body: repoInfo(repo, true, u) };
  });
  route('GET', '/api/repos/:owner/:repo', async (ctx, p) => {
    const { repo, isOwner } = loadRepo(ctx, p.owner, p.repo);
    return { status: 200, body: repoInfo(repo, isOwner, ctx.user) };
  });
  route('PATCH', '/api/repos/:owner/:repo', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo, 'owner');
    const b = await readJson(ctx.req);
    store.updateRepo(repo, b.description ?? repo.description, b.visibility ?? repo.visibility);
    return { status: 200, body: { ok: true } };
  });
  route('DELETE', '/api/repos/:owner/:repo', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo, 'owner');
    const b = await readJson(ctx.req);
    if (b.confirm !== `${p.owner}/${p.repo}`) throw new HttpError(400, 'type owner/repo in "confirm" to delete');
    store.deleteRepo(repo);
    return { status: 200, body: { ok: true } };
  });

  // reads
  route('GET', '/api/repos/:owner/:repo/tree', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo);
    return { status: 200, body: store.listDir(repo, ctx.query.ref, ctx.query.path) };
  });
  route('GET', '/api/repos/:owner/:repo/manifest', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo);
    const prefixes = ctx.query.prefix ? String(ctx.query.prefix).split('\n').map((s) => s.trim()).filter(Boolean) : [];
    return { status: 200, body: store.manifest(repo, ctx.query.ref, prefixes) };
  });
  route('GET', '/api/repos/:owner/:repo/blob/:hash', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo);
    const buf = store.readBlob(repo.id, p.hash);
    // content-addressed => immutable. Private repos must not be shared-cached.
    return { status: 200, body: buf, headers: {
      'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment',
      'Cache-Control': repo.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, max-age=31536000, immutable',
      ETag: `"${p.hash}"` } };
  });
  route('GET', '/api/repos/:owner/:repo/log', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo);
    return { status: 200, body: store.log(repo, { ref: ctx.query.ref, path: ctx.query.path, limit: ctx.query.limit, before: ctx.query.before }) };
  });
  route('GET', '/api/repos/:owner/:repo/changesets/:id', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo);
    return { status: 200, body: ctx.query.diff ? store.diffChangeset(repo, p.id) : store.getCs(repo, p.id) };
  });
  route('GET', '/api/repos/:owner/:repo/blame', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo);
    return { status: 200, body: store.blame(repo, ctx.query.ref, ctx.query.path) };
  });
  route('GET', '/api/repos/:owner/:repo/merge-base', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo);
    return { status: 200, body: store.mergeBase(repo, ctx.query.a, ctx.query.b) };
  });
  route('GET', '/api/repos/:owner/:repo/search', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo);
    return { status: 200, body: store.search(repo, ctx.query.ref, ctx.query.q) };
  });

  // writes: server-side commits
  route('POST', '/api/repos/:owner/:repo/changesets', async (ctx, p) => {
    const b = await readJson(ctx.req);
    const mode = b.mode === 'propose' ? 'propose' : 'main';
    const { repo } = loadRepo(ctx, p.owner, p.repo, mode === 'main' ? 'owner' : 'propose');
    const base = b.base === undefined ? undefined : b.base === null ? null : store.resolveCs(repo, String(b.base));
    const args = { base, files: b.files, message: b.message, author: ctx.user.name };
    if (mode === 'main') return { status: 201, body: store.commitMain(repo, args) };
    return { status: 201, body: store.propose(repo, { ...args, title: b.title, body: b.body }) };
  });

  // change requests
  route('GET', '/api/repos/:owner/:repo/crs', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo);
    const status = ['open', 'landed', 'closed', 'all'].includes(ctx.query.status) ? ctx.query.status : 'open';
    return { status: 200, body: { crs: store.listCrs(repo, status) } };
  });
  route('GET', '/api/repos/:owner/:repo/crs/:n', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo);
    const cr = store.crView(store.getCr(repo, p.n), true);
    return { status: 200, body: { ...cr, diff: store.diffChangeset(repo, cr.cs) } };
  });
  route('POST', '/api/repos/:owner/:repo/crs/:n/comments', async (ctx, p) => {
    const u = requireUser(ctx);
    const { repo } = loadRepo(ctx, p.owner, p.repo);
    const b = await readJson(ctx.req);
    store.comment(repo, p.n, u.name, b.body);
    return { status: 201, body: { ok: true } };
  });
  route('POST', '/api/repos/:owner/:repo/crs/:n/land', async (ctx, p) => {
    const { repo } = loadRepo(ctx, p.owner, p.repo, 'owner');
    return { status: 200, body: store.landCr(repo, p.n, ctx.user.name) };
  });
  route('POST', '/api/repos/:owner/:repo/crs/:n/close', async (ctx, p) => {
    const { repo, isOwner } = loadRepo(ctx, p.owner, p.repo, 'propose');
    const cr = store.getCr(repo, p.n);
    if (!isOwner && ctx.user.name !== cr.author) throw new HttpError(403, 'only the owner or author can close this');
    store.closeCr(repo, p.n, ctx.user.name);
    return { status: 200, body: { ok: true } };
  });

  // ---------- static ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
  function serveStatic(req, res, pathname) {
    if (pathname === '/scn') {
      return fs.readFile(path.join(__dirname, '..', 'bin', 'scn.js'), (err, buf) => (err ? send(res, 404, 'not found')
        : send(res, 200, buf, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Disposition': 'attachment; filename="scn"' })));
    }
    let rel = pathname === '/' ? '/index.html' : pathname;
    rel = path.normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return send(res, 404, 'not found');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'not found');
      const ext = path.extname(file);
      res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  // ---------- dispatcher ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith('/api/') && pathname !== '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
        return serveStatic(req, res, pathname);
      }
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const auth = authenticate(req);
        // CSRF: cookie-authenticated writes must come from our own UI (custom header can't be set cross-site without CORS)
        if (method !== 'GET' && !auth.bearer && auth.user && req.headers['x-requested-with'] !== 'scionhub') {
          throw new HttpError(403, 'missing X-Requested-With header');
        }
        const ctx = { req, res, user: auth.user, sessionToken: auth.sessionToken, query: Object.fromEntries(url.searchParams) };
        const out = await r.handler(ctx, params);
        return send(res, out.status, out.body, { 'Cache-Control': 'no-store', ...(out.headers || {}) });
      }
      throw new HttpError(404, 'no such endpoint');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) }, { 'Cache-Control': 'no-store' });
      console.error(`[${new Date().toISOString()}] ${req.method} ${pathname}`, e);
      return send(res, 500, { error: 'internal error' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 120000;
  server.headersTimeout = 20000;
  return { server, store, config: c };
}

if (require.main === module) {
  const { server, config } = createApp();
  server.listen(config.port, config.host, () => {
    console.log(`ScionHub listening on http://${config.host}:${config.port}  (data: ${config.dataDir})`);
  });
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp };
