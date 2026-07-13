#!/usr/bin/env bash
# apply-patches.sh — Re-applies patched Baileys files after npm install
# Run automatically via postinstall, or manually: bash patches/apply-patches.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BAILEYS_LIB="$SCRIPT_DIR/../node_modules/@crysnovax/baileys/lib"

if [ ! -d "$BAILEYS_LIB" ]; then
  echo "⚠  Baileys not installed yet — skipping patches (run npm install first)"
  exit 0
fi

echo "🔧 Applying Pappy patches to @crysnovax/baileys..."

cp "$SCRIPT_DIR/baileys/Socket/messages-send.js"       "$BAILEYS_LIB/Socket/messages-send.js"
cp "$SCRIPT_DIR/baileys/Utils/messages-media.js"       "$BAILEYS_LIB/Utils/messages-media.js"
cp "$SCRIPT_DIR/baileys/Utils/messages.js"             "$BAILEYS_LIB/Utils/messages.js"
cp "$SCRIPT_DIR/baileys/Utils/rich-message-utils.js"   "$BAILEYS_LIB/Utils/rich-message-utils.js"
cp "$SCRIPT_DIR/baileys/Defaults/index.js"             "$BAILEYS_LIB/Defaults/index.js"

echo "✅ Patches applied (messages-send.js, messages-media.js, messages.js, rich-message-utils.js, Defaults/index.js)"
