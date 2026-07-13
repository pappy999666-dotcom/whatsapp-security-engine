# Pappy Bot Renovation — Continuation Prompt

Paste this into a new Replit Agent session (or hand to the next agent/dev) if the current
session runs out of tokens before the work below is finished.

## Project
"Pappy Bot" — a multi-session WhatsApp + Telegram automation bot. Real source lives at
`github.com/pappy999666-dotcom/verbose-fishstick` (clone with `git`, never trust webFetch's
markdown conversion for exact code — it mangles JS syntax). The repo's own renovation plan is
`Prompt-3-Master-Next-Generation.txt`.

**Scope decided with the user:** only "Category A / Step 0" — three specific bug fixes. NOT
in scope unless the user explicitly asks: the economy system, carousel shop (rest of Category A),
or Category B (media/game downloaders).

**Hard requirement — strict per-node isolation:** only the fixed global owner
(`config.ownerWhatsAppJids`, from `OWNER_WA_JID` env var) may act across WhatsApp "nodes"
(paired WA sessions/numbers). A per-node sudo or per-node owner must NEVER be able to reach or
control another node, even under the same Telegram account.

## Status: all 3 Category-A bugs are code-complete and verified as of this package

1. **Sticker `.bind` commands** — turned out to already work in current code (dispatch,
   per-node caching, boot loading were all fine — the plan described a stale/older version).
   Added the two genuinely missing pieces: `.binds` (list bound stickers) and `.unbind`
   (reply to a sticker to remove its bind) in `plugins/pappy-core.js`.
2. **Anti-system bridge** — real bug, confirmed: `core/anti/antiConfig.js` read from an
   always-empty `data/anti-config.json`, disconnected from what `plugins/pappy-admin.js`
   actually writes (`data/group_settings-{botId}.json`). Fixed by bridging `getAntiConfig`
   / `hasAnyAntiEnabled` to read+translate pappy-admin's per-node settings live (5s cache),
   and threading `botId` through `antiEngine.processAntiChecks(ctx, botId)` and its
   `antiHook.js` call site. `pappy-admin.js` was NOT modified (confirmed correct already).
3. **Node-sudo** — real bug: `.sudo`/`.delsudo` in `plugins/pappy-core.js` called the
   *global* `ownerManager.addSudo`/`removeSudo`, which `commandRouter`'s WhatsApp permission
   check deliberately ignores — making them silent no-ops. Fixed to call
   `ownerManager.addSudoForNode(botId, jid)` / `removeSudoForNode(botId, jid)` instead
   (per-node, matching `permissionEngine.js`'s existing node-scoped model). Also added
   `plugins/pappy-nodes.js` with owner-only `.nodes` (list connected sessions), `.nodeinfo`
   (stats for a node), and `.relay <nodeDigits> <command>` (run a command on another node —
   gated strictly to `config.ownerWhatsAppJids`, the only sanctioned cross-node path).

Verified: app boots cleanly with zero secrets configured (`pnpm --filter @workspace/api-server
run dev`), all plugin files pass `node -c` syntax checks, `core/commandRouter.js` loads 155
commands including `.nodes`/`.relay`/`.binds`/`.unbind`/`.sudo` with no load errors, and a
standalone script confirmed the anti-config bridge correctly reads a synthetic
`group_settings-{botId}.json` and produces the expected merged flags.

## What is NOT yet done (pick up here)

1. **Live verification is still pending** — everything above was verified by code tracing,
   syntax checks, and a targeted unit test of the anti-config bridge. None of it has been
   exercised against a real linked WhatsApp session yet, because the user deliberately
   deferred WhatsApp QR pairing (on a free trial, wants code finished first to conserve
   tokens/cost). Once the user is ready:
   - Set the `TG_BOT_TOKEN` and `OWNER_TG_ID` secrets (use the environment-secrets skill —
     request from the user, never invent/hardcode).
   - Set `OWNER_WA_JID` to the user's real WhatsApp number (digits or JID, comma-separated
     if multiple global owners).
   - Restart the `artifacts/api-server: API Server` workflow, use `/pair` in Telegram to
     link at least one WhatsApp number as a node.
   - Manually test: `.bind` a sticker to a command, confirm the sticker fires it; confirm
     `.binds` lists it and `.unbind` removes it. Toggle `.antilink`/`.antispam`/etc. via
     pappy-admin's commands and confirm antiEngine's extended checks (not just pappy-admin's
     own 6 inline checks) now respond. Test `.sudo`/`.delsudo` grant/revoke sudo that is
     visibly scoped to one node only. If a second node is paired, test `.nodes`, `.nodeinfo
     <digits>`, and `.relay <digits> <command>` end-to-end as the global owner, and confirm a
     non-global-owner (even a node-level owner/sudo) is refused by all three.
   - `MONGO_URI` is optional (bot runs DB-less with a warning) — only needed if the user wants
     persistent data across restarts for whatever features depend on it.
   - Redis (`REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`) is optional; without it, Bull-queue
     broadcast features are disabled and `[ioredis] Unhandled error event` warnings are
     expected/benign noise in the logs — not a bug, don't "fix" it unless the user asks for
     that functionality.

