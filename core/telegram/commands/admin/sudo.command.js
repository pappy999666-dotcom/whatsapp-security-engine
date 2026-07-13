"use strict";

module.exports = {
    name: "sudo",
    requiredRole: "SUDO",

    async handler({ ctx, args, deps }) {
        const { ownerManager, rbac } = deps;
        const sub = (args[0] || "").toLowerCase();
        const actorId = String(ctx.from?.id || '');
        const actorRole = rbac.getUserRole(actorId);

        if (sub === "add" || sub === "remove") {
            if (!rbac.hasRolePermission(actorRole, 'SUDO')) {
                return ctx.reply('⚠️ Only OWNER or Global Owners can modify the sudo list.', { parse_mode: 'HTML' });
            }
        }
        if (sub === "add") {
            const jid = args[1]?.replace(/[^0-9]/g, "");
            if (!jid) return ctx.reply("❌ Usage: /sudo add 2348012345678");
            await ownerManager.addSudo(`${jid}@s.whatsapp.net`);
            return ctx.reply(`✅ <b>Added Global Owner (WA):</b> <code>${jid}@s.whatsapp.net</code>`, { parse_mode: "HTML" });
        }
        if (sub === "remove") {
            const jid = args[1]?.replace(/[^0-9]/g, "");
            if (!jid) return ctx.reply("❌ Usage: /sudo remove 2348012345678");
            await ownerManager.removeSudo(`${jid}@s.whatsapp.net`);
            return ctx.reply(`✅ <b>Removed Global Owner (WA):</b> <code>${jid}@s.whatsapp.net</code>`, { parse_mode: "HTML" });
        }

        const owners = ownerManager.getOwners();
        const sudos  = ownerManager.getSudos();
        const ownerList = owners.length ? owners.map(j => `<code>${j}</code>`).join("\n") : "None";
        const sudoList  = sudos.length  ? sudos.map(j  => `<code>${j}</code>`).join("\n") : "None";
        return ctx.reply(
            `👑 <b>OWNER & GLOBAL OWNER LIST</b>\n\n🔑 <b>WA Node Owners:</b>\n${ownerList}\n\n🌐 <b>Global Owners (WA):</b>\n${sudoList}`,
            { parse_mode: "HTML" }
        );
    },

    register(bot, deps) {
        const { ownerManager, rbac } = deps;

        function renderSudoPanel(owners, sudos, canManage) {
            const ownerList = owners.length ? owners.map(j => `<code>${j}</code>`).join("\n") : "None";
            const sudoList  = sudos.length  ? sudos.map(j  => `<code>${j}</code>`).join("\n") : "None";
            const inline_keyboard = [];
            if (canManage) {
                inline_keyboard.push([
                    { text: "➕ Add Global Owner", callback_data: "sudo_add" },
                    { text: "➖ Remove Global Owner", callback_data: "sudo_remove" },
                ]);
                inline_keyboard.push([
                    { text: "👑 Assign WA Owner",  callback_data: "owner_add" },
                    { text: "🗑️ Remove WA Owner", callback_data: "owner_remove" },
                ]);
            }
            inline_keyboard.push([{ text: "🔙 Back to Hub", callback_data: "menu_main" }]);
            return {
                text: `👑 <b>OWNER & GLOBAL OWNER MANAGEMENT</b>\n\n🔑 <b>WA Node Owners:</b>\n${ownerList}\n\n🌐 <b>Global Owners (WA):</b>\n${sudoList}${canManage ? '' : '\n\n<i>Read-only view.</i>'}`,
                reply_markup: { inline_keyboard },
            };
        }

        bot.action("menu_sudo", async (ctx) => {
            ctx.answerCbQuery().catch(() => {});
            const role = rbac.getUserRole(String(ctx.from?.id || ''));
            const canManage = rbac.hasRolePermission(role, 'SUDO');
            const { text, reply_markup } = renderSudoPanel(ownerManager.getOwners(), ownerManager.getSudos(), canManage);
            ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(() => {});
        });

        bot.action("sudo_add", (ctx) => {
            ctx.answerCbQuery().catch(() => {});
            ctx.session = ctx.session || {};
            ctx.session.sudoAction = "add";
            ctx.editMessageText(
                "🌐 <b>ADD GLOBAL OWNER (WA)</b>\n\nSend the WhatsApp number:\n<i>Example: 2348012345678</i>\n\n<i>This user gets full owner access on all WA nodes.</i>",
                { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 Cancel", callback_data: "menu_sudo" }]] } }
            ).catch(() => {});
        });

        bot.action("sudo_remove", async (ctx) => {
            ctx.answerCbQuery().catch(() => {});
            const sudos = ownerManager.getSudos();
            if (!sudos.length) return ctx.editMessageText("⚠️ No global owners to remove.", {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "menu_sudo" }]] },
            }).catch(() => {});
            const buttons = sudos.map(j => [{ text: `🗑️ ${j}`, callback_data: `sudo_rm_${j}` }]);
            buttons.push([{ text: "🔙 Cancel", callback_data: "menu_sudo" }]);
            ctx.editMessageText("🌐 <b>REMOVE GLOBAL OWNER (WA)</b>\n\nSelect a user to remove:", {
                parse_mode: "HTML", reply_markup: { inline_keyboard: buttons },
            }).catch(() => {});
        });

        bot.action(/^sudo_rm_(.+)$/, async (ctx) => {
            ctx.answerCbQuery().catch(() => {});
            const role = rbac.getUserRole(String(ctx.from?.id || ''));
            if (!rbac.hasRolePermission(role, 'SUDO')) return ctx.answerCbQuery('⚠️ Access denied.').catch(() => {});
            const jid = ctx.match[1];
            await ownerManager.removeSudo(jid);
            ctx.answerCbQuery(`Removed ${jid}`).catch(() => {});
            const canManage = true;
            const { text, reply_markup } = renderSudoPanel(ownerManager.getOwners(), ownerManager.getSudos(), canManage);
            ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(() => {});
        });

        bot.action("owner_add", (ctx) => {
            ctx.answerCbQuery().catch(() => {});
            ctx.session = ctx.session || {};
            ctx.session.sudoAction = "owner_add";
            ctx.editMessageText(
                "👑 <b>ASSIGN WA NODE OWNER</b>\n\nSend the WhatsApp number:\n<i>Example: 2348012345678</i>",
                { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 Cancel", callback_data: "menu_sudo" }]] } }
            ).catch(() => {});
        });

        bot.action("owner_remove", async (ctx) => {
            ctx.answerCbQuery().catch(() => {});
            const owners = ownerManager.getOwners();
            if (!owners.length) return ctx.editMessageText("⚠️ No WA owners to remove.", {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "menu_sudo" }]] },
            }).catch(() => {});
            const buttons = owners.map(j => [{ text: `🗑️ ${j}`, callback_data: `owner_rm_${j}` }]);
            buttons.push([{ text: "🔙 Cancel", callback_data: "menu_sudo" }]);
            ctx.editMessageText("👑 <b>REMOVE WA NODE OWNER</b>\n\nSelect an owner to remove:", {
                parse_mode: "HTML", reply_markup: { inline_keyboard: buttons },
            }).catch(() => {});
        });

        bot.action(/^owner_rm_(.+)$/, async (ctx) => {
            const role = rbac.getUserRole(String(ctx.from?.id || ''));
            if (!rbac.hasRolePermission(role, 'SUDO')) return ctx.answerCbQuery('⚠️ Access denied.').catch(() => {});
            const jid = ctx.match[1];
            await ownerManager.removeOwner(jid);
            ctx.answerCbQuery(`Removed ${jid}`).catch(() => {});
            const { text, reply_markup } = renderSudoPanel(ownerManager.getOwners(), ownerManager.getSudos(), true);
            ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(() => {});
        });
    },
};
