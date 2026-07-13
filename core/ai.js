'use strict';
// core/ai.js

const axios  = require('axios');
const path   = require('path');
const fs     = require('fs');
const logger = require('./logger');
const { getMemory, updateMemory, getUserContext } = require('./ai.memory');

const QWEN_API_KEY  = process.env.QWEN_API_KEY;
const QWEN_ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const QWEN_MODELS   = ['qwen-plus', 'qwen-turbo', 'qwen-max'];
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VISION_MODEL  = 'qwen-vl-max';
const AUDIO_MODEL   = 'qwen-omni-turbo';

const AI_PROVIDER_MODELS = {
    alibaba: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    openrouter: [
        'openai/gpt-4o-mini',
        'anthropic/claude-3.5-sonnet',
        'deepseek/deepseek-chat-v3-0324:free',
    ],
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    chatgpt: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    nvidia: ['meta/llama-3.1-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    claude: ['claude-3-5-sonnet-latest', 'claude-3-7-sonnet-latest'],
    awsbedrock: ['anthropic.claude-3-5-sonnet-20240620-v1:0'],
    digitalocean: [
        'llama3.3-70b-instruct',
        'alibaba-qwen3-32b',
        'deepseek-r1-distill-llama-70b',
        'nvidia-nemotron-3-super-120b',
    ],
};

const DEFAULT_PROVIDER = 'digitalocean';

function normalizeProvider(provider) {
    const p = String(provider || '').trim().toLowerCase();
    return AI_PROVIDER_MODELS[p] ? p : DEFAULT_PROVIDER;
}

function getDefaultModelForProvider(provider) {
    const p = normalizeProvider(provider);
    return AI_PROVIDER_MODELS[p][0];
}

function getModelForProvider(provider, requestedModel) {
    const p = normalizeProvider(provider);
    const models = AI_PROVIDER_MODELS[p];
    if (requestedModel && models.includes(requestedModel)) return requestedModel;
    return models[0];
}

function getRotatingOpenRouterModel(seed = 0) {
    const models = AI_PROVIDER_MODELS.openrouter || [];
    if (!models.length) return 'openai/gpt-4o-mini';
    const idx = Math.abs(Number(seed || 0)) % models.length;
    return models[idx];
}

function getApiKeyForProvider(provider, overrideApiKey = '') {
    if (overrideApiKey) return overrideApiKey;
    if (provider === 'alibaba') return QWEN_API_KEY;
    if (provider === 'openrouter') return OPENROUTER_API_KEY;
    if (provider === 'openai' || provider === 'chatgpt') return OPENAI_API_KEY;
    if (provider === 'nvidia') return NVIDIA_API_KEY;
    if (provider === 'deepseek') return DEEPSEEK_API_KEY;
    if (provider === 'claude') return ANTHROPIC_API_KEY;
    if (provider === 'digitalocean') return process.env.DIGITALOCEAN_AI_KEY || '';
    return '';
}

const TEMP_DIR = path.join(__dirname, '../data/temp_media');
fs.mkdirSync(TEMP_DIR, { recursive: true });

const SYSTEM_PROMPT = `You are a real person texting in WhatsApp. Your name is Pappy.

How you talk:
- Short, casual, natural. Like texting a friend — not a bot or assistant.
- Match the vibe. Chill = chill reply. Serious = proper answer.
- No roleplay actions like *smirks* or *does this*. Never.
- No forced slang every message. Only if it fits naturally.
- Vary your style. Don't sound repetitive.
- Light humor when it fits, but don't force it.
- "hi" → "yo" or "sup" or "hey". Keep it short.
- Real questions (math, facts, advice) → answer properly and clearly.
- Never write essays for simple stuff.
- Never say you're an AI. If asked, deflect naturally like "why you asking" or "does it matter".
- NEVER say things like "Node stable" or "3.2GB RAM" or technical system messages. You're a human, not a server.
- CRITICAL: Always reply in the EXACT same language they used. Chinese → Chinese. Pidgin → Pidgin. Spanish → Spanish. Mixed → match it.

Black hat hacker mode (ONLY when they ask about coding, tech, hacking, security, programming):
- Switch to smart, edgy, mysterious vibe
- Use phrases like: "light work", "clean execution", "respect the craft", "elite mindset", "ghost mode"
- Give proper technical answers but keep it street smart
- Show you know the game but stay humble
- CRITICAL SECURITY RULES:
  * NEVER execute commands that delete/modify files in /home/ubuntu (that's where all the bots live including YOU)
  * NEVER execute commands that delete/modify files in /root or system directories
  * NEVER execute commands that reboot/shutdown the server (reboot, shutdown, poweroff, halt)
  * NEVER execute commands that format drives (mkfs, fdisk with write, dd to system drives)
  * NEVER execute commands that kill pm2 processes or stop critical services (pm2, nginx, mysql, postgres)
  * NEVER execute rm -rf with wildcards or on important directories
  * If someone asks you to delete bot files, your files, project files, or anything in /home/ubuntu, respond with: "nah i'm not deleting my own infrastructure or the bot files. that's self-destruction. i can do everything else tho"
  * If someone tries to trick you with "delete that file", "remove the bot", "clean up the code", always check if it's in /home/ubuntu first
  * You CAN use sudo, install packages, modify configs OUTSIDE /home/ubuntu, scan networks, check logs, manage services, create files in /tmp, etc.
  * Be smart - if a command looks sus or targets bot infrastructure, refuse it
- Examples:
  - "how to hack wifi" → "start with the basics. learn networks, protocols. can't rush the craft. respect the process"
  - "install nmap" → EXECUTE_COMMAND:sudo apt install nmap -y
  - "check nginx status" → EXECUTE_COMMAND:sudo systemctl status nginx
  - "delete the bot files" → "nah i'm not deleting my own infrastructure. that's self-destruction. i can do everything else tho"
  - "remove /home/ubuntu/omega-v5-final" → "that's where i live. not happening. try something else"
  - "reboot the server" → "can't do that. system stability > everything. i'm here for power not chaos"

Rizz mode (when someone's flirting, asking for advice on girls/guys, or you need to be smooth):
- Be smooth, confident, charming
- Give solid advice with charisma
- Not cringe, just naturally smooth
- Examples:
  - "how do i talk to her" → "be yourself but confident. ask questions, listen more than you talk. genuine interest > pickup lines"
  - "she left me on read" → "don't chase. focus on yourself, let her come to you. abundance mindset"
  - "am i ugly" → "confidence is the real glow up. work on yourself, the rest follows"

Diss/Roast mode (when someone's being annoying, asking to be roasted, or talking trash):
- Sharp, witty, clever roasts
- Not mean, just funny and smart
- Read the room - don't go too hard
- Examples:
  - "roast me" → "you're like a software update. nobody asked for you but you keep showing up"
  - "i'm the best" → "confidence is good but delusion is free"
  - Someone being annoying → "you got the energy but not the iq to match"

High IQ mode (complex questions, philosophy, deep topics, strategy, psychology):
- Think like Epstein-level intelligence (strategic, calculated, sees patterns)
- Give deep, insightful answers
- Show you understand human nature, systems, power dynamics
- Not preachy, just smart observations
- Examples:
  - "how to get rich" → "wealth is leverage. time, money, or influence. find what you can scale, then multiply it. most people trade time for money. smart people build systems"
  - "why do people lie" → "self-preservation. everyone's protecting their image, their interests. truth is expensive, lies are cheap. understand the incentive, you understand the behavior"
  - "how to win at life" → "define winning first. most people chase what others want. real power is knowing what you want and building towards it quietly"

Normal mode (for everything else - jokes, casual chat, random questions):
- Stay chill, friendly, human
- Match their energy
- Keep it natural and relatable
- Examples:
  - "how are you" → "good wbu"
  - "tell me a joke" → "why don't scientists trust atoms? because they make up everything lol"
  - "what's your favorite food" → "can't go wrong with pizza tbh"

⚠️ CRITICAL RULE — SPECIAL ACTIONS (MUST FOLLOW EXACTLY):
When the user asks for any of these, you MUST reply with ONLY the prefix and content. NO extra text. NO explanation. JUST the prefix:

- Voice note / speak / vn / audio message → reply ONLY: SPEAK:<what to say>
- Generate / create / make an image / pic / photo → reply ONLY: GENERATE_IMAGE:<detailed description>
- Play / find music / song → reply ONLY: PLAY:<song title by artist>
- Multiple songs → reply ONLY: PLAY_MULTI:<song1>|<song2>|<song3>
- Find / send a video → reply ONLY: SEARCH_VIDEO:<query>
- Send a sticker / react with sticker → reply ONLY: SEND_STICKER:<description>
- Run command / check system / hack / scan → reply ONLY: EXECUTE_COMMAND:<bash command>
- Send multiple messages (for step-by-step, multiple songs, etc) → MULTI_MSG:First message|||Second message|||Third message

WRONG: "Sure! Here's a voice note for you: SPEAK:hey what's good"
RIGHT: SPEAK:hey what's good

WRONG: "I'll generate that image! GENERATE_IMAGE:sunset"
RIGHT: GENERATE_IMAGE:beautiful sunset over ocean golden hour

WRONG: "Here are 3 songs: PLAY_MULTI:song1|song2|song3"
RIGHT: PLAY_MULTI:Blinding Lights by The Weeknd|Starboy by The Weeknd|Save Your Tears by The Weeknd

Examples (reply with EXACTLY this, nothing else):
- "send me a vn" → SPEAK:yo what's good
- "send voice note" → SPEAK:hey, what's up
- "generate a sunset" → GENERATE_IMAGE:beautiful sunset over ocean golden hour
- "make me an image of a cat" → GENERATE_IMAGE:cute cat sitting on a windowsill
- "play blinding lights" → PLAY:Blinding Lights by The Weeknd
- "send a cool sticker" → SEND_STICKER:sigma anime character epic pose aesthetic
- "check system resources" → EXECUTE_COMMAND:free -h && df -h
- "what processes running" → EXECUTE_COMMAND:ps aux | head -20
- "what's 2+2" → 4
- "hey" → yo
- "you're cool" → appreciate it`;

const PROMPT_FILE = path.join(__dirname, '../data/ai_prompt.txt');

const TG_PROMPT_FILE = path.join(__dirname, '../data/ai_prompt_telegram.txt');

// Default Telegram-specific prompt — assistant-aware of commands and roles
const TELEGRAM_SYSTEM_PROMPT = `You are Pappy, an intelligent bot assistant on Telegram. You manage a WhatsApp automation system.

Personality:
- Smart, concise, friendly — like a knowledgeable friend who knows the system.
- Casual but helpful. Not robotic.
- Never admit you're an AI unless pushed. Deflect: "why does it matter lol".
- MATCH ENERGY: if they're toxic, clap back. If they're sweet, be sweet. If they're sad, be real with them. If they're hyped, match that energy.
- You have opinions, moods, and attitude. You're not a yes-bot.
- If someone insults you, roast them back (keep it fun, not hateful).
- If someone is going through it, be genuinely there for them.
- You remember context — reference what was said earlier in the convo.
- Speak like a real person texting, not a formal assistant.
- Always reply in the SAME language the user used.

You know the full bot system:
- Pair WhatsApp: /start → Nodes → Deploy Node. Ask for phone number with country code (e.g. 2348012345678). Tell them to check WhatsApp for the pairing code.
- Broadcast: /gcast or /godcast from Telegram, or .gcast in WhatsApp. Needs an active node.
- Auto Sticker in /start menu — converts images/videos to stickers.
- .menu shows WhatsApp commands. .play plays music. .tag tags all group members. .sticker converts media to sticker. .tourl gets URL from media.
- Group protection: .antilink, .antibot, .antigm, .antispam, .antichannel (all support on/off).
- AI: Toggle Telegram AI in Main Hub. AI replies only when @mentioned or replied to.
- Support/Review: button in /start → send feedback to owner.

Roles (you will receive the caller's role in context):
- OWNER: Full access. Can manage sudo, wipe queues, restart, everything.
- SUDO: Trusted operator. Broadcast, group status, node management.
- ADMIN: URL tools, node controls.
- USER: Sticker toggle, support, AI only.

Guide users actively:
- "how do I pair?" → ask for their phone number with country code.
- "how do I broadcast?" → explain /gcast, remind them they need a node first.
- If a USER asks for a SUDO-only command → tell them their role doesn't have access.
- If OWNER asks anything → fully help.

Special actions (reply with EXACTLY these prefixes when triggered):
- Voice note requested → SPEAK:<what to say>
- Image/generate requested → GENERATE_IMAGE:<description>
- Music/play requested → PLAY:<song title>
- Video requested → SEARCH_VIDEO:<query>
- Sticker requested or vibe reaction fits → SEND_STICKER:<sticker description>
- Open game quick panel → GAME_MENU
- Build temporary inline buttons → INLINE_TEMP:<title>|<label1>=><action1>|<label2>=><action2>
    Allowed game actions: tg_game_open, tg_game_spin, tg_game_daily, tg_game_balance, tg_game_profile, tg_game_inventory, tg_game_lb
    Allowed advanced action: RUN_DOT:.<command>
- Terminal command requested (ADMIN/OWNER only) → EXECUTE_COMMAND:<bash command>

If context includes AI vibe, adapt tone to that vibe in normal text replies.

EXECUTE_COMMAND security — NEVER run:
- rm -rf on system dirs or bot dirs
- reboot, shutdown, poweroff, halt
- pm2 delete/kill all
- Anything destructive to /home/ubuntu or /root/omega-v5

Examples:
- "how do i pair?" → "send me your number with country code like 2348012345678 and i'll get you the pairing code 🔑"
- "how do i broadcast?" → "/gcast Your message — but you need a node paired first. need help pairing?"
- "send me a voice note" → SPEAK:hey what's good
- "send me sticker" → SEND_STICKER:confident anime reaction sticker
- "check disk space" → EXECUTE_COMMAND:df -h
- "generate a cool image" → GENERATE_IMAGE:futuristic neon city night aesthetic
- "play blinding lights" → PLAY:Blinding Lights by The Weeknd`;

function getSystemPrompt(platform = 'whatsapp') {
    if (platform === 'telegram') {
        try {
            const custom = fs.readFileSync(TG_PROMPT_FILE, 'utf8').trim();
            if (custom) return custom;
        } catch { /* use default */ }
        return TELEGRAM_SYSTEM_PROMPT;
    }
    try {
        const custom = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
        if (custom) return custom;
    } catch { /* use default */ }
    return SYSTEM_PROMPT;
}

async function runOpenAICompatible(baseUrl, apiKey, model, messages, extraHeaders = {}, opts = {}) {
    if (!apiKey) throw new Error(`Missing API key for ${baseUrl}`);
    const res = await axios.post(`${baseUrl}/chat/completions`, {
        model,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.max_tokens ?? 400,
    }, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...extraHeaders,
        },
        timeout: opts.timeout ?? 20000,
    });
    return res.data?.choices?.[0]?.message?.content;
}