2. **Not started / explicitly out of scope unless the user asks:**
   - Category A economy system + carousel shop.
   - Category B media/game downloaders.
   - Any other item in `Prompt-3-Master-Next-Generation.txt` beyond the 3 bugs above.

3. **Housekeeping not yet done:**
   - No git commit/checkpoint description was written specifically calling out these 3 fixes
     (Replit's automatic checkpoints exist, but if the user wants a clean rollback point,
     consider suggesting one, or checking git history).
   - `replit.md` was already updated this session with an accurate project overview, stack,
     file map, architecture decisions, user preferences, and gotchas — read it first, it's
     more current than this prompt for anything not about the 3-bug status above.
   - `.agents/memory/` already has 3 topic files with durable lessons from this investigation
     (source-fetching quirk, node-isolation rule, and per-bug verified status vs the plan) —
     read `.agents/memory/MEMORY.md` first thing in a new session.

## Key gotchas learned during this work (see `.agents/memory/` for full detail)

- Always verify the renovation plan's bug claims against the actual cloned source before
  patching — 2 of the 3 "bugs" described were stale or narrower than the plan claimed.
- `webFetch` mangles JS code in markdown conversion — clone the repo with `git` to read/copy
  real source, never paste code extracted via webFetch.
- Root `package.json` needs `pnpm.onlyBuiltDependencies` listing `@crysnovax/baileys`,
  `msgpackr-extract`, `protobufjs`, `sharp` so `pnpm install` runs their native build scripts
  non-interactively (the interactive `pnpm approve-builds` prompt doesn't work in this shell).
- Any new cross-node feature must gate on `config.ownerWhatsAppJids` only — never on a
  per-node sudo/owner check — to preserve the isolation requirement.

---

## Round 2 (completed this session): link-preview fallback fix

**Scope decided with the user:** fix the Telegram↔WhatsApp chat-mode bridge "proper flow" for
commands, and fix a link-preview bug on `.gcast`/`.godcast` where, when triggered through
Telegram chat mode, messages posted with no preview card at all (plain text/link) — for both
WhatsApp group-invite links and regular URLs. Required behavior: primary = use an
existing/cached preview as-is; fallback = let Baileys auto-generate one (`richPreview:true`);
must not break `.gstatus`/`.ggstatus`, which already work correctly.

**Root cause found:** `core/gcstatus.js` (status-ring sender used by `.gstatus`/`.ggstatus`/
`.godcast`) already has a correct 3-tier flow — PATH 0 (relay existing preview as-is), PATH A
(media), PATH B (`richPreview:true` fallback when no manual preview exists but a URL is
present), PATH C (plain text, no URL). `core/bullEngine.js`'s separate "NORMAL CHAT BROADCAST"
branch (used by `.gcast`, which does NOT go through `gcstatus.js`) only had 2 tiers — cached/
sourced preview, then one network scrape via `buildLinkPreview` — and fell straight to bare
`{ text }` with no richPreview fallback if both failed. That's the confirmed bug.
`.godcast` was ruled innocent by a live extraction test across all ~15 template layouts
(`core/godcastTemplates.js` always leaves the URL as a clean, extractable substring) — it
inherits `gcstatus.js`'s already-correct PATH B, so if it appeared broken in the same test it
was very likely the same external network hiccup affecting the Tier-2 scrape, not a separate
bug. The Telegram chat-mode bridge/dispatch flow itself (`core/telegram.js`) was read in full
and found structurally sound — the user's "commands not heard right" complaint turned out to be
specifically about this missing preview, not a separate bridge bug.

**Fix applied:** added a Tier-3 fallback to `bullEngine.js`'s normal-broadcast branch —
`payload = { text: mutatedText, richPreview: true }` — used only when neither the
cached/sourced preview nor the Tier-2 network fetch produces a usable preview. Confirmed
`richPreview` is a generic Baileys `sendMessage` flag (not status-specific) by reading
`node_modules/@crysnovax/baileys/lib/Socket/messages-send.js`'s implementation directly.
`gcstatus.js`, `godcastTemplates.js`, `pappy-groupstatus.js`, and the `advanced_status` branch
in `bullEngine.js` were left untouched. Verified: `node -c` syntax check passes, workflow
restarts and boots cleanly with zero secrets configured.

**Not yet verified:** no live paired WhatsApp session was available this session, so the actual
network behavior (whether Baileys' own richPreview fetch succeeds against real URLs, and
especially against `chat.whatsapp.com` group-invite links, which some scrapers refuse) has not
been confirmed end-to-end. If invite-link previews are still missing after this fix once the
user tests live, look at using WhatsApp's dedicated `groupInvite` message type instead of a
generic text+richPreview payload for that specific case — `.gcast`'s invite-code path already
partially special-cases this.

---

## Round 3 (Fortress-Level Security Middleware — built this session; Truecaller module declined)

**Status: items 2–6 of the spec below are implemented, wired, and verified booting. Item 1
(Truecaller `.getdv`) was declined — see "Declined" note below.**

**What was built**, all namespaced under `fortress*`/`security*` so it can never collide with
the existing, working `.antilink`/`.antibot`/`.antispam` toggles in `pappy-admin.js` or the
31-check pipeline in `core/anti/antiEngine.js`:
- `core/security/deepLinkScan.js` — recursive protobuf string extraction (text, captions, poll
  options, list titles/descriptions/rows, buttons/template messages, view-once/ephemeral
  wrappers) + obfuscation-aware regex (spelled-out "dot", zero-width chars, spaced-out letters)
  + invite-link/shortener detection.
- `core/security/deviceIdentity.js` — `getDevice(msg.key.id)` (from `@crysnovax/baileys`,
  confirmed exported and working) + a presence-driven "instant bot" flag: a JID that starts
  `composing` with zero prior message history gets flagged, and its very next message is
  actioned near-instantly; a first-ever message from a web/desktop client with zero prior
  presence is also flagged.
- `core/security/variableInjector.js` — `$desc $pp $gcname $size $rsn $count $mention &num`
  token renderer, returns `{ text, mentions }` for WhatsApp `@mention` support.
- `core/security/securityConfig.js` — new, additive-only `data/security_config.json` store
  (fortressLink/Bot/Spam enable+action, global `actionToggle`, per-violation message templates,
  warn counts). Deliberately does not re-store any flag `pappy-admin.js`/`antiConfig.js` already
  own — this was the exact anti-pattern Round 1 fixed for the old anti-config file.
- `core/security/securityPipeline.js` — `SecurityMiddleware` / `FilterPipeline` (Identity →
  Link → Spam order; poll/list link hits surface through the same deep-link scan, labeled by
  source) / `DispatchAction` (kick/warn/delete, reuses warn-count + auto-kick-at-3 semantics
  matching `pappy-admin.js`'s existing `warnUser` behavior). Attaches to the existing
  `message.upsert` event bus (same bus `antiHook.js` and `commandRouter.js` already use) and a
  newly-added `presence.update` emission.
- `plugins/pappy-security.js` — new commands: `.fortress` (status table), `.fortresslink`,
  `.fortressbot`, `.fortressspam [1-60] [action]`, `.securitytoggle`, `.securitymsg <type>
  <template>`.
- `core/whatsapp.js` — added a `sock.ev.on('presence.update', ...)` listener (there was
  previously **zero** listener for this event anywhere in the codebase — confirmed by grep) that
  emits `presence.update` on the shared event bus for the security pipeline to consume.
- `index.js` — wired `securityConfig.init()` + `securityPipeline.init()` alongside the existing
  `antiConfig.init()` / `startAntiHook()` calls.

**Verified:** `node -c` on all new/changed files passes; workflow restarts cleanly; command
router loads all 161 commands including the 6 new fortress commands; existing `.antilink`/
`.antibot`/`.antispam` are unaffected. **Not yet verified live** (no paired WhatsApp session
available this session): actual trigger behavior against a real group with real poll/list
messages and real presence events. Test live before relying on it in production, especially the
presence-based "instant bot" flag, which is a best-effort heuristic (WhatsApp's protocol gives
no way to truly block a message before delivery — see the practical note further down, still
accurate).

**Declined — the Truecaller `.getdv` module (item 1) was not built.** The user's provided Flask
microservice source authenticates against Truecaller's private, non-public search endpoint using
an auth token described as "captured via a patched Truecaller APK" — i.e. reverse-engineered
credentials against a private API, used to pull other people's private PII (fraud status,
address, gender) without their consent. That was declined as built-in bot functionality. Offer
stands: wire up a legitimate/licensed phone-lookup API instead if the user wants this feature and
provides one.

Full spec as given by the user, verbatim (kept for reference — item 1 not implemented, items
2–6 implemented as described above with the practical adaptations noted):

> # System Prompt for "Fortress-Level" WhatsApp Security Middleware
>
> **Role:** You are a Lead Software Architect specializing in the Baileys framework and
> WhatsApp protocol internals. Your task is to generate a comprehensive, modular, and
> "Fortress-Level" Security Engine for a WhatsApp bot.
>
> **Core Objective:** Create a high-performance, non-blocking SecurityPipeline that intercepts
> all incoming events (`messages.upsert`, `presence.update`, `group-participants.update`) and
> applies multi-layered, deep-packet inspection before any command is executed.
>
> ### 1. The "Truecaller Intelligence" Module (`.getdv`)
> - **Requirement:** Integrate the bot with an external API (the user's Flask Truecaller
>   microservice).
> - **Implementation:**
>   - Create a `LookupService` module.
>   - Command `.getdv` must:
>     1. Extract the number from the quoted message or tagged user.
>     2. Fetch the WhatsApp profile picture using `sock.profilePictureUrl`.
>     3. Call the provided Truecaller API endpoint to get: `name`, `carrier`, `fraud_status`,
>        `city`, `gender`.
>     4. Return a formatted, professional "User Intel" card (including the profile picture URL
>        and all metadata).
>   - If the user has no Truecaller data, return "No Intel Found."
>
> ### 2. "Deep" AntiLink (No Bypass Allowed)
> - **Logic:** Standard regex is insufficient. You must implement **Recursive Protobuf
>   Inspection**.
> - **Deep Inspection:**
>   - Check `extendedTextMessage` (standard).
>   - Check `pollCreationMessage` (search within `optionName` or `title`).
>   - Check `listMessage` (search within `description` or `title`).
>   - Check `viewOnceMessage` or any hidden context.
> - **Obfuscation Handling:** The regex must detect hidden dots (e.g., "site dot com"),
>   character spacing, and common shortener patterns, even if the protocol flag tries to hide
>   the link.
> - **Action:** If a link is found, execute the user-configured action (Warn/Kick/Delete).
>
> ### 3. "Deep" Antibot (Identity & Behavioral)
> - **Identity Check:** Use `getDevice(msg.key.id)`. Any client that is web or desktop and does
>   not have the "Human-Interaction" flag (like typing presence or previous history) is marked
>   as `IsBotClient`.
> - **Presence Enforcement:**
>   - Monitor `presence.update`.
>   - If a JID is not in the contact list AND the presence is `composing`, trigger an immediate
>     block *before* the message hits the pipeline.
>   - If a message is received from a non-contact that didn't trigger a composing event,
>     consider it an "Instant Bot" and flag/kick immediately.
>
> ### 4. Advanced Antispam Engine
> - **Smart Velocity:** Only triggers if the sender is identified as an `IsBotClient`.
> - **Configurable:** `.antispam [seconds] [action]` (1-60s range).
> - **Logic:** Use a `Map<JID, number>` to store `lastMessageTime`. If a subsequent message
>   from the same ID arrives within the X seconds window, execute the action.
>
> ### 5. Variable Injection Engine (Dynamic Message Construction)
> - **Parser:** Must support recursive replacement of the following tokens in any action
>   message: `$desc` (GC Description), `$pp` (Profile URL), `$gcname` (GC Name), `$size`
>   (Member count), `$rsn` (Violation Reason), `$count` (Warn count), `$mention` (Tag), `&num`
>   (Phone Number).
> - **Toggle:** Global `ActionToggle` (on/off). If off, no messages are sent, just internal
>   logging.
>
> ### 6. Pipeline Architecture
> - **Class Structure:**
>   1. `SecurityMiddleware`: The entry point.
>   2. `FilterPipeline`: Runs checks in order (Presence -> Identity -> Link -> Spam -> Poll).
>   3. `DispatchAction`: Executes the kick, warn, delete based on the filter result.
> - **Concurrency:** Use async/await for every check. No blocking the event loop.
> - **Persistence:** Use a JSON-based file store (`security_config.json`) for per-group
>   settings.
>
> ### Output Code Requirements
> - Use TypeScript.
> - Include clean, documented helper functions.
> - Include the `TruecallerService` fetch logic (using axios or node-fetch).
> - Handle errors gracefully (e.g., if the Truecaller API is down, don't crash the bot, just
>   notify the user).

**Practical notes for whoever picks this up:**
- The rest of the codebase is plain JavaScript (CommonJS, `require`/`module.exports`), not
  TypeScript — decide with the user whether to introduce a TS subsystem (would need its own
  build step wired into the existing `pnpm --filter @workspace/api-server run dev` workflow)
  or port the spec's intent to JS to match the existing codebase convention. Don't silently
  pick one without flagging the tradeoff — this is an architectural decision, not a detail.
- `.getdv` needs the Flask Truecaller microservice's base URL and any auth token as a secret —
  ask the user for it via the environment-secrets flow; do not hardcode a URL or invent one.
- "Presence-based instant block before the message hits the pipeline" needs care: Baileys'
  `presence.update` and `messages.upsert` are separate, asynchronously-ordered socket events —
  there is no guaranteed ordering that lets you truly intercept a message before it arrives
  based on a prior presence event. Confirm with the user whether "block before pipeline" really
  means "flag the JID so the very next message from it is instantly actioned" (feasible) versus
  literally preventing message delivery (not possible over the WhatsApp protocol).
- This is a large enough feature that it likely deserves its own scoping conversation
  (dependencies, config-file reconciliation, TypeScript-vs-JS decision) before implementation
  starts, per this repo's `project-tasks` planning workflow if the user wants it tracked as a
  formal task.
