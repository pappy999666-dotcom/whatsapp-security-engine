"use strict";

const { panel } = require("../../ui");

module.exports = {
    name: "clearpreviewcache",
    aliases: ["clearlp", "flushpreview"],
    description: "Flush all link preview caches (lp:*, spc:*, ph:*) from Redis so fresh 1920px thumbnails are fetched",
    usage: "/clearpreviewcache",
    requiredRole: "ADMIN",
    cooldown: 10,

    handler: async ({ ctx, deps }) => {
        const msg = await ctx.reply(
            panel("🗑️ <b>Clearing Preview Cache</b>", ["Scanning Redis for preview keys..."]),
            { parse_mode: "HTML" }
        );

        try {
            const { connection: redis } = require("../../../services/redis");

            const prefixes = ["lp:*", "spc:*", "ph:*"];
            let total = 0;

            for (const pattern of prefixes) {
                const keys = await redis.keys(pattern);
                if (keys.length > 0) {
                    await redis.del(...keys);
                    total += keys.length;
                }
            }

            await ctx.telegram.editMessageText(
                ctx.chat.id, msg.message_id, undefined,
                panel("✅ <b>Preview Cache Cleared</b>", [
                    `Deleted <b>${total}</b> cached preview entr${total === 1 ? "y" : "ies"}.`,
                    "Next link status will fetch a fresh <b>1920px</b> thumbnail.",
                ]),
                { parse_mode: "HTML" }
            );
        } catch (err) {
            deps?.logger?.error?.("[ClearPreviewCache] Failed", { error: err.message });
            await ctx.telegram.editMessageText(
                ctx.chat.id, msg.message_id, undefined,
                panel("❌ <b>Clear Failed</b>", [`Error: ${err.message}`]),
                { parse_mode: "HTML" }
            );
        }
    },
};