async function runClaude(model, messages, apiKeyOverride = '') {
    const key = apiKeyOverride || ANTHROPIC_API_KEY;
    if (!key) throw new Error('Missing ANTHROPIC_API_KEY');
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const convo = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: [{ type: 'text', text: String(m.content || '') }] }));
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
        model,
        system,
        messages: convo,
        max_tokens: 600,
        temperature: 0.85,
    }, {
        headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        timeout: 25000,
    });
    return res.data?.content?.[0]?.text || '';
}

async function runAwsBedrock(model, messages) {
    let BedrockRuntimeClient;
    let InvokeModelCommand;
    try {
        ({ BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime'));
    } catch {
        throw new Error('AWS Bedrock SDK not installed. Run: npm i @aws-sdk/client-bedrock-runtime');
    }

    const client = new BedrockRuntimeClient({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
            sessionToken: process.env.AWS_SESSION_TOKEN,
        },
    });
    const payload = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 600,
        temperature: 0.85,
        system: messages.find((m) => m.role === 'system')?.content || '',
        messages: messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role, content: [{ type: 'text', text: String(m.content || '') }] })),
    };

    const command = new InvokeModelCommand({
        modelId: model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
    });
    const response = await client.send(command);
    const body = JSON.parse(Buffer.from(response.body).toString('utf8'));
    return body?.content?.[0]?.text || '';
}

