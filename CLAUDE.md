# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server and CLI for logging food to Lose It!. Lose It publishes no public API,
so this drives the private GWT-RPC endpoint behind their web app. It can break whenever
they ship a new web build — see "When Lose It ships a new build" below.

## Commands

```console
uv sync                                   # install, including dev group
uv run ruff check src tests               # lint
uv run pytest                             # full suite (~485 tests, ~2s)
uv run pytest tests/test_sealed.py        # one file
uv run pytest -k test_name                # one test
uv run pytest --cov=loseit_mcp --cov-report=term-missing
```

The CLI is the fastest way to exercise a change against the real API:

```console
uv run loseit-mcp search "greek yogurt" -n 5
uv run loseit-mcp diary 2026-07-25
uv run loseit-mcp log <food_id> -m lunch -a 120 -u g --dry-run
uv run loseit-mcp serve                   # stdio (default)
uv run loseit-mcp serve --transport streamable-http --port 8000
```

Credentials come from `.env` (gitignored). `--dry-run` previews log math; `--json`
gives machine-readable output.

## Architecture

The layers matter more than the file list, because behaviour is spread across them:

- **`config.py`** holds `DEFAULT_STRONG_NAME` and `DEFAULT_POLICY_HASH`, which are tied
  to whichever web build Lose It currently runs. Settings resolve CLI flags → environment
  → `.env` → JSON config → defaults.
- **`auth.py`** adds email/password login on top of the [`phitoduck/lose-it`](https://github.com/phitoduck/lose-it)
  SDK, which only accepts a JWT you supply yourself. Session tokens cache to
  `~/.config/loseit-mcp/session.json` when `persist_session` is set.
- **`service.py`** is the domain layer — all Lose It operations, including the
  custom-food path and the weight recording captured from the web app's weigh-in widget.
- **`server.py`** exposes the service as MCP tools; **`cli.py`** exposes the same
  operations as commands *and* wires the HTTP server together.

`cli.py::_run_serve` is the place to understand the hosted stack. It composes, outermost
first: `ThrottleMiddleware` → `PathTokenMiddleware` → the MCP library's Starlette app.

### Multi-tenancy

In `LOSEIT_MULTI_TENANT` mode the process holds no credentials; each request carries its
own. `tenancy.py` resolves them from `Authorization`/`X-LoseIt-*` headers, or from a
sealed URL token. `tokencache.py` is in-memory only, and sessions resolve with
`persist_session=False`, so multi-tenant serving writes nothing to disk.

### Credential URLs

`sealed.py` encrypts credentials into a URL path; `enroll.py` mints them (verifying
against Lose It first, so a typo fails immediately); `webapp.py::PathTokenMiddleware`
strips `/u/<sealed>` off the path and stashes the token in a `ContextVar` that
`tenancy.py` later reads. There is no database and no account system —
`LOSEIT_URL_SECRET` is the only durable secret, and rotating it is the *only* revocation
mechanism, invalidating every URL ever issued.

### Throttling

`throttle.py` checks two independent buckets per request: one per client address, one per
credential. An address alone is a weak identity behind NAT, hence both.

## Deployment gotchas

Two targets: Azure App Service (`DEPLOYMENT.md`) and Cloudflare Workers + Containers
(`cloudflare/`, deployed by `.github/workflows/deploy-cloudflare.yml`). These bit us, and
are not obvious from reading any single file:

- **`LOSEIT_ALLOWED_HOSTS` must match the Host the app actually receives.** It defaults
  to localhost-only, and a mismatch makes every `/mcp` request `421 Invalid Host header`
  while `/`, `/enroll` and `/healthz` keep answering normally — those routes bypass the
  MCP library's transport-security middleware. **A green `/healthz` proves nothing about
  `/mcp`.** Test both.
- **`throttle.py` reads `X-Forwarded-For` and nothing else** — not `CF-Connecting-IP`,
  not `X-Real-IP`. A proxy that doesn't set it collapses every caller into one bucket.
  It counts hops from the *right*, per `LOSEIT_TRUSTED_PROXIES`.
- **Enrollment URLs are built per request** from `X-Forwarded-Proto`/`X-Forwarded-Host`
  (`enroll.py::_public_base_url`), not from `LOSEIT_PUBLIC_URL` — which only names where
  to re-enroll in an expiry message. A proxy that omits them mints `http://` URLs.
- **`LOSEIT_ENROLL_SECRET` makes enrollment CLI-only.** It's checked as an
  `x-enroll-secret` header, which the browser page at `/` cannot send.

### Cloudflare specifics

- The wrapper lives in `cloudflare/` **because Wrangler reads a `.env` sitting next to its
  config**, and this repo keeps real credentials in the root `.env`. Its
  `image_build_context` points one level up so the root `Dockerfile` is used unmodified.
- Containers require the **Workers Paid** plan. A CI API token needs **`Containers:Edit`**,
  which is a *separate* permission group from `Cloudchamber:Edit` — having only the latter
  fails at `/accounts/<id>/containers/me`. Permission changes take a few minutes to
  propagate.
- **`wrangler dev` rewrites the request URL and `Host` to the configured custom domain**,
  whatever the client sent, so host-allowlist rejection cannot be reproduced locally.
- **Container deploys roll out gradually** — the old instance keeps serving until it
  cycles. `/healthz` reports the commit stamped via `image_vars`, which is the only
  reliable signal that a new build is live; the deploy workflow polls for it.
- Cloudflare's WAF 403s some automated user agents (`Python-urllib` among them) before
  they reach the app. Real MCP clients are unaffected.

## When Lose It ships a new build

RPCs start failing. Refresh `DEFAULT_STRONG_NAME` and `DEFAULT_POLICY_HASH` in
`config.py` (or override via `LOSEIT_STRONG_NAME` / `LOSEIT_POLICY_HASH`). `errors.py`
exists so tools explain what broke and what the operator must refresh, rather than
surfacing a decoder traceback — keep new failure paths in that style.

## Releasing

Bump the patch on every deploy. The version lives in **two** places that must agree:
`src/loseit_mcp/__init__.py` (`__version__`, what `/healthz` reports) and
`pyproject.toml`. Then lint, test, commit, and tag — see `RELEASING.md`.

## Notes that affect tool behaviour

- `saturated_fat_g` is **not** recorded; the SDK's payload builder filters that ordinal
  out, so `log_custom_food` reports it under `ignored_nutrients` rather than claiming to
  have logged it.
- Relative dates (`today`/`yesterday`) resolve in the *account's* timezone, not the host's.
- Weight history is fetched in windows and bisected when a response is too large for the
  SDK decoder; an unchunked year-long query silently returns "no weigh-ins".
- Weights carry no unit over the wire — the number means whatever the account displays.
