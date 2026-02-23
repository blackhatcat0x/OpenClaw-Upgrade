# Browser Automation – Sanity Checks & Hardening

This document covers the E2E smoke test, how to run it, and a brief summary
of the infrastructure hardening shipped alongside it.

## Running the smoke test

```bash
# Run only the browser smoke suite
pnpm e2e:twitter-smoke

# Or include it as part of the full E2E suite
pnpm test:e2e
```

The test lives at `test/browser.smoke.e2e.test.ts`.  It uses the existing
mock browser harness (`src/browser/server.control-server.test-harness.ts`) so
**no real browser or API keys are required** – it runs in CI out of the box.

### What the smoke test verifies

| Step | What is checked |
|------|-----------------|
| Browser server starts | `/status` returns `{ ok: true }` |
| Navigation | `POST /navigate` returns `{ ok: true, targetId }` |
| Snapshot | `GET /snapshot?format=ai` returns a snapshot |
| Act (like) | `POST /act` click returns `{ ok: true }` |
| No loop | Each Playwright mock called **exactly once** |
| Activity bound | Total operations **≤ 5** |

The "activity feed ≤ 5" assertion is the key loop-guard: if the agent ever
retries blindly, the operation count climbs above 5 and the test fails.

### Extending for a live browser

Set `OPENCLAW_LIVE_TEST=1` and point the harness at a real CDP endpoint to
promote the test to a full live run:

```bash
OPENCLAW_LIVE_TEST=1 OPENCLAW_CDP_URL=http://localhost:9222 pnpm e2e:twitter-smoke
```

---

## Upgrades shipped in this PR

### SQLite concurrency hardening

- **`src/memory/manager-sync-ops.ts`** – `openDatabaseAtPath` now sets
  `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout=5000` on every
  write-side database.  WAL lets readers and writers proceed concurrently,
  eliminating "database is locked" errors under multi-agent runs.
- **`src/memory/qmd-manager.ts`** – the read-only QMD database's
  `busy_timeout` was raised from 1 ms to 50 ms.  With WAL on the writer,
  contention is rare; the small headroom handles short checkpoint pauses
  without blocking the caller.

### Browser context resilience

- **`src/browser/pw-session.ts`** – exported `isPlaywrightContextError(err)`
  classifies the common Playwright "page / context / browser is closed" error
  family.  Callers use this to decide whether to retry an action after the
  browser reconnects, rather than propagating an unhelpful stack trace.

### Stronger element locator strategy

- **`src/browser/pw-role-snapshot.ts`** – `RoleRef` gains three optional
  fallback fields: `testId`, `ariaLabel`, `selector`.
- **`src/browser/pw-session.ts`** – `refLocator` chains `.or()` fallbacks in
  priority order (testId → ariaLabel → selector) when those fields are
  populated.  The primary role+name strategy is unchanged; fallbacks only
  activate when the element's accessible name is dynamic or absent.

### Memory search caps

- **`src/memory/manager.ts`** – search results are now deduplicated by
  content hash and capped at 10 000 total characters across all snippets
  (≈ 2 500 tokens).  This prevents context bloat when many memory entries
  match and stops self-reinforcing recall loops from repeating the same
  snippet on every step.