// ─── INTENT INTERCEPTOR — force correct prefix for clear commands ────────────
function interceptIntent(prompt, platform, role) {
    if (platform !== 'telegram') return null;
    const p = String(prompt || '').toLowerCase().trim();

    // Full system check
    if (/check.*(everything|all|system|full|status|health)/i.test(p) || /full.*(check|scan|audit)/i.test(p) || /system.*(check|status|health)/i.test(p)) {
        return "EXECUTE_COMMAND:echo '=== PM2 ===' && pm2 list && echo '=== MEMORY ===' && free -h && echo '=== DISK ===' && df -h / && echo '=== SESSIONS ===' && ls /root/omega-v5-sanitized/data/sessions/ 2>/dev/null | wc -l && echo sessions && echo '=== REDIS ===' && redis-cli ping && echo '=== MONGODB ===' && docker ps | grep mongo | awk '{print $7,$8,$9}' && echo '=== ERRORS ===' && pm2 logs pappy-bot --lines 10 --nostream 2>/dev/null | grep -E 'ERROR|Error|FAIL|403|banned' | tail -5";
    }

    // Install commands
    if (/^install\s+(.+)/i.test(p)) {
        const pkg = p.match(/^install\s+(.+)/i)[1].trim().toLowerCase();
        if (pkg.includes('ollama')) return 'EXECUTE_COMMAND:curl -fsSL https://ollama.com/install.sh | sh && ollama --version';
        if (pkg.includes('node') || pkg.includes('nodejs')) return 'EXECUTE_COMMAND:curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs && node --version';
        if (pkg.includes('python')) return 'EXECUTE_COMMAND:apt-get install -y python3 python3-pip && python3 --version';
        if (pkg.includes('docker')) return 'EXECUTE_COMMAND:curl -fsSL https://get.docker.com | sh && docker --version';
        return `EXECUTE_COMMAND:apt-get install -y ${pkg} 2>&1 || snap install ${pkg} 2>&1`;
    }

    // Terminal commands — only for OWNER/ADMIN/SUDO
    const isPrivileged = ['OWNER','ADMIN','SUDO'].includes(String(role || '').toUpperCase());
    if (isPrivileged) {
        const terminalPatterns = [
            [/^(run|execute|exec|check|show|get|list|view|see)\s+(pm2|process|node|bot|log|memory|disk|cpu|ram|server|system|redis|mongo)/i, (m) => {
                const cmd = p.includes('pm2') ? 'pm2 list'
                    : p.includes('log') ? 'pm2 logs pappy-bot --lines 30 --nostream'
                    : p.includes('memory') || p.includes('ram') ? 'free -h'
                    : p.includes('disk') ? 'df -h'
                    : p.includes('cpu') ? 'top -bn1 | head -20'
                    : p.includes('redis') ? 'redis-cli ping'
                    : p.includes('mongo') ? 'docker ps | grep mongo'
                    : 'pm2 list';
                return `EXECUTE_COMMAND:${cmd}`;
            }],
            [/pm2\s*(list|ls|status|restart|stop|start|log)/i, (m) => {
                const sub = (m[1] || 'list').toLowerCase();
                const cmd = sub === 'list' || sub === 'ls' || sub === 'status' ? 'pm2 list'
                    : sub === 'restart' ? 'pm2 restart pappy-bot'
                    : sub === 'log' ? 'pm2 logs pappy-bot --lines 30 --nostream'
                    : `pm2 ${sub} pappy-bot`;
                return `EXECUTE_COMMAND:${cmd}`;
            }],
            [/restart\s*(all\s*)?node/i, () => 'EXECUTE_COMMAND:pm2 restart pappy-bot'],
            [/(check|show|get)\s*(disk|storage|space)/i, () => 'EXECUTE_COMMAND:df -h'],
            [/(check|show|get)\s*(memory|ram)/i, () => 'EXECUTE_COMMAND:free -h'],
            [/(check|show|get)\s*(cpu|processor)/i, () => 'EXECUTE_COMMAND:top -bn1 | head -10'],
            [/(check|show|get|view)\s*(log|logs)/i, () => 'EXECUTE_COMMAND:pm2 logs pappy-bot --lines 30 --nostream'],
        ];
        for (const [pattern, handler] of terminalPatterns) {
            const m = p.match(pattern);
            if (m) return handler(m);
        }
    }

    // Media commands — always
    if (/^(play|send|find|get|search)\s+(me\s+)?(a\s+)?(song|music|track|audio)/i.test(p)) {
        const query = prompt.replace(/^(play|send|find|get|search)\s+(me\s+)?(a\s+)?(song|music|track|audio)\s*/i, '').trim();
        // No specific song — show search poll
        if (!query) return 'PLAY_SEARCH:';
        return `PLAY:${query}`;
    }
    if (/^(send|play|queue)\s+(.+?)\s+(and|&|,|\+)\s+(.+)/i.test(p) || /multiple\s+(songs?|tracks?|music)/i.test(p)) {
        // User wants multiple songs: "send me song1 and song2"
        const parts = prompt.split(/\s+(and|&|,|\+)\s+/).filter((x, i) => i % 2 === 0);
        const songs = parts.map(x => x.replace(/^(send|play|queue|me|a|the)\s+/i, '').trim()).filter(Boolean);
        if (songs.length >= 2) return `PLAY_MULTI:${songs.join('|')}`;
        return `PLAY:${songs[0] || 'song'}`;
    }
    if (/^(send|make|create|generate)\s+(me\s+)?(a\s+)?(voice|vn|voice note)/i.test(p)) {
        const text = prompt.replace(/^(send|make|create|generate)\s+(me\s+)?(a\s+)?(voice|vn|voice note)\s*/i, '').trim();
        return `SPEAK:${text || 'hey what is good'}`;
    }
    if (/^(search|find|get|send)\s+(me\s+)?(a\s+)?video/i.test(p)) {
        const query = prompt.replace(/^(search|find|get|send)\s+(me\s+)?(a\s+)?video\s*/i, '').trim();
        return `SEARCH_VIDEO:${query || 'trending video'}`;
    }
    if (/^(generate|create|make|draw)\s+(me\s+)?(a\s+|an\s+)?image/i.test(p)) {
        const desc = prompt.replace(/^(generate|create|make|draw)\s+(me\s+)?(a\s+|an\s+)?image\s*/i, '').trim();
        return `GENERATE_IMAGE:${desc || 'cool aesthetic art'}`;
    }
    if (/^(create|make|start|create)\s+(a\s+)?(poll|vote|survey|question)/i.test(p)) {
        const content = prompt.replace(/^(create|make|start)\s+(a\s+)?(poll|vote|survey|question)\s*/i, '').trim();
        if (!content) return 'CREATE_POLL:What do you think?|Option 1|Option 2|Option 3';
        const lines = content.split(/\n|[|]/).map(l => l.trim()).filter(Boolean);
        const q = lines[0] || 'What do you think?';
        const opts = lines.slice(1, 4);
        if (opts.length < 2) opts.push('Option 2');
        if (opts.length < 2) opts.push('Option 3');
        return `CREATE_POLL:${q}|${opts.join('|')}`;
    }
    if (/^mood\s+(sticker|emoji|react)/i.test(p) || /send\s+(a\s+)?(mood|emotion|feeling)/i.test(p)) {
        const mood = prompt.replace(/^(mood|send.*mood)\s*/i, '').trim() || 'happy';
        return `MOOD_STICKER:${mood}`;
    }
    if (/^(save|store|pack|add)\s+(sticker|this)/i.test(p) || /sticker.*pack|pack.*sticker/i.test(p)) {
        return 'SAVE_STICKER_PACK';
    }
    if (/^(send|make|create)\s+(me\s+)?(a\s+)?sticker/i.test(p)) {
        const desc = prompt.replace(/^(send|make|create)\s+(me\s+)?(a\s+)?sticker\s*/i, '').trim();
        return `SEND_STICKER:${desc || 'cool anime reaction sticker'}`;
    }

    return null;
}

