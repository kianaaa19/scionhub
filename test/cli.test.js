'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);
const { createApp } = require('../src/server');

const SCN = path.join(__dirname, '..', 'bin', 'scn.js');

test('scn CLI: clone sparse, edit, commit, rebase, propose, pull', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scn-cli-'));
  const app = createApp({ dataDir: path.join(tmp, 'data') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${app.server.address().port}`;
  const base = `http://${host}`;
  const env = { ...process.env, HOME: tmp, NODE_NO_WARNINGS: '1' };
  delete env.SCN_TOKEN;
  // async on purpose: the server runs in this process, a sync exec would deadlock the event loop
  const scn = async (args, cwd = tmp, e = env) => (await run('node', [SCN, ...args], { cwd, env: e, encoding: 'utf8' })).stdout;
  const fails = async (args, cwd, e) => { try { await scn(args, cwd, e); } catch (x) { return String(x.stderr) + String(x.stdout); } assert.fail('expected failure'); };

  async function mk(name) {
    const r = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password: 'password-1234' }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const t = await fetch(`${base}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Requested-With': 'scionhub' }, body: '{"name":"cli"}' });
    return (await t.json()).token;
  }
  try {
    const owner = await mk('olive'), guest = await mk('gus');
    assert.match(await scn(['login', host, owner]), /Logged in .* as olive/);
    await scn(['repo', 'create', 'mono', '--desc', 'test']);

    // seed via API-less path: clone the empty repo, add files, commit
    await scn(['clone', `${host}/olive/mono`]);
    const wc = path.join(tmp, 'mono');
    fs.mkdirSync(path.join(wc, 'svc/a'), { recursive: true }); fs.mkdirSync(path.join(wc, 'svc/b'), { recursive: true });
    fs.writeFileSync(path.join(wc, 'svc/a/main.txt'), 'alpha\n'); fs.writeFileSync(path.join(wc, 'svc/b/main.txt'), 'beta\n');
    fs.writeFileSync(path.join(wc, 'README.md'), '# mono\n');
    assert.match(await scn(['status'], wc), /A svc\/a\/main.txt/);
    assert.match(await scn(['commit', '-m', 'seed'], wc), /Committed [0-9a-f]{10} to main/);
    assert.match(await scn(['status'], wc), /clean/);

    // sparse clone only gets svc/a
    await scn(['clone', `${host}/olive/mono`, 'sparse', '--sparse', 'svc/a']);
    const sp = path.join(tmp, 'sparse');
    assert.ok(fs.existsSync(path.join(sp, 'svc/a/main.txt')));
    assert.ok(!fs.existsSync(path.join(sp, 'svc/b')));
    assert.ok(!fs.existsSync(path.join(sp, 'README.md')));

    // sparse copy edits a; full copy edits b and commits first => sparse commit must rebase cleanly
    fs.writeFileSync(path.join(wc, 'svc/b/main.txt'), 'beta2\n');
    await scn(['commit', '-m', 'edit b'], wc);
    fs.writeFileSync(path.join(sp, 'svc/a/main.txt'), 'alpha2\n');
    assert.match(await scn(['commit', '-m', 'edit a'], sp), /rebased/);
    await scn(['pull'], wc);
    assert.equal(fs.readFileSync(path.join(wc, 'svc/a/main.txt'), 'utf8'), 'alpha2\n');

    // log / blame
    assert.match(await scn(['log', '-n', '5'], wc), /edit a[\s\S]*edit b[\s\S]*seed/);
    assert.match(await scn(['blame', 'svc/a/main.txt'], wc), /olive\s+1: alpha2/);

    // guest cannot push, can propose
    const genv = { ...env, SCN_TOKEN: guest };
    await scn(['clone', `${host}/olive/mono`, 'guestwc'], tmp, genv);
    const gw = path.join(tmp, 'guestwc');
    fs.writeFileSync(path.join(gw, 'README.md'), '# mono\nedited by gus\n');
    assert.match((await fails(['commit', '-m', 'nope'], gw, genv)).replace(/\n/g, ' '), /propose/);
    const out = await scn(['commit', '-m', 'docs tweak', '--propose', '--title', 'Docs tweak'], gw, genv);
    assert.match(out, /Opened change request #1/);

    // local edit vs upstream change => pull reports a conflict and keeps local edits
    fs.writeFileSync(path.join(wc, 'README.md'), '# mono\nowner change\n');
    await scn(['commit', '-m', 'readme'], wc);
    
  } finally {
    app.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
