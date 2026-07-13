# Pappy Bot

A multi-session WhatsApp + Telegram automation bot ("Pappy V2 — Elite Multi-Session WhatsApp + Telegram Operator"). Owners pair WhatsApp numbers as independent "nodes" via a Telegram control bot; each node runs group moderation, media/utility commands, and sticker-triggered command binds.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — runs the bot (`node --expose-gc index.js`), health check on `PORT` at `/api/healthz`
- Boots cleanly with zero secrets configured: MongoDB, Telegram, and Redis all fail soft (warnings, no crash) when unconfigured — expect `[ioredis] Unhandled error event` log spam without a real Redis host, this is benign
- Env vars used (none set yet): `MONGO_URI`, `TG_BOT_TOKEN`, `OWNER_TG_ID`, `OWNER_WA_JID` (comma-separated phone numbers/JIDs — the fixed global owner), `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`, `OPENROUTER_API_KEY`
- WhatsApp session pairing happens via `/pair` in Telegram once `TG_BOT_TOKEN` is set — not yet configured; code-complete first per user preference

## Stack

- Plain CommonJS Node.js (no TypeScript, no build step) — source repo: `github.com/pappy999666-dotcom/verbose-fishstick`
- `@crysnovax/baileys` (WhatsApp), `telegraf` (Telegram), `mongoose` (MongoDB), `ioredis`/`bullmq` (queues), `sharp`, `youtubei.js`, `fluent-ffmpeg`

## Where things live

- `index.js` — boot sequence (health server → DB → Telegram → WhatsApp session restore)
- `core/whatsapp.js` — the real WA session monolith (`core/whatsapp/index.js` just re-exports it)
- `core/commandRouter.js` — single command dispatch pipeline; all owner/sudo permission checks delegate to `modules/permissionEngine.js`
- `core/anti/` — `antiEngine.js` (31-check pipeline) + `antiConfig.js` (its config, bridged live from pappy-admin's settings) + `antiHook.js` (wiring)
- `plugins/*.js` — one file per command group, auto-loaded by `commandRouter` at boot; `pappy-admin.js` (group moderation daemon), `pappy-core.js` (core commands incl. sticker binds & per-node sudo), `pappy-nodes.js` (owner-only node listing/relay)
- `modules/permissionEngine.js` — canonical role resolution (global_owner > node_owner > node_sudo > group_admin > public); node-scoped state never touches disk on the hot path
- `modules/waSocketRegistry.js` — lookup registry for active WA sockets by node/botId

## Architecture decisions

- **Strict node isolation** (explicit product requirement): only the fixed global owner (`config.ownerWhatsAppJids`) may act across WhatsApp nodes. Per-node sudo/owner grants never carry cross-node authority, even under the same Telegram account. See `.agents/memory/pappy-bot-node-isolation.md`.
- Renovation work follows the repo's own `Prompt-3-Master-Next-Generation.txt` plan, done incrementally — current scope is "Category A / Step 0" bug fixes only (sticker binds, anti-system bridge, node-sudo wiring + owner relay). Economy/shop, media downloaders, and the games suite are explicitly out of scope for now.
- Plan documents can describe a stale version of a fast-moving codebase — always verify claimed bugs against the real cloned source before patching (2 of the plan's 3 "bugs" turned out to be already-fixed or narrower than described). See `.agents/memory/pappy-bot-category-a-bugs.md`.

## Product

WhatsApp group moderation (anti-link/spam/bot/channel-broadcast/demote/status, plus an extended 31-check pipeline for media-type blocks, flood, badwords, etc.), sticker-triggered command shortcuts (`.bind`/`.binds`/`.unbind`), per-node sudo delegation, and global-owner tooling to list connected nodes and relay a command to a specific node (`.nodes`/`.nodeinfo`/`.relay`) without switching WhatsApp accounts.

## User preferences

- Renovate the existing bot in place (don't rewrite from scratch); follow the repo's own renovation plan doc.
- Finish and verify code changes before spending effort/tokens on live WhatsApp QR pairing.
- Category B (media/music downloaders, games) and the rest of Category A (economy, carousel shop) are deliberately deferred — ask before starting them.

## Gotchas

- Use `git clone` into `/tmp` to read/copy source from the renovation repo — `webFetch`'s markdown conversion mangles JS syntax and is not safe to copy from.
- `.replit-artifact/artifact.toml` in the source repo is identical to this workspace's `api-server` artifact — no toml changes needed when pulling in more of the source.
- Native deps (`sharp`, `@crysnovax/baileys`, `msgpackr-extract`, `protobufjs`) need `pnpm.onlyBuiltDependencies` in the root `package.json` or their install/build scripts get skipped silently.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `.agents/memory/` topic files for renovation-specific decisions (node isolation, bug-fix verification notes)