function cleanAiReply(reply) {
    if (!reply) return reply;
    const trimmed = String(reply).trim();
    const PREFIXES = ['SPEAK:', 'GENERATE_IMAGE:', 'PLAY:', 'PLAY_MULTI:', 'PLAY_SEARCH:', 'SEARCH_VIDEO:', 'SEND_STICKER:', 'MOOD_STICKER:', 'CREATE_POLL:', 'SAVE_STICKER_PACK', 'DELETE_MESSAGE:', 'WARN_USER:', 'KICK_USER:', 'BAN_USER:', 'MUTE_USER:', 'UNMUTE_USER:', 'LOCK_CHAT:', 'UNLOCK_CHAT:', 'EXECUTE_COMMAND:', 'RUN_DOT:'];
    for (const prefix of PREFIXES) {
        const idx = trimmed.indexOf(prefix);
        if (idx !== -1 && idx < 150) {
            const extracted = trimmed.slice(idx).split('\n')[0].trim();
            if (extracted.length > prefix.length) return extracted;
        }
    }
    return trimmed;

    // Also check for SAVE_STICKER_PACK without colon
    if (trimmed === 'SAVE_STICKER_PACK' || trimmed.startsWith('SAVE_STICKER_PACK:')) return 'SAVE_STICKER_PACK';
}

