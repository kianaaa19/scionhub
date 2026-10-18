# ScionHub

Code hosting for **Scion-style source control**: a server-centric VCS for always-online clients such as agents and CI.
ScionHub is to Scion what GitHub is to git. It is a self-contained hub with a web UI, an HTTP API and an `scn` CLI.

Design source: [Redesigning source control at Anthropic](https://www.anthropic.com/engineering/redesigning-source-control).
This is an independent implementation of those principles, not Anthropic's internal system.

## Features

| Area | What you get |
|---|---|
| Repos | Public/private repositories, owners, descriptions, README rendering |
| Source control | Server-side commits, one authoritative `main` ref moved by compare-and-swap, automatic server-side rebase when paths are disjoint, conflict reports otherwise |
| Storage | Content-addressed, deduplicated, gzip-compressed blobs; changesets store only changed files |
| Derived data | Tree checkpoints, mainline index, path history; powers log, per-directory "last change", and blame |
| Review | Change requests (proposals from any signed-in user), diffs, discussion, land/close |
| Web UI | Browse, history, blame, diff, edit/create/delete files, search, tokens, settings |
| CLI | `scn clone --sparse`, `status`, `pull`, `commit [--propose]`, `log`, `blame` |
| API | Everything the UI does, plus manifest, immutable blob fetch, merge-base |
| Ops | Zero npm dependencies, SQLite (WAL), Docker image, health check, rate limiting, CSP |

## Run it

Requires Node 22.13+ (uses the built-in `node:sqlite`).

```bash
npm start                      # http://localhost:3000, data in ./data
```

Docker:

```bash
docker compose up -d --build   # data persists in the scionhub-data volume
```

Plain image:

```bash
docker build -t scionhub .
docker run -d -p 3000:3000 -v scionhub-data:/data scionhub
```

### Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite database location. **Mount a persistent volume here.** |
| `ALLOW_REGISTRATION` | `1` | Set `0` to close signups after creating accounts |
| `COOKIE_SECURE` | `0` | Set `1` when served over HTTPS |
| `TRUST_PROXY` | `0` | Set `1` behind a reverse proxy so rate limits use `X-Forwarded-For` |
| `MAX_BODY_MB` | `64` | Maximum request body (a commit is one request) |

### Production checklist

1. Put it behind HTTPS (Caddy, nginx, Traefik, or your platform's load balancer) and set `COOKIE_SECURE=1` and `TRUST_PROXY=1`.
2. Run **one instance** with a persistent volume at `DATA_DIR`. SQLite is single-writer; scale vertically.
3. Create your accounts, then set `ALLOW_REGISTRATION=0`.
4. Back up `DATA_DIR` (`scionhub.db`, plus the `-wal`/`-shm` files while running; or use `sqlite3 scionhub.db ".backup out.db"`).
5. Health check: `GET /healthz`.

Example Caddyfile:

```
hub.example.com {
  request_body { max_size 70MB }
  reverse_proxy localhost:3000
}
```

Platforms like Fly.io, Railway, Render, or any VM work. Use the Dockerfile, expose port 3000, attach a volume at `/data`.

## Using the CLI

```bash
curl -o scn https://hub.example.com/scn && chmod +x scn   # or run bin/scn.js directly
./scn login hub.example.com <token>                       # create a token in Settings
./scn clone hub.example.com/alice/monorepo --sparse services/api docs
cd monorepo
./scn status
./scn commit -m "Fix retry logic"             # owners: lands on main, server-side
./scn commit -m "Fix retry logic" --propose   # everyone else: opens a change request
./scn log services/api; ./scn blame services/api/main.py; ./scn pull
```

`commit` sends only changed files. If main moved on disjoint paths, the server rebases your change and the CLI
pulls the result. If you changed a path someone else also changed, the server returns the conflicting paths.
File modes and symlinks are not tracked.

## API

Authenticate with `Authorization: Bearer <token>` (tokens from Settings). Selected endpoints under `/api/repos/:owner/:repo`:

| Endpoint | Purpose |
|---|---|
| `GET /tree?ref=&path=` | Directory listing with last change per entry |
| `GET /manifest?ref=&prefix=` | Flat `path → {hash,size}` map for sparse checkouts |
| `GET /blob/:hash` | Immutable content, cacheable forever |
| `GET /log?path=&before=&limit=` | Mainline history |
| `GET /changesets/:id?diff=1` | Changeset with diff |
| `GET /blame?path=&ref=` | Server-computed blame |
| `GET /merge-base?a=&b=` | Common ancestor |
| `GET /search?q=` | Path and content search |
| `POST /changesets` | `{message, base, files:[{path, content\|content_b64\|delete}], mode:"main"\|"propose"}` |
| `GET /crs`, `GET /crs/:n`, `POST /crs/:n/land`, `/close`, `/comments` | Change requests |

`ref` is `main`, a full changeset id, or a unique prefix of at least 8 hex characters.

## Architecture

```
 browser / scn / agents ──HTTP──▶ src/server.js ──▶ src/store.js ──▶ SQLite
                                   auth, routing        VCS core        users, repos, blobs,
                                   CSRF, rate limit     changesets,     changesets, mainline,
                                                        derived data    path_history, checkpoints
```

* **Changeset**: `{id, parent, depth, author, message, ts, files:[{p, h, s}]}` where `h` is a blob hash or `null` for deletes.
* **Main ref**: `repos.head` updated with `UPDATE … WHERE head IS ?` (compare-and-swap) inside an immediate transaction.
* **Mainline index**: append-only `depth → changeset`, which makes history O(page) and gives cheap "is this on main" checks.
* **Trees**: materialized from changesets on demand, with a checkpoint every 16 changesets and an in-memory LRU. Clients never see this, so it can change freely.
* **Landing**: a change request based on an older main is rebased onto the current head if no touched path changed on main since its base (or main already has identical content). Otherwise the conflicting paths are returned.
* **Access control**: blobs are only readable through repos that reference them. Private repos return 404 to non-owners.

Scaling notes: this is a single-node implementation. The interfaces (immutable content-addressed blobs, a single CAS ref, derived data
recomputable from changesets) are the ones that let Scion scale horizontally, so the SQLite store could be swapped for a distributed one.

## Security notes

* Passwords hashed with scrypt; sessions are HttpOnly SameSite=Lax cookies; API tokens are stored as SHA-256 hashes.
* Cookie-authenticated writes require `X-Requested-With: scionhub` (CSRF defense); Bearer-token calls are unaffected.
* Strict CSP (`script-src 'self'`); the UI builds DOM with `textContent` only, so file contents and names cannot inject markup.
* Login and registration are rate limited per IP. Paths are validated (no `..`, no `.scn`, no file/dir collisions).
* No email verification, password reset, or 2FA yet: appropriate for a team/self-hosted instance with registration closed.

## Develop

```bash
npm test     # API + CLI end-to-end tests (node:test)
```

## Limitations

Single node; no branches (by design); no merge of overlapping edits in the same file (conflict reported); no file modes or symlinks; web editor handles text files up to 1 MB.
