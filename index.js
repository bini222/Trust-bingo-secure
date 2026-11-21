const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

if (!process.env.BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN is missing in environment variables.');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID).trim() : '8776479328';
const MIN_WITHDRAW = 1000;
const PAYOUT_RATE = 0.80;

// የመክፈያ መረጃዎች
const PAYMENT_ACCOUNTS = {
    Telebirr: {
        label: 'Telebirr',
        account: '0912698277',
        holder: 'Biniyam'
    },
    CBE: {
        label: 'CBE',
        account: '1000161123726',
        holder: 'Biniyam'
    }
};

// --- ቋሚ ማከማቻ (data/users.json እና data/used_proofs.json) ---
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PROOFS_FILE = path.join(DATA_DIR, 'used_proofs.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.error(`Failed to read ${filePath}:`, e.message);
        return fallback;
    }
}

function saveJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`Failed to save ${filePath}:`, e.message);
    }
}

let users = loadJson(USERS_FILE, {});
let usedProofs = loadJson(PROOFS_FILE, {
    photos: {},
    sms: {}
});

function saveUsers() {
    saveJson(USERS_FILE, users);
}

function saveProofs() {
    saveJson(PROOFS_FILE, usedProofs);
}

function normalizeText(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function hashText(text) {
    return crypto.createHash('sha256').update(normalizeText(text)).digest('hex');
}

function looksLikePaymentSms(text) {
    const t = normalizeText(text);
    const keywords = [
        'telebirr', 'birr', 'etb', 'cbe', 'commercial bank', 'transaction',
        'paid to', 'transferred', 'debited', 'credited', 'receipt', 'tx id',
        'ብር', 'ክፍያ', 'ተላልፏል', 'ደረሰኝ', '2519', '09', '1000'
    ];
    return t.length >= 20 && keywords.some((kw) => t.includes(kw));
}

// ገንዘቡ ወደ Biniyam (0912698277 / 251912698277 / 1000161123726) መላኩን ማረጋገጫ
function smsSentToOwner(text) {
    const t = normalizeText(text);
    const compact = t.replace(/[\s\-+*]/g, '');

    // ገንዘቡ ወደ ሌላ ሰው ስም ወይም ቁጥር የተላከ ከሆነ ውድቅ አድርግ
    const sentToOtherPerson =
        t.includes('to birhanu') ||
        compact.includes('2519****6699') ||
        /transferred\s+(?:etb|birr)?\s*[\d,.]+\s+(?:etb|birr)?\s*to\s+(?!biniyam\b)/i.test(text) ||
        /paid\s+(?:etb|birr)?\s*[\d,.]+\s+(?:etb|birr)?\s*to\s+(?!biniyam\b)/i.test(text);

    if (sentToOtherPerson) {
        return false;
    }

    const validTargets = [
        '0912698277',
        '251912698277',
        '1000161123726',
        'to biniyam'
    ];

    return validTargets.some((target) => compact.includes(target.replace(/\s+/g, '')) || t.includes(target));
}

async function notifyAdmin(fn) {
    if (!ADMIN_ID) return;
    try {
        await fn(ADMIN_ID);
    } catch (err) {
        console.error('Admin notification error:', err.message);
    }
}

function getUser(userId) {
    const key = String(userId);
    if (!users[key]) {
        users[key] = {
            mainWallet: 0,
            playWallet: 100,
            pendingDepositMethod: null
        };
        saveUsers();
    }
    return users[key];
}

function totalBalance(user) {
    return Number((Number(user.mainWallet || 0) + Number(user.playWallet || 0)).toFixed(2));
}

function spendFromWallets(user, amount) {
    if (totalBalance(user) < amount) return false;
    let remaining = Number(amount);

    if (user.playWallet >= remaining) {
        user.playWallet = Number((user.playWallet - remaining).toFixed(2));
        saveUsers();
        return true;
    }

    remaining = Number((remaining - user.playWallet).toFixed(2));
    user.playWallet = 0;
    user.mainWallet = Number((user.mainWallet - remaining).toFixed(2));
    saveUsers();
    return true;
}

// --- የጨዋታ ክፍሎች (Stake Rooms: 10, 20, 50) ---
const CARTELA_COUNT = 300;
const rooms = {};

function createRoom(stake) {
    return {
        stake,
        takenCartelas: {}
    };
}

[10, 20, 50].forEach((s) => {
    rooms[s] = createRoom(s);
});

function getRoomSummary(stake) {
    const room = rooms[stake] || createRoom(stake);
    const takenIds = Object.keys(room.takenCartelas).map(Number);
    const totalPool = takenIds.length * room.stake;
    const derash = Math.floor(totalPool * PAYOUT_RATE);
    return {
        stake: room.stake,
        takenCount: takenIds.length,
        takenCartelas: takenIds,
        totalPool,
        derash
    };
}

// --- 300 ካርቴላዎች (#1 - #300) ---
function createSeededRandom(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return function () {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
    };
}

function shuffleWithSeed(array, rand) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function buildCartela(cartelaId) {
    const rand = createSeededRandom(cartelaId * 7919 + 104729);
    const ranges = [
        { start: 1, end: 15 },
        { start: 16, end: 30 },
        { start: 31, end: 45 },
        { start: 46, end: 60 },
        { start: 61, end: 75 }
    ];

    const cols = ranges.map(({ start, end }) => {
        const pool = [];
        for (let n = start; n <= end; n++) pool.push(n);
        return shuffleWithSeed(pool, rand).slice(0, 5);
    });

    const card = [];
    for (let r = 0; r < 5; r++) {
        const row = [];
        for (let c = 0; c < 5; c++) {
            row.push(r === 2 && c === 2 ? 'FREE' : cols[c][r]);
        }
        card.push(row);
    }
    return card;
}

const cartelas = {};
for (let id = 1; id <= CARTELA_COUNT; id++) {
    cartelas[id] = buildCartela(id);
}

// --- ዋና ሜኑ ---
function getMainKeyboard() {
    return Markup.keyboard([
        ['🎮 Play', '💰 Deposit'],
        ['💸 Withdraw', '💳 Check Balance'],
        ['🎁 Invite', '📖 How To Play']
    ]).resize();
}

function getPlayReplyMarkup(userId) {
    if (APP_URL && APP_URL.startsWith('https://')) {
        return Markup.inlineKeyboard([
            [Markup.button.webApp('🚀 Open Trust Bingo Mini App', `${APP_URL}?userId=${userId}`)]
        ]);
    }
    return Markup.inlineKeyboard([
        [Markup.button.callback('ℹ️ APP_URL ያዋቅሩ', 'need_app_url')]
    ]);
}

bot.start((ctx) => {
    const user = getUser(ctx.from.id);
    user.pendingDepositMethod = null;
    saveUsers();
    ctx.reply(
        `🎉 እንኳን ወደ <b>Trust Bingo</b> በደህና መጣህ!\n\n` +
        `🏦 Main Wallet: <b>${user.mainWallet.toFixed(2)} ብር</b>\n` +
        `🎁 Play Wallet: <b>${user.playWallet.toFixed(2)} ብር</b>\n` +
        `💰 Total Balance: <b>${totalBalance(user).toFixed(2)} ብር</b>\n\n` +
        `ከታች ካሉት አዝራሮች አንዱን ምረጥ፦`,
        { parse_mode: 'HTML', ...getMainKeyboard() }
    );
});

bot.hears(['🎮 Play', '🎮 Play Game'], (ctx) => {
    ctx.reply(
        `🎮 <b>Trust Bingo Mini App</b> ለመክፈት ከታች ያለውን ቁልፍ ተጫን፦\n` +
        `• Stake መምረጥ (10 / 20 / 50 ብር)\n` +
        `• ካርቴላ ሲያዝ ደራሽ (80% pool) በራስ-ሰር ይጨምራል`,
        { parse_mode: 'HTML', ...getPlayReplyMarkup(ctx.from.id) }
    );
});

bot.action('need_app_url', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply(
        `⚠️ በ Render Environment Variables ውስጥ <code>APP_URL</code> (የ https://...onrender.com ሊንክህን) አስገባ።`,
        { parse_mode: 'HTML' }
    );
});

