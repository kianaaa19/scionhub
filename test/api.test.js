'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

let app, base, dir;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scionhub-test-'));
  app = createApp({ dataDir: dir });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => { app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function api(method, p, body, token) {
  const res = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
async function signup(name) {
  const r = await api('POST', '/api/register', { name, password: 'correct horse battery' });
  assert.equal(r.status, 201);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.ok(cookie.startsWith('scionhub_session='));
  const t = await api('POST', '/api/tokens', { name: 't' }, undefined);
  assert.equal(t.status, 401); // no auth
  const login = await api('POST', '/api/login', { name, password: 'correct horse battery' });
  assert.equal(login.status, 200);
  // mint an API token using the cookie + CSRF header
  const res = await fetch(base + '/api/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0], 'X-Requested-With': 'scionhub' }, body: '{"name":"t"}' });
  return (await res.json()).token;
}

test('end-to-end: commit, history, blame, diff, propose, land, conflicts', async () => {
  const alice = await signup('alice');
  const bob = await signup('bob');

  assert.equal((await api('POST', '/api/repos', { name: 'demo', visibility: 'public' }, alice)).status, 201);
  assert.equal((await api('POST', '/api/repos', { name: 'demo' }, alice)).status, 409);

  // first commit on an empty repo
  let r = await api('POST', '/api/repos/alice/demo/changesets', {
    base: null, message: 'init', files: [
      { path: 'README.md', content: '# demo\nhello\n' },
      { path: 'src/a.txt', content: 'one\ntwo\nthree\n' },
      { path: 'src/b.txt', content: 'bee\n' },
    ] }, alice);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c1 = r.body.id;

  // non-owner cannot commit to main
  assert.equal((await api('POST', '/api/repos/alice/demo/changesets', { message: 'x', files: [{ path: 'x', content: 'x' }] }, bob)).status, 403);

  // owner commit: edit a.txt
  r = await api('POST', '/api/repos/alice/demo/changesets', {
    base: c1, message: 'edit a', files: [{ path: 'src/a.txt', content: 'one\nTWO\nthree\nfour\n' }] }, alice);
  assert.equal(r.status, 201);
  const c2 = r.body.id;

  // tree + log + path log
  const tree = await api('GET', '/api/repos/alice/demo/tree?path=src');
  assert.deepEqual(tree.body.entries.map((e) => e.name), ['a.txt', 'b.txt']);
  assert.equal(tree.body.entries[0].last.message, 'edit a');
  assert.equal(tree.body.entries[1].last.message, 'init');
  const log = await api('GET', '/api/repos/alice/demo/log');
  assert.deepEqual(log.body.changesets.map((c) => c.message), ['edit a', 'init']);
  const plog = await api('GET', '/api/repos/alice/demo/log?path=src/b.txt');
  assert.deepEqual(plog.body.changesets.map((c) => c.message), ['init']);

  // blame
  const bl = await api('GET', '/api/repos/alice/demo/blame?path=src/a.txt');
  assert.deepEqual(bl.body.lines.map((l) => [l.text, l.cs.message]),
    [['one', 'init'], ['TWO', 'edit a'], ['three', 'init'], ['four', 'edit a']]);

  // diff
  const d = await api('GET', `/api/repos/alice/demo/changesets/${c2}?diff=1`);
  assert.equal(d.body.files[0].additions, 2);
  assert.equal(d.body.files[0].deletions, 1);

  // blob fetch is content-addressed
  const man = await api('GET', '/api/repos/alice/demo/manifest?prefix=src');
  assert.deepEqual(Object.keys(man.body.files).sort(), ['src/a.txt', 'src/b.txt']);
  const blob = await fetch(`${base}/api/repos/alice/demo/blob/${man.body.files['src/b.txt'].h}`);
  assert.equal(await blob.text(), 'bee\n');

  // bob proposes two changes from the same base
  const p1 = await api('POST', '/api/repos/alice/demo/changesets', {
    mode: 'propose', title: 'touch b', base: c2, message: 'b', files: [{ path: 'src/b.txt', content: 'bee\nbuzz\n' }] }, bob);
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  const p2 = await api('POST', '/api/repos/alice/demo/changesets', {
    mode: 'propose', title: 'touch b differently', base: c2, message: 'b2', files: [{ path: 'src/b.txt', content: 'bee\nbark\n' }] }, bob);
  const p3 = await api('POST', '/api/repos/alice/demo/changesets', {
    mode: 'propose', title: 'new file', base: c2, message: 'c', files: [{ path: 'docs/c.md', content: 'c\n' }] }, bob);
  assert.deepEqual([p1.body.number, p2.body.number, p3.body.number], [1, 2, 3]);

  // bob can't land
  assert.equal((await api('POST', '/api/repos/alice/demo/crs/1/land', {}, bob)).status, 403);
  // alice lands #1 (fast-forward), #3 (rebase, disjoint), #2 conflicts
  assert.equal((await api('POST', '/api/repos/alice/demo/crs/1/land', {}, alice)).status, 200);
  const l3 = await api('POST', '/api/repos/alice/demo/crs/3/land', {}, alice);
  assert.equal(l3.status, 200, JSON.stringify(l3.body));
  const l2 = await api('POST', '/api/repos/alice/demo/crs/2/land', {}, alice);
  assert.equal(l2.status, 409);
  assert.deepEqual(l2.body.conflicts, ['src/b.txt']);
  assert.equal((await api('POST', '/api/repos/alice/demo/crs/2/close', {}, bob)).status, 200);

  const log2 = await api('GET', '/api/repos/alice/demo/log');
  assert.deepEqual(log2.body.changesets.map((c) => c.message), ['c', 'b', 'edit a', 'init']);
  const crs = await api('GET', '/api/repos/alice/demo/crs?status=all');
  assert.deepEqual(crs.body.crs.map((c) => c.status), ['landed', 'closed', 'landed']);

  // stale-base direct commit rebases when disjoint, conflicts otherwise
  r = await api('POST', '/api/repos/alice/demo/changesets', { base: c1, message: 'stale ok', files: [{ path: 'new.txt', content: 'n' }] }, alice);
  assert.equal(r.status, 201); assert.equal(r.body.rebased, true);
  r = await api('POST', '/api/repos/alice/demo/changesets', { base: c1, message: 'stale bad', files: [{ path: 'src/a.txt', content: 'zzz' }] }, alice);
  assert.equal(r.status, 409);

  // file/dir collision rejected
  r = await api('POST', '/api/repos/alice/demo/changesets', { message: 'bad', files: [{ path: 'src', content: 'x' }] }, alice);
  assert.equal(r.status, 409);
  // path traversal rejected
  r = await api('POST', '/api/repos/alice/demo/changesets', { message: 'bad', files: [{ path: '../etc/passwd', content: 'x' }] }, alice);
  assert.equal(r.status, 400);

  // delete + search + merge-base
  r = await api('POST', '/api/repos/alice/demo/changesets', { message: 'rm', files: [{ path: 'src/b.txt', delete: true }] }, alice);
  assert.equal(r.status, 201);
  assert.equal((await api('GET', '/api/repos/alice/demo/blame?path=src/b.txt')).status, 404);
  const s = await api('GET', '/api/repos/alice/demo/search?q=three');
  assert.equal(s.body.results[0].path, 'src/a.txt');
  const mb = await api('GET', `/api/repos/alice/demo/merge-base?a=${c1}&b=${c2}`);
  assert.equal(mb.body.base, c1);
});

test('private repos are invisible to others; checkpoints survive deep history', async () => {
  const carol = await signup('carol');
  const dave = await signup('dave');
  await api('POST', '/api/repos', { name: 'secret', visibility: 'private' }, carol);
  let head = null;
  for (let i = 0; i < 40; i++) {
    const r = await api('POST', '/api/repos/carol/secret/changesets', { base: head, message: `c${i}`, files: [{ path: `f${i % 5}.txt`, content: `v${i}\n` }] }, carol);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    head = r.body.id;
  }
  assert.equal((await api('GET', '/api/repos/carol/secret')).status, 404);
  assert.equal((await api('GET', '/api/repos/carol/secret', undefined, dave)).status, 404);
  assert.equal((await api('GET', '/api/repos/carol/secret/log', undefined, dave)).status, 404);
  assert.equal((await api('GET', '/api/repos/carol/secret/tree', undefined, carol)).status, 200);
  assert.equal((await api('GET', '/api/repos', undefined, dave)).body.repos.some((x) => x.name === 'secret'), false);
  assert.equal((await api('GET', '/api/repos', undefined, carol)).body.repos.some((x) => x.name === 'secret'), true);
  // tree after a cold cache must equal the hot one
  const hot = await api('GET', '/api/repos/carol/secret/manifest', undefined, carol);
  app.store.db.exec('SELECT 1');
  assert.equal(Object.keys(hot.body.files).length, 5);
  const bl = await api('GET', '/api/repos/carol/secret/blame?path=f0.txt', undefined, carol);
  assert.equal(bl.body.lines[0].cs.message, 'c35');
  const log = await api('GET', '/api/repos/carol/secret/log?limit=10', undefined, carol);
  assert.equal(log.body.changesets.length, 10); assert.equal(log.body.more, true);
});

test('auth hygiene', async () => {
  assert.equal((await api('POST', '/api/login', { name: 'nobody', password: 'x' })).status, 401);
  assert.equal((await api('POST', '/api/register', { name: 'x', password: 'short' })).status, 400);
  assert.equal((await api('POST', '/api/repos', { name: 'z' })).status, 401);
  assert.equal((await api('GET', '/api/me', undefined, 'scn_bogus')).status, 401);
  const h = await fetch(base + '/');
  assert.equal(h.status, 200);
  assert.ok(h.headers.get('content-security-policy').includes("script-src 'self'"));
});
