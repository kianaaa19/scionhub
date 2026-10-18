'use strict';
// Line diff (Myers O(ND)) + unified hunks. No dependencies.

function splitLines(s) {
  if (s === '') return [];
  const l = s.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

function myers(A, B) {
  const N = A.length, M = B.length;
  if (N === 0) return B.map((_, j) => ['+', null, j]);
  if (M === 0) return A.map((_, i) => ['-', i, null]);
  const MAXD = Math.min(N + M, 1500);
  const off = MAXD + 1;
  let V = new Int32Array(2 * MAXD + 3);
  const trace = [];
  for (let d = 0; d <= MAXD; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) x = V[off + k + 1];
      else x = V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) return backtrack(trace, N, M, off);
    }
  }
  return null;
}

function backtrack(trace, N, M, off) {
  let x = N, y = M;
  const ops = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const V = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? k + 1 : k - 1;
    const prevX = V[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(['=', x - 1, y - 1]); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push(['+', null, y - 1]);
      else ops.push(['-', x - 1, null]);
    }
    x = prevX; y = prevY;
  }
  return ops.reverse();
}

// Returns ops: ['=' | '-' | '+', oldIndex|null, newIndex|null]
function diffOps(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb);
  let mid = myers(A, B);
  if (!mid) mid = [...A.map((_, i) => ['-', i, null]), ...B.map((_, j) => ['+', null, j])];
  const ops = [];
  for (let i = 0; i < s; i++) ops.push(['=', i, i]);
  for (const [t, i, j] of mid) ops.push([t, i === null ? null : i + s, j === null ? null : j + s]);
  for (let i = ea, j = eb; i < a.length; i++, j++) ops.push(['=', i, j]);
  return ops;
}

function hunks(a, b, ctx = 3) {
  const ops = diffOps(a, b);
  const changes = [];
  ops.forEach((o, i) => { if (o[0] !== '=') changes.push(i); });
  if (!changes.length) return { hunks: [], additions: 0, deletions: 0 };
  const ranges = [];
  for (const c of changes) {
    const lo = Math.max(0, c - ctx), hi = Math.min(ops.length - 1, c + ctx);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = hi; else ranges.push([lo, hi]);
  }
  const oldPos = [], newPos = [];
  let oi = 0, ni = 0;
  for (const o of ops) {
    oldPos.push(oi); newPos.push(ni);
    if (o[0] !== '+') oi++;
    if (o[0] !== '-') ni++;
  }
  let additions = 0, deletions = 0;
  for (const o of ops) { if (o[0] === '+') additions++; else if (o[0] === '-') deletions++; }
  const out = ranges.map(([lo, hi]) => {
    const lines = [];
    let oc = 0, nc = 0;
    for (let i = lo; i <= hi; i++) {
      const [t, ai, bi] = ops[i];
      if (t === '=') { lines.push({ t: ' ', text: a[ai] }); oc++; nc++; }
      else if (t === '-') { lines.push({ t: '-', text: a[ai] }); oc++; }
      else { lines.push({ t: '+', text: b[bi] }); nc++; }
    }
    return { header: `@@ -${oldPos[lo] + 1},${oc} +${newPos[lo] + 1},${nc} @@`, lines };
  });
  return { hunks: out, additions, deletions };
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

module.exports = { splitLines, diffOps, hunks, isBinary };