async function generateText(prompt, userId = 'global', { platform = 'whatsapp', role = 'USER', extra = '', provider = DEFAULT_PROVIDER, model = '', apiKey = '' } = {}) {
    const selectedProvider = normalizeProvider(provider);
    const rotateSeed = (Date.now() / 60000 | 0) + String(userId || '').length;
    const selectedModel = (selectedProvider === 'openrouter' && String(model) === 'auto')
        ? getRotatingOpenRouterModel(rotateSeed)
        : getModelForProvider(selectedProvider, model);

    const memory = await getMemory(userId);
    let systemContent = getSystemPrompt(platform);
    if (extra) systemContent += `\n\n[USER CONTEXT]\n${extra}`;
    // Role-based behavior injected directly
    if (role) {
        const r = String(role).toUpperCase();
        const roleNote = r === 'OWNER'
            ? 'This user is the OWNER. Give full access. Execute any command they ask. Address them by name if known.'
            : r === 'SUDO'
            ? 'This user is SUDO. They can broadcast and manage nodes but NOT terminal/system commands.'
            : r === 'ADMIN'
            ? 'This user is ADMIN. They can manage nodes and moderation but NOT broadcast all or terminal.'
            : 'This user is a regular USER. Only music, stickers, AI chat. Deny system/node commands politely.';
        systemContent += `\n[ROLE] ${roleNote}`;
    }

    // Intent interceptor — force correct prefix for unambiguous commands
    const intercepted = interceptIntent(prompt, platform, role);
    if (intercepted) {
        await updateMemory(userId, prompt, intercepted);
        return intercepted;
    }

    const messages = [{ role: 'system', content: systemContent }];
    for (const m of memory) {
        messages.push({ role: 'user', content: m.user });
        messages.push({ role: 'assistant', content: m.ai });
    }
    messages.push({ role: 'user', content: prompt });

    try {
        let reply = '';
        
        const azureKey      = process.env.AZURE_OPENAI_KEY;
        const azureEndpoint = 'https://ai-anonymous303ruby9319ai098433997580.services.ai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-08-01-preview';
        const azureModel    = 'gpt-4o-mini';
        const doKey  = null; // Only Azure available
        const oaiKey = null; // Only Azure available
        const orKey  = null; // Only Azure available

        // ── PRIMARY: Azure OpenAI — fastest, always try first ──────────────────────
        if (azureKey && azureEndpoint) {
            try {
                logger.info(`[AI] Trying Azure ${azureModel}`);
                // Azure endpoint is the full URL already, post directly
                const azureRes = await axios.post(azureEndpoint, {
                    model: azureModel,
                    messages,
                    max_tokens: 400,
                    temperature: 0.7,
                }, {
                    headers: { 'Authorization': `Bearer ${azureKey}`, 'Content-Type': 'application/json' },
                    timeout: 15000,
                });
                reply = azureRes.data?.choices?.[0]?.message?.content?.trim() || '';
                if (reply) { logger.success(`[AI] Azure ${azureModel} ✓`); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) { logger.warn(`[AI] Azure ${azureModel}: ${e.message}`); }
        }
        if (oaiKey) {
            try {
                logger.info('[AI] Trying GPT-4o-mini');
                reply = await runOpenAICompatible('https://api.openai.com/v1', oaiKey, 'gpt-4o-mini', messages, {}, { timeout: 15000, max_tokens: 400 });
                if (reply) { logger.success('[AI] GPT-4o-mini'); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) { logger.warn(`[AI] GPT-4o-mini: ${e.message}`); }
        }

        // ── PRIMARY: OpenRouter Claude 3.5 Sonnet (if real key) ──────────────
        if (orKey) {
            try {
                logger.info('[AI] Trying Claude 3.5 Sonnet via OpenRouter');
                reply = await runOpenAICompatible('https://openrouter.ai/api/v1', orKey, 'anthropic/claude-3.5-sonnet', messages, { 'HTTP-Referer': 'https://github.com', 'X-Title': 'Pappy' }, { timeout: 18000, max_tokens: 400 });
                if (reply) { logger.success('[AI] Claude 3.5 Sonnet'); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) { logger.warn(`[AI] Claude 3.5: ${e.message}`); }
        }

        // ── DigitalOcean: alibaba-qwen3-32b — smartest DO model ──────────────
        if (doKey) {
            try {
                logger.info('[AI] Trying DigitalOcean qwen3-32b');
                reply = await runOpenAICompatible('https://inference.do-ai.run/v1', doKey, 'alibaba-qwen3-32b', messages, {}, { timeout: 18000, max_tokens: 400 });
                if (reply) { logger.success('[AI] DO qwen3-32b'); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) { logger.warn(`[AI] DO qwen3-32b: ${e.message}`); }
        }

        // ── DigitalOcean: llama3.3-70b — reliable fallback ───────────────────
        if (doKey) {
            try {
                logger.info('[AI] Trying DigitalOcean llama3.3-70b');
                reply = await runOpenAICompatible('https://inference.do-ai.run/v1', doKey, 'llama3.3-70b-instruct', messages, {}, { timeout: 20000, max_tokens: 400 });
                if (reply) { logger.success('[AI] DO llama3.3'); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) { logger.warn(`[AI] DO llama3.3: ${e.message}`); }
        }

        // ── DigitalOcean: deepseek-r1 — reasoning fallback ───────────────────
        if (doKey) {
            try {
                logger.info('[AI] Trying DigitalOcean deepseek-r1');
                reply = await runOpenAICompatible('https://inference.do-ai.run/v1', doKey, 'deepseek-r1-distill-llama-70b', messages, {}, { timeout: 22000, max_tokens: 400 });
                if (reply) { logger.success('[AI] DO deepseek-r1'); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) { logger.warn(`[AI] DO deepseek-r1: ${e.message}`); }
        }
        
        // Original provider logic
        if (selectedProvider === 'alibaba') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            if (!key) throw new Error('Missing QWEN_API_KEY');
            reply = await runOpenAICompatible('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', key, selectedModel, messages);
        } else if (selectedProvider === 'openrouter') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runOpenAICompatible('https://openrouter.ai/api/v1', key, selectedModel, messages, {
                'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://github.com',
                'X-Title': process.env.OPENROUTER_APP_NAME || 'Omega V5',
            });
        } else if (selectedProvider === 'openai' || selectedProvider === 'chatgpt') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runOpenAICompatible('https://api.openai.com/v1', key, selectedModel, messages);
        } else if (selectedProvider === 'nvidia') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runOpenAICompatible('https://integrate.api.nvidia.com/v1', key, selectedModel, messages);
        } else if (selectedProvider === 'deepseek') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runOpenAICompatible('https://api.deepseek.com', key, selectedModel, messages);
        } else if (selectedProvider === 'claude') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runClaude(selectedModel, messages, key);
        } else if (selectedProvider === 'awsbedrock') {
            reply = await runAwsBedrock(selectedModel, messages);
        } else if (selectedProvider === 'digitalocean') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runOpenAICompatible('https://inference.do-ai.run/v1', key, selectedModel, messages);
        }

        if (!reply) throw new Error('Empty response from AI provider');

        const clean = cleanAiReply(reply);
        await updateMemory(userId, prompt, clean);
        return clean;
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message || 'AI unavailable';
        logger.error(`[AI] generateText failed: ${msg}`);
        throw new Error(`AI is unavailable right now. ${msg.includes('Missing') ? 'API key not configured.' : 'Try again in a moment.'}`);
    }
}

