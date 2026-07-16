"use strict";
// commands/ai/ai.command.js — AI chat + prompt management

const { createAiEngine } = require('../../../aiEngine');

module.exports = {
    name: "ai",
    requiredRole: "USER",
    cooldown: 5,

    async handler({ ctx, args }) {
        const prompt = args.join(" ").trim();
        if (!prompt) return ctx.reply("Just ask me something.\nExample: /ai what is 2+2");
        try {
            const engine = createAiEngine(String(ctx.from.id));
            const response = await engine.complete({
                chatJid: `telegram:${ctx.chat.id}`,
                prompt,
                senderName: ctx.from.first_name || ctx.from.username || String(ctx.from.id),
                groupName: ctx.chat.type?.includes('group') ? ctx.chat.title : '',
                botName: 'Pappy',
                isGroup: ctx.chat.type?.includes('group') === true,
            });
            await ctx.reply(response);
        } catch (error) {
            const message = error.code === 'NOT_CONFIGURED'
                ? 'AI is not configured yet. Open AI settings and add a provider and model.'
                : `Could not reach AI: ${error.message}`;
            await ctx.reply(message);
        }
    },

    register(bot, deps) {
        const { getCustomPrompt, saveCustomPrompt, PROMPT_FILE, fsp } = deps;

        bot.action("cmd_ai_help", (ctx) => {
            ctx.answerCbQuery();
            ctx.editMessageText(
                "🧠 <b>OMEGA AI ASSISTANT</b>\n\nThe AI is connected. To use it, simply type:\n\n<code>/ai [Your prompt here]</code>\n\nExample: <code>/ai Write a high-converting promotional message for my crypto group</code>",
                { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Hub", callback_data: "menu_main" }]] } }
            ).catch(() => {});
        });

        bot.action("cmd_ai_prompt", async (ctx) => {
            ctx.answerCbQuery();
            const current = getCustomPrompt() || "(using default prompt)";
            const preview = current.length > 300 ? current.slice(0, 300) + "..." : current;
            ctx.editMessageText(
                `🧠 <b>AI PROMPT EDITOR</b>\n\n<b>Current prompt:</b>\n<code>${preview.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>\n\n<i>Send your new prompt as a message now.\nOr tap Reset to go back to default.</i>`,
                { parse_mode: "HTML", reply_markup: { inline_keyboard: [
                    [{ text: "🔄 Reset to Default", callback_data: "cmd_ai_prompt_reset" }],
                    [{ text: "🔙 Back to Hub", callback_data: "menu_main" }]
                ]}}
            ).catch(() => {});
            ctx.session = ctx.session || {};
            ctx.session.awaitingPrompt = true;
        });

        bot.action("cmd_ai_prompt_reset", async (ctx) => {
            ctx.answerCbQuery("Prompt reset.");
            try { await fsp.unlink(PROMPT_FILE); } catch { /* already gone */ }
            ctx.editMessageText("✅ <b>AI prompt reset to default.</b>", {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Hub", callback_data: "menu_main" }]] }
            }).catch(() => {});
        });
    },
};
