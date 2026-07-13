---
name: Pappy Bot Category-A bug fixes — verified status
description: What the renovation plan claimed vs what the real code actually needed, for the 3 core bug fixes.
---

The renovation plan's "A-STEP 0" described 3 bugs. On reading the real cloned source (not the plan's
prose), 1 of the 3 was already fixed in the current code, and the other 2 were real but narrower than
described. Lesson: always verify a renovation plan's claims against the actual current source before
patching — specs describing an "old" version of a fast-moving codebase are easy to over-trust.

**Bug A (sticker binds don't fire) — already fixed in current code.** `core/whatsapp.js` already hashes
incoming `stickerMessage.fileSha256`, checks per-node cache (`global._stickerCmdsByNode`) falling back to
global (`global._stickerCmdsCache`), and rewrites the message as a synthetic `extendedTextMessage` that
flows through the normal command pipeline. Both per-node and global sticker-bind files are loaded at boot
and refreshed per-session. Only genuinely missing: `.binds` (list) and `.unbind` (reply-to-remove) commands
— added to `plugins/pappy-core.js`.

**Bug B (anti-system dead) — real, but only partially as described.** `plugins/pappy-admin.js`'s own inline
daemon already independently enforces its 6 flags (antilink/antibot/antispam/antichannel/antidemote/
antigstatus) — those were never actually dead. What WAS dead: `core/anti/antiConfig.js` (feeding the
separate 31-check `antiEngine.js` pipeline via `antiHook.js`) read from an always-nearly-empty
`data/anti-config.json`, so all of antiEngine's *extra* checks beyond pappy-admin's 6 (badword lists, media-
type blocks, flood, view-once, mention-all, platform blocks, domain allowlists, etc.) never triggered for
any group. Fixed by bridging `antiConfig.getAntiConfig(groupJid, botId)` / `hasAnyAntiEnabled(groupJid, botId)`
to read+translate pappy-admin's per-node `data/group_settings-{digits}.json` live (5s cache), and threading
`botId` through `antiEngine.processAntiChecks(ctx, botId)` and its `antiHook.js` call site.

**Bug C (no real node-sudo) — real, but the plumbing already existed; only the wiring was wrong.**
`modules/permissionEngine.js` already had `addNodeSudo`/`removeNodeSudo`/`ROLES.NODE_SUDO` correctly
implemented, and `modules/ownerManager.js` already had `addSudoForNode`/`removeSudoForNode` helpers that
delegate to it. The actual bug: `plugins/pappy-core.js`'s `.sudo`/`.delsudo` commands called the *global*
`ownerManager.addSudo`/`removeSudo` instead — which commandRouter's permission check deliberately ignores
for WhatsApp auth, making `.sudo` silently a no-op. Fixed by switching those two commands to the per-node
helpers. Also added `plugins/pappy-nodes.js` with `.nodes`/`.nodeinfo`/`.relay`, all gated to
`config.ownerWhatsAppJids` only (see node-isolation memory) — `.relay` works by emitting a synthetic
`message.upsert` event (with `fromMe: true` so commandRouter auto-recognizes owner) onto the target node's
own socket via `modules/waSocketRegistry.getByBotId(nodeDigits)`, reusing the exact same permission/execution
pipeline a real message would use instead of duplicating dispatch logic.