bot.hears(['💳 Check Balance', '💰 ባላንስ (Balance)'], (ctx) => {
    const user = getUser(ctx.from.id);
    ctx.reply(
        `💰 <b>BALANCE SUMMARY</b> 💰\n\n` +
        `🏦 Main Wallet: <b>${user.mainWallet.toFixed(2)}</b>\n` +
        `🎁 Play Wallet: <b>${user.playWallet.toFixed(2)}</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💵 Total Balance: <b>${totalBalance(user).toFixed(2)} ብር</b>`,
        { parse_mode: 'HTML' }
    );
});

bot.hears('💰 Deposit', (ctx) => {
    const user = getUser(ctx.from.id);
    user.pendingDepositMethod = null;
    saveUsers();
    ctx.reply(
        `💳 ገንዘብ ለማስገባት የመክፈያ ዘዴ ምረጥ፦`,
        Markup.inlineKeyboard([
            [
                Markup.button.callback('📱 Telebirr', 'deposit_Telebirr'),
                Markup.button.callback('🏦 CBE', 'deposit_CBE')
            ]
        ])
    );
});

bot.action(/^deposit_(Telebirr|CBE)$/, async (ctx) => {
    const method = ctx.match[1];
    const info = PAYMENT_ACCOUNTS[method];
    const user = getUser(ctx.from.id);
    user.pendingDepositMethod = method;
    saveUsers();

    await ctx.answerCbQuery(`${method} ተመርጧል`);
    await ctx.reply(
        `✅ <b>${info.label} Deposit</b>\n\n` +
        `📌 አካውንት / ስልክ፦ <code>${info.account}</code>\n` +
        `👤 ስም፦ <b>${info.holder}</b>\n\n` +
        `ክፍያውን ወደ <b>${info.holder} (${info.account})</b> ከፈጸምክ በኋላ <b>የክፍያ ስክሪንሾት (Photo)</b> ወይም <b>የ SMS መልዕክት (SMS Copy)</b> ላክ፦`,
        { parse_mode: 'HTML' }
    );
});