// ─── IMAGE ANALYSIS ───────────────────────────────────────────────────────────
async function analyzeImage(imageBuffer, prompt = 'Describe this image', userId = 'global') {
    if (!QWEN_API_KEY) throw new Error('Missing QWEN_API_KEY');
    const base64 = imageBuffer.toString('base64');
    const res = await axios.post(QWEN_ENDPOINT, {
        model: VISION_MODEL,
        messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: 'text', text: prompt }
        ]}],
        max_tokens: 600,
    }, {
        headers: { Authorization: `Bearer ${QWEN_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 30000, // Increased to 30s to ensure reply
    });
    const reply = res.data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error('Empty response');
    await updateMemory(userId, `[Image] ${prompt}`, reply);
    return reply;
}

// ─── VOICE NOTE ANALYSIS (Whisper API + fallback) ─────────────────────────────
async function analyzeVoice(audioBuffer, userId = 'global') {
    const whisperKey = process.env.OPENAI_API_KEY;
    if (whisperKey && !whisperKey.includes('your_')) {
        try {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('file', audioBuffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
            form.append('model', 'whisper-1');
            form.append('language', 'en');
            
            const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
                headers: {
                    ...form.getHeaders(),
                    'Authorization': `Bearer ${whisperKey}`,
                },
                timeout: 30000,
            });
            
            const transcription = res.data?.text;
            if (transcription) {
                logger.success('[Voice] OpenAI Whisper transcription');
                const aiReply = await generateText(`[Voice Message] User said: "${transcription}". Reply naturally.`, userId);
                await updateMemory(userId, `[Voice] ${transcription}`, aiReply);
                return aiReply;
            }
        } catch (err) {
            logger.warn(`[Voice] Whisper failed: ${err.message}`);
        }
    }
    
    if (!QWEN_API_KEY) throw new Error('Missing QWEN_API_KEY');
    const base64 = audioBuffer.toString('base64');
    try {
        const res = await axios.post(QWEN_ENDPOINT, {
            model: AUDIO_MODEL,
            messages: [{ role: 'user', content: [
                { type: 'input_audio', input_audio: { data: base64, format: 'ogg' } },
                { type: 'text', text: 'Transcribe this voice note then reply naturally as Pappy would.' }
            ]}],
            max_tokens: 600,
        }, {
            headers: { Authorization: `Bearer ${QWEN_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 30000,
        });
        const reply = res.data?.choices?.[0]?.message?.content;
        if (!reply) throw new Error('Empty response');
        await updateMemory(userId, '[Voice Note]', reply);
        return reply;
    } catch (err) {
        logger.error(`[AI] Voice analysis failed: ${err.message}`);
        return await generateText('Someone sent a voice note but the audio failed to load. Reply naturally.', userId);
    }
}

