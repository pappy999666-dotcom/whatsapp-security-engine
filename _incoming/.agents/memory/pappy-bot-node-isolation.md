---
name: Pappy Bot node isolation
description: The non-negotiable cross-node authority rule for this bot's WhatsApp permission system.
---

Explicit product requirement: no WhatsApp "node" (a paired WA session/number) may contact or control
another node — not even a per-node sudo or per-node owner paired under the same Telegram account. The
**only** entity allowed to act across node boundaries is the fixed global owner, identified by
`config.ownerWhatsAppJids` (built from the `OWNER_WA_JID` env var).

**Why:** stated explicitly by the project owner — per-node privilege must never become cross-node
privilege, even by accident. `modules/permissionEngine.js` already encodes this correctly: global owner
role is checked independent of botId, while `node_owner`/`node_sudo` roles are always resolved scoped to
a specific `botId`, and node-sudo storage is one file per node (`data/sudo-users-{digits}.json`).

**How to apply:** any new cross-node feature (e.g. a relay/broadcast command) must gate on global-owner
identity only (`config.ownerWhatsAppJids`), never on a per-node sudo/owner check, even if that per-node
principal happens to also administer other nodes via Telegram. When fixing or extending sudo-related
commands, always route "grant on this node" writes through `permissionEngine.addNodeSudo(botId, jid)` /
`ownerManager.addSudoForNode(botId, jid)` — never through the legacy global `ownerManager.addSudo(jid)`,
which commandRouter's permission check deliberately ignores for WhatsApp auth.