// --- ስክሪንሾት መቀበል፣ የተደጋገመ መከላከል እና ወደ Admin መላክ ---
bot.on('photo', async (ctx) => {
    const user = getUser(ctx.from.id);
    const method = user.pendingDepositMethod || 'Telebirr / CBE';
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const uniqueKey = photo.file_unique_id;

    if (usedProofs.photos[uniqueKey]) {
        return ctx.reply(
            `❌ <b>ስህተት / Wrong!</b>\n` +
            `ይህ ስክሪንሾት ቀድሞ ተልኳል! ተመሳሳይ ስክሪንሾት እንደገና መላክ ስህተት ነው።`,
            { parse_mode: 'HTML' }
        );
    }

    usedProofs.photos[uniqueKey] = {
        userId: String(ctx.from.id),
        method,
        usedAt: new Date().toISOString()
    };
    saveProofs();

    user.pendingDepositMethod = null;
    saveUsers();

    const caption = ctx.message.caption ? `\n📝 ማስታወሻ፦ ${ctx.message.caption}` : '';
    const usernameTag = ctx.from.username ? `@${ctx.from.username}` : 'No username';

    await ctx.reply(
        `📸 የ <b>${method}</b> ስክሪንሾትህ ተቀብለናል። አስተዳዳሪው በፎቶው ላይ ስሙ <b>Biniyam</b> እና ቁጥሩ <b>0912698277 / 1000161123726</b> መሆኑን ካረጋገጠ በኋላ ባላንስ ይጨምራል።`,
        { parse_mode: 'HTML' }
    );

    await notifyAdmin((adminId) =>
        ctx.telegram.sendPhoto(adminId, photo.file_id, {
            caption:
                `🔔 አዲስ Deposit Screenshot (${method})\n` +
                `👤 User ID: ${ctx.from.id}\n` +
                `📛 Name: ${ctx.from.first_name || 'User'} (${usernameTag})${caption}\n` +
                `⚠️ በስክሪንሾቱ ላይ Biniyam (0912698277 / 1000161123726) መሆኑን አረጋግጥ!\n\n` +
                `ባላንስ ለመጨመር፦ /credit ${ctx.from.id} <amount>`
        })
    );
});