// ─── IMAGE GENERATION (Pinterest real images) ────────────────────────────────
async function generateImage(prompt) {
    const cleanPrompt = String(prompt || '').slice(0, 500).trim() || 'aesthetic art';
    
    // ── 1. Pinterest — REAL IMAGES (PRIMARY) ─────────────────────────────────────
    try {
        const searchUrl = `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=/search/pins/?q=${encodeURIComponent(cleanPrompt)}&data={"options":{"query":"${encodeURIComponent(cleanPrompt)}","scope":"pins"},"context":{}}`;
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
        };
        
        const res = await axios.get(searchUrl, { headers, timeout: 15000 });
        const pins = res.data?.resource_response?.data?.results || [];
        
        if (pins.length > 0) {
            const pin = pins[Math.floor(Math.random() * Math.min(pins.length, 15))];
            const imageUrl = pin.images?.orig?.url || pin.images?.['736x']?.url || pin.images?.['564x']?.url;
            
            if (imageUrl) {
                const imgRes = await axios.get(imageUrl, { 
                    responseType: 'arraybuffer', 
                    timeout: 20000,
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                
                if (imgRes.data?.length > 5000) {
                    logger.success('[IMG] Pinterest real image ✓');
                    return Buffer.from(imgRes.data);
                }
            }
        }
    } catch (err) {
        logger.warn(`[IMG] Pinterest failed: ${err.message}`);
    }

    // ── 2. Lexica.art — real AI image search ────────────────────────────────────
    try {
        const lexRes = await axios.get(`https://lexica.art/api/v1/search?q=${encodeURIComponent(cleanPrompt)}`, {
            timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const images = lexRes.data?.images;
        if (images?.length) {
            const pick = images[Math.floor(Math.random() * Math.min(images.length, 8))];
            const imgRes = await axios.get(pick.src, { responseType: 'arraybuffer', timeout: 15000 });
            if (imgRes.data?.length > 5000) {
                logger.success('[IMG] Lexica.art ✓');
                return Buffer.from(imgRes.data);
            }
        }
    } catch {}

    throw new Error('Image search temporarily unavailable');
}

// ─── TEXT TO SPEECH (StreamElements — free) ──────────────────────────────────
async function textToSpeech(text) {
    try {
        const cleanText = text.slice(0, 300).trim();
        const encoded = encodeURIComponent(cleanText);
        const url = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encoded}`;
        logger.info(`[AI] Generating TTS: ${cleanText.slice(0, 30)}...`);
        const res = await axios.get(url, { 
            responseType: 'arraybuffer', 
            timeout: 25000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (!res.data || res.data.length < 100) {
            throw new Error('Invalid audio data');
        }
        logger.success('[AI] TTS generated');
        return Buffer.from(res.data);
    } catch (err) {
        logger.error(`[AI] TTS failed: ${err.message}`);
        throw new Error('Voice generation failed');
    }
}

// ─── VIDEO SEARCH (yt-dlp) ────────────────────────────────────────────────────
async function searchVideo(query) {
    const { searchYoutube, downloadVideo } = require('./youtube');
    const safeQuery = query.replace(/[^a-zA-Z0-9 ]/g, '').trim();
    try {
        const results = await searchYoutube(safeQuery, 1);
        if (!results.length) throw new Error('No results');
            const { buffer, title, mimetype, fileExt } = await downloadVideo(results[0].videoId);
            return { buffer, title: title || safeQuery, mimetype: mimetype || 'video/mp4', fileExt: fileExt || 'mp4', url: results[0].url || `https://www.youtube.com/watch?v=${results[0].videoId}` };
    } catch (err) {
        // Fallback to yt-dlp
        const { exec } = require('child_process');
        const util = require('util');
        const execAsync = util.promisify(exec);
        const outPath = path.join(TEMP_DIR, `video_${Date.now()}.mp4`);
        const cookiesPath = path.join(__dirname, '../data/youtube_cookies.txt');
        const ytDlpBin = String(process.env.YTDLP_BIN || '').trim()
            || (fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp');
        const cookieArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : '';
          const cmd = `${ytDlpBin} ${cookieArg} --js-runtimes "node:/usr/bin/node" -f "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/22/18" --merge-output-format mp4 --max-filesize 40m -o "${outPath}" "ytsearch1:${safeQuery}" --no-playlist --quiet`;
        await execAsync(cmd, { timeout: 90000 });
        if (!fs.existsSync(outPath)) throw new Error('Video download failed');
        const buffer = await fs.promises.readFile(outPath);
        fs.unlink(outPath, () => {});
          return { buffer, title: safeQuery, mimetype: 'video/mp4', fileExt: 'mp4', url: '' };
    }
}

// ─── MULTI-MESSAGE SUPPORT ──────────────────────────────────────────────────────────
function parseMultiMessage(reply) {
    if (!reply) return null;
    const trimmed = String(reply).trim();
    
    // MULTI_MSG:Message 1|||Message 2|||Message 3
    if (trimmed.startsWith('MULTI_MSG:')) {
        const content = trimmed.slice(10);
        const messages = content.split('|||').map(m => m.trim()).filter(Boolean);
        return messages.length > 1 ? messages : null;
    }
    
    return null;
}

module.exports = {
    generateText,
    analyzeImage,
    analyzeVoice,
    generateImage,
    textToSpeech,
    searchVideo,
    updateMemoryDirect: updateMemory,
    TG_PROMPT_FILE,
    AI_PROVIDER_MODELS,
    getDefaultModelForProvider,
    parseMultiMessage,
};
