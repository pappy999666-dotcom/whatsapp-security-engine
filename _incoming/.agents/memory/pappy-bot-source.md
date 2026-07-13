---
name: Pappy Bot renovation source
description: Where the real Pappy Bot source lives and how to safely pull it into the workspace.
---

The production WhatsApp+Telegram bot ("Pappy Bot") this project renovates lives in full at
`github.com/pappy999666-dotcom/verbose-fishstick` (public repo). It also contains
`Prompt-3-Master-Next-Generation.txt` — a renovation plan/spec written by the project owner.

**Do not use `webFetch` to read or copy source code from it.** webFetch's markdown conversion
escapes brackets/asterisks and mangles code — safe for skimming prose, not for extracting exact
JS. Always `git clone --depth 1` into `/tmp` and read/copy from the real files.

The repo's `.gitignore` excludes all session/secret files (`data/sessions/`, `data/sudo-users-*.json`,
`data/owner.json`, etc.), so a full clone is safe to import wholesale without leaking credentials.

It is a plain CommonJS Node project (no TypeScript, no build step) — `"dev": "node --expose-gc index.js"`.
Boots cleanly with zero configured secrets: `core/database.js`'s `connectDB()` no-ops with a warning if
`MONGO_URI` is unset (does not throw/block boot), Telegram launch failure is caught non-fatally, and
Redis/BullMQ connection errors are logged but don't crash the process — only surface as noisy
`[ioredis] Unhandled error event` spam in logs, which is expected/benign without a real Redis host.

Its own `.replit-artifact/artifact.toml` is byte-identical to a freshly-scaffolded `api-server` artifact
(same id, port 8080, `/api` path, `/api/healthz` health path) — no artifact.toml changes are needed when
importing this codebase into an artifact scaffold.