// --- ለ Admin ባላንስ መጨመር ---
bot.command('credit', (ctx) => {
    if (!ADMIN_ID || String(ctx.from.id) !== ADMIN_ID) return;
    const parts = ctx.message.text.trim().split(/\s+/);
    const targetId = parts[1];
    const amount = Number(parts[2]);

    if (!targetId || !Number.isFinite(amount) || amount <= 0) {
        return ctx.reply('አጠቃቀም፦ /credit <userId> <amount>');
    }

    const targetUser = getUser(targetId);
    targetUser.mainWallet = Number((targetUser.mainWallet + amount).toFixed(2));
    saveUsers();

    ctx.reply(`✅ ለ User ${targetId} ${amount.toFixed(2)} ብር ወደ Main Wallet ገብቷል።`);
    ctx.telegram.sendMessage(
        targetId,
        `🎉 የ Deposit ክፍያህ ተረጋግጧል! <b>+${amount.toFixed(2)} ብር</b> ወደ Main Wallet ገብቷል።`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
});

bot.hears('💸 Withdraw', (ctx) => {
    const user = getUser(ctx.from.id);
    if (user.mainWallet < MIN_WITHDRAW) {
        return ctx.reply(
            `⚠️ ዝቅተኛው የማውጣት መጠን (Main Wallet) <b>${MIN_WITHDRAW} ብር</b> ነው።\n` +
            `🏦 Main Wallet: <b>${user.mainWallet.toFixed(2)} ብር</b>`,
            { parse_mode: 'HTML' }
        );
    }

    const amount = user.mainWallet;
    user.mainWallet = 0;
    saveUsers();
    ctx.reply(
        `✅ የ <b>${amount.toFixed(2)} ብር</b> የማውጣት ጥያቄ ተመዝግቧል።\n` +
        `🏦 አዲስ Main Wallet: <b>0.00 ብር</b>`,
        { parse_mode: 'HTML' }
    );
});

bot.hears('🎁 Invite', (ctx) => {
    const botUsername = ctx.botInfo && ctx.botInfo.username ? ctx.botInfo.username : 'Trusttbingobot';
    const refLink = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;
    ctx.reply(
        `🎁 <b>ጓደኞችህን ጋብዝ!</b>\n\n` +
        `የመጋበዣ ሊንክህ፦\n<code>${refLink}</code>`,
        { parse_mode: 'HTML' }
    );
});

bot.hears(['📖 How To Play', 'ℹ️ መረጃ (Info)'], (ctx) => {
    ctx.reply(
        `📖 <b>የአጫዋወት መመሪያ (Trust Bingo)</b>\n\n` +
        `1️⃣ <b>Play</b> በመጫን Stake (10 / 20 / 50 ብር) ምረጥ።\n` +
        `2️⃣ ካርቴላ ስትይዝ ደራሽ (80% pool) በራስ-ሰር ይጨምራል።\n` +
        `3️⃣ ክፍያ ወደ <b>Biniyam (0912698277 / 1000161123726)</b> ፈጽመህ ስክሪንሾት ወይም SMS ላክ፤ የተደጋገመ ወይም ለሌላ ሰው የተላከ SMS <b>ስህተት (Wrong)</b> ይላል።`,
        { parse_mode: 'HTML' }
    );
});

// --- SMS ኮፒ መቀበል፣ ማረጋገጥ እና ወደ Admin መላክ ---
bot.on('text', async (ctx, next) => {
    const user = getUser(ctx.from.id);
    const rawText = ctx.message.text.trim();

    if (!user.pendingDepositMethod) return next();

    const method = user.pendingDepositMethod;

    if (!looksLikePaymentSms(rawText)) {
        return ctx.reply(
            `❌ <b>ስህተት / Wrong!</b>\n` +
            `እባክህ ወደ <b>Biniyam (0912698277 / 1000161123726)</b> የከፈልክበትን <b>ትክክለኛ የ SMS መልዕክት</b> ወይም <b>ስክሪንሾት (Photo)</b> ላክ።`,
            { parse_mode: 'HTML' }
        );
    }

    if (!smsSentToOwner(rawText)) {
        return ctx.reply(
            `❌ <b>ስህተት / Wrong!</b>\n` +
            `ይህ የክፍያ SMS ወደ <b>Biniyam (0912698277 / 1000161123726)</b> የተላከ አይደለም! ለሌላ ሰው የተላከ ማስረጃ ተቀባይነት የለውም።`,
            { parse_mode: 'HTML' }
        );
    }

    const smsHash = hashText(rawText);
    if (usedProofs.sms[smsHash]) {
        return ctx.reply(
            `❌ <b>ስህተት / Wrong!</b>\n` +
            `ይህ የ SMS መልዕክት ቀድሞ ተልኳል! ተመሳሳይ SMS ደጋግሞ መላክ ስህተት ነው።`,
            { parse_mode: 'HTML' }
        );
    }

    usedProofs.sms[smsHash] = {
        userId: String(ctx.from.id),
        method,
        usedAt: new Date().toISOString()
    };
    saveProofs();

    user.pendingDepositMethod = null;
    saveUsers();

    const usernameTag = ctx.from.username ? `@${ctx.from.username}` : 'No username';

    await ctx.reply(
        `📩 የ <b>${method}</b> SMS ማስረጃህ ተመዝግቧል! ለማረጋገጫ በተጠባባሽ (Pending) ተይዟል።`,
        { parse_mode: 'HTML' }
    );

    await notifyAdmin((adminId) =>
        ctx.telegram.sendMessage(
            adminId,
            `🔔 አዲስ Deposit SMS (${method})\n` +
            `👤 User ID: ${ctx.from.id}\n` +
            `📛 Name: ${ctx.from.first_name || 'User'} (${usernameTag})\n` +
            `💬 SMS:\n${rawText}\n\n` +
            `ባላንስ ለመጨመር፦ /credit ${ctx.from.id} <amount>`
        )
    );
});

// --- Mini App REST API ---
app.get('/api/state', (req, res) => {
    const userId = String(req.query.userId || 'guest');
    const stake = [10, 20, 50].includes(Number(req.query.stake)) ? Number(req.query.stake) : 10;
    const user = getUser(userId);
    res.json({
        userId,
        mainWallet: user.mainWallet,
        playWallet: user.playWallet,
        balance: totalBalance(user),
        cartelaCount: CARTELA_COUNT,
        room: getRoomSummary(stake)
    });
});

app.post('/api/take-cartela', (req, res) => {
    const { userId = 'guest', stake = 10, cartelaId } = req.body || {};
    const s = [10, 20, 50].includes(Number(stake)) ? Number(stake) : 10;
    const id = parseInt(cartelaId, 10);

    if (isNaN(id) || id < 1 || id > CARTELA_COUNT) {
        return res.status(400).json({ error: 'Invalid cartela ID (1-300)' });
    }

    const room = rooms[s];
    const uid = String(userId);

    if (room.takenCartelas[id]) {
        if (room.takenCartelas[id] === uid) {
            return res.json({
                balance: totalBalance(getUser(uid)),
                room: getRoomSummary(s)
            });
        }
        return res.status(409).json({ error: `ካርቴላ #${id} ቀድሞ ተይዟል። ሌላ ምረጥ።` });
    }

    const user = getUser(uid);
    if (!spendFromWallets(user, s)) {
        return res.status(400).json({
            error: `በቂ ባላንስ የለም። የሚያስፈልገው፦ ${s} ብር፣ ያለህ፦ ${totalBalance(user)} ብር።`
        });
    }

    room.takenCartelas[id] = uid;

    res.json({
        balance: totalBalance(user),
        mainWallet: user.mainWallet,
        playWallet: user.playWallet,
        room: getRoomSummary(s)
    });
});

app.post('/api/start-game', (req, res) => {
    const { userId = 'guest', stake = 10, cartelaIds = [] } = req.body || {};
    const s = [10, 20, 50].includes(Number(stake)) ? Number(stake) : 10;
    const uid = String(userId);
    const room = rooms[s];

    const myIds = (Array.isArray(cartelaIds) ? cartelaIds : [])
        .map((n) => parseInt(n, 10))
        .filter((n) => room.takenCartelas[n] === uid);

    if (myIds.length === 0) {
        return res.status(400).json({ error: 'መጀመሪያ ቢያንስ አንድ ካርቴላ ያዝ (ተጫን)።' });
    }

    const summary = getRoomSummary(s);
    const derash = summary.derash;

    const pool = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    rooms[s] = createRoom(s);

    res.json({
        stake: s,
        takenCount: summary.takenCount,
        totalPool: summary.totalPool,
        derash,
        drawOrder: pool,
        boards: myIds.map((id) => ({ id, card: cartelas[id] }))
    });
});

app.post('/api/claim-win', (req, res) => {
    const { userId = 'guest', reward = 0 } = req.body || {};
    const prize = Number(reward);
    if (!Number.isFinite(prize) || prize <= 0 || prize > 100000) {
        return res.status(400).json({ error: 'Invalid reward amount' });
    }
    const user = getUser(String(userId));
    user.mainWallet = Number((user.mainWallet + prize).toFixed(2));
    saveUsers();
    res.json({
        balance: totalBalance(user),
        mainWallet: user.mainWallet,
        playWallet: user.playWallet
    });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Trust Bingo Server + Mini App listening on port ${PORT}`);
});

bot.launch();
console.log('Trust Bingo Bot is running... 🚀');
                                    
