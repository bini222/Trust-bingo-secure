const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION:', reason);
});

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

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PROOFS_FILE = path.join(DATA_DIR, 'used_proofs.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw || !raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to read ' + filePath + ':', e.message);
        return fallback;
    }
}

function saveJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Failed to save ' + filePath + ':', e.message);
    }
}

let users = loadJson(USERS_FILE, {});
if (!users || typeof users !== 'object' || Array.isArray(users)) users = {};

let usedProofs = loadJson(PROOFS_FILE, { photos: {}, sms: {} });
if (!usedProofs || typeof usedProofs !== 'object') usedProofs = { photos: {}, sms: {} };
if (!usedProofs.photos) usedProofs.photos = {};
if (!usedProofs.sms) usedProofs.sms = {};

let adminPendingCreditTarget = null;

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

function smsSentToOwner(text) {
    const t = normalizeText(text);
    const compact = t.replace(/[\s\-+*]/g, '');

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

function formatSenderTag(from) {
    if (!from) return 'User (No username)';
    const name = from.first_name || 'User';
    const tag = from.username ? '@' + from.username : 'No username';
    return name + ' (' + tag + ')';
}

async function notifyAdmin(fn) {
    if (!ADMIN_ID) return;
    try {
        await fn(ADMIN_ID);
    } catch (err) {
        console.error('Admin notification error:', err.message);
    }
}

function creditUserWallet(targetId, amount) {
    const cleanId = String(targetId).trim();
    const num = Number(amount);
    if (!cleanId || !Number.isFinite(num) || num <= 0) return null;

    const targetUser = getUser(cleanId);
    targetUser.mainWallet = Number((targetUser.mainWallet + num).toFixed(2));
    saveUsers();
    return targetUser;
}

function getUser(userId) {
    const key = String(userId);
    if (!users[key]) {
        users[key] = {
            mainWallet: 0,
            playWallet: 100,
            pendingDepositMethod: null,
            pendingWithdrawMethod: null
        };
        saveUsers();
    }
    if (users[key].pendingWithdrawMethod === undefined) {
        users[key].pendingWithdrawMethod = null;
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
            [Markup.button.webApp('🚀 Open Trust Bingo Mini App', APP_URL + '?userId=' + userId)]
        ]);
    }
    return Markup.inlineKeyboard([
        [Markup.button.callback('ℹ️ APP_URL ያዋቅሩ', 'need_app_url')]
    ]);
}

bot.start((ctx) => {
    const user = getUser(ctx.from.id);
    user.pendingDepositMethod = null;
    user.pendingWithdrawMethod = null;
    saveUsers();
    ctx.reply(
        '🎉 እንኳን ወደ <b>Trust Bingo</b> በደህና መጣህ!\n\n' +
        '🏦 Main Wallet: <b>' + user.mainWallet.toFixed(2) + ' ብር</b>\n' +
        '🎁 Play Wallet: <b>' + user.playWallet.toFixed(2) + ' ብር</b>\n' +
        '💰 Total Balance: <b>' + totalBalance(user).toFixed(2) + ' ብር</b>\n\n' +
        'ከታች ካሉት አዝራሮች አንዱን ምረጥ፦',
        { parse_mode: 'HTML', ...getMainKeyboard() }
    );
});

bot.hears(['🎮 Play', '🎮 Play Game'], (ctx) => {
    ctx.reply(
        '🎮 <b>Trust Bingo Mini App</b> ለመክፈት ከታች ያለውን ቁልፍ ተጫን፦\n' +
        '• Stake መምረጥ (10 / 20 / 50 ብር)\n' +
        '• ካርቴላ ሲያዝ ደራሽ (80% pool) በራስ-ሰር ይጨምራል',
        { parse_mode: 'HTML', ...getPlayReplyMarkup(ctx.from.id) }
    );
});

bot.action('need_app_url', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply(
        '⚠️ በ Render Environment Variables ውስጥ <code>APP_URL</code> (የ https://...onrender.com ሊንክህን) አስገባ።',
        { parse_mode: 'HTML' }
    );
});

bot.hears(['💳 Check Balance', '💰 ባላንስ (Balance)'], (ctx) => {
    const user = getUser(ctx.from.id);
    ctx.reply(
        '💰 <b>BALANCE SUMMARY</b> 💰\n\n' +
        '🏦 Main Wallet: <b>' + user.mainWallet.toFixed(2) + '</b>\n' +
        '🎁 Play Wallet: <b>' + user.playWallet.toFixed(2) + '</b>\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        '💵 Total Balance: <b>' + totalBalance(user).toFixed(2) + ' ብር</b>',
        { parse_mode: 'HTML' }
    );
});

bot.hears('💰 Deposit', (ctx) => {
    const user = getUser(ctx.from.id);
    user.pendingDepositMethod = null;
    user.pendingWithdrawMethod = null;
    saveUsers();
    ctx.reply(
        '💳 ገንዘብ ለማስገባት የመክፈያ ዘዴ ምረጥ፦',
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
    user.pendingWithdrawMethod = null;
    saveUsers();

    await ctx.answerCbQuery(method + ' ተመርጧል');
    await ctx.reply(
        '✅ <b>' + info.label + ' Deposit</b>\n\n' +
        '📌 አካውንት / ስልክ፦ <code>' + info.account + '</code>\n' +
        '👤 ስም፦ <b>' + info.holder + '</b>\n\n' +
        'ክፍያውን ወደ <b>' + info.holder + ' (' + info.account + ')</b> ከፈጸምክ በኋላ <b>የክፍያ ስክሪንሾት (Photo)</b> ወይም <b>የ SMS መልዕክት (SMS Copy)</b> ላክ፦',
        { parse_mode: 'HTML' }
    );
});

bot.action(/^admin_credit_(\d+)$/, async (ctx) => {
    if (!ADMIN_ID || String(ctx.from.id) !== ADMIN_ID) {
        return ctx.answerCbQuery('Admin only', { show_alert: true });
    }
    const targetUserId = ctx.match[1];
    adminPendingCreditTarget = targetUserId;
    await ctx.answerCbQuery('User ' + targetUserId + ' ተመርጧል');
    await ctx.reply(
        '💳 ለ User ID <code>' + targetUserId + '</code> የምትጨምረውን የብር መጠን ጻፍ (ለምሳሌ፦ <code>100</code>)፦',
        { parse_mode: 'HTML' }
    );
});

bot.on('photo', async (ctx) => {
    const user = getUser(ctx.from.id);
    const method = user.pendingDepositMethod || 'Telebirr / CBE';
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const uniqueKey = photo.file_unique_id;

    if (usedProofs.photos[uniqueKey]) {
        return ctx.reply(
            '❌ <b>ስህተት / Wrong!</b>\nይህ ስክሪንሾት ቀድሞ ተልኳል! ተመሳሳይ ስክሪንሾት እንደገና መላክ ስህተት ነው።',
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

    const caption = ctx.message.caption ? '\n📝 ማስታወሻ፦ ' + ctx.message.caption : '';
    const senderInfo = formatSenderTag(ctx.from);

    await ctx.reply(
        '📸 የ ' + method + ' ስክሪንሾትህ ተቀብለናል። አስተዳዳሪው ካረጋገጠ በኋላ ባላንስ ይጨምራል።'
    );

    await notifyAdmin((adminId) =>
        ctx.telegram.sendPhoto(adminId, photo.file_id, {
            caption:
                '🔔 አዲስ Deposit Screenshot (' + method + ')\n' +
                '👤 User ID: ' + ctx.from.id + '\n' +
                '📛 Name: ' + senderInfo + caption,
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💳 Credit User (' + ctx.from.id + ')', 'admin_credit_' + ctx.from.id)]
            ])
        })
    );
});

bot.command('credit', (ctx) => {
    if (!ADMIN_ID || String(ctx.from.id) !== ADMIN_ID) return;
    const parts = ctx.message.text.trim().split(/\s+/);
    const targetId = parts[1];
    const amount = Number(parts[2]);

    if (!targetId || !Number.isFinite(amount) || amount <= 0) {
        return ctx.reply('አጠቃቀም፦ /credit <userId> <amount>');
    }

    const updatedUser = creditUserWallet(targetId, amount);
    ctx.reply(
        '✅ ለ User ' + targetId + ' +' + amount.toFixed(2) + ' ብር ወደ Main Wallet ተጨምሯል። አዲስ Main Wallet፦ ' + updatedUser.mainWallet.toFixed(2) + ' ብር'
    );
    ctx.telegram.sendMessage(
        targetId,
        '🎉 የ Deposit ክፍያህ ተረጋግጧል! +' + amount.toFixed(2) + ' ብር ወደ Main Wallet ገብቷል።'
    ).catch(() => {});
});

bot.hears('💸 Withdraw', (ctx) => {
    const user = getUser(ctx.from.id);
    user.pendingDepositMethod = null;
    user.pendingWithdrawMethod = null;
    saveUsers();

    if (user.mainWallet < MIN_WITHDRAW) {
        return ctx.reply(
            '⚠️ ዝቅተኛው የማውጣት መጠን (Main Wallet) ' + MIN_WITHDRAW + ' ብር ነው። Main Wallet: ' + user.mainWallet.toFixed(2) + ' ብር'
        );
    }

    ctx.reply(
        '💸 ገንዘቡን ለመቀበል የምትፈልገውን መንገድ ምረጥ፦\n🏦 የሚወጣው Main Wallet፦ ' + user.mainWallet.toFixed(2) + ' ብር',
        Markup.inlineKeyboard([
            [
                Markup.button.callback('📱 Telebirr', 'withdraw_Telebirr'),
                Markup.button.callback('🏦 CBE', 'withdraw_CBE')
            ]
        ])
    );
});

bot.action(/^withdraw_(Telebirr|CBE)$/, async (ctx) => {
    const method = ctx.match[1];
    const user = getUser(ctx.from.id);

    if (user.mainWallet < MIN_WITHDRAW) {
        await ctx.answerCbQuery('በቂ Main Wallet የለም', { show_alert: true });
        return;
    }

    user.pendingWithdrawMethod = method;
    saveUsers();

    await ctx.answerCbQuery(method + ' ተመርጧል');
    const promptDetail =
        method === 'Telebirr'
            ? 'የ Telebirr ስምህን እና ስልክ ቁጥርህን ጻፍ (ለምሳሌ፦ Abebe Kebede - 0911223344)፦'
            : 'የ CBE ስምህን እና አካውንት ቁጥርህን ጻፍ (ለምሳሌ፦ Abebe Kebede - 1000123456789)፦';

    await ctx.reply('✅ ' + method + ' Withdraw\n' + promptDetail);
});

bot.hears('🎁 Invite', (ctx) => {
    const botUsername = ctx.botInfo && ctx.botInfo.username ? ctx.botInfo.username : 'Trusttbingobot';
    const refLink = 'https://t.me/' + botUsername + '?start=ref_' + ctx.from.id;
    ctx.reply('🎁 ጓደኞችህን ጋብዝ!\n\n' + refLink);
});

bot.hears(['📖 How To Play', 'ℹ️ መረጃ (Info)'], (ctx) => {
    ctx.reply(
        '📖 የአጫዋወት መመሪያ (Trust Bingo)\n\n' +
        '1️⃣ Play በመጫን Stake (10 / 20 / 50 ብር) ምረጥ።\n' +
        '2️⃣ ካርቴላ ስትይዝ ደራሽ (80% pool) በራስ-ሰር ይጨምራል።\n' +
        '3️⃣ ክፍያ ወደ Biniyam (0912698277 / 1000161123726) ፈጽመህ ስክሪንሾት ወይም SMS ላክ፤ Withdraw ስትጠይቅ ስም እና ቁጥር/አካውንት ጻፍ።'
    );
});

bot.on('text', async (ctx, next) => {
    const senderId = String(ctx.from.id);
    const rawText = ctx.message.text.trim();

    if (ADMIN_ID && senderId === ADMIN_ID && adminPendingCreditTarget) {
        const amount = Number(rawText);
        const targetId = adminPendingCreditTarget;
        adminPendingCreditTarget = null;

        if (!Number.isFinite(amount) || amount <= 0) {
            return ctx.reply('⚠️ እባክህ ትክክለኛ የብር መጠን በቁጥር አስገባ (ለምሳሌ፦ 100)።');
        }

        const updatedUser = creditUserWallet(targetId, amount);
        await ctx.reply(
            '✅ ለ User ' + targetId + ' +' + amount.toFixed(2) + ' ብር ወደ Main Wallet ተጨምሯል። አዲስ Main Wallet፦ ' + updatedUser.mainWallet.toFixed(2) + ' ብር'
        );
        ctx.telegram.sendMessage(
            targetId,
            '🎉 የ Deposit ክፍያህ ተረጋግጧል! +' + amount.toFixed(2) + ' ብር ወደ Main Wallet ገብቷል።'
        ).catch(() => {});
        return;
    }

    const user = getUser(senderId);

    if (user.pendingWithdrawMethod) {
        if (rawText.length < 4) {
            return ctx.reply('⚠️ እባክህ ስምህን እና የ Telebirr ስልክ ወይም የ CBE አካውንት ቁጥር በግልጽ ጻፍ።');
        }
        if (user.mainWallet < MIN_WITHDRAW) {
            user.pendingWithdrawMethod = null;
            saveUsers();
            return ctx.reply('⚠️ በቂ Main Wallet የለም (ዝቅተኛው ' + MIN_WITHDRAW + ' ብር ነው)።');
        }

        const method = user.pendingWithdrawMethod;
        const withdrawAmount = Number(user.mainWallet.toFixed(2));
        user.mainWallet = 0;
        user.pendingWithdrawMethod = null;
        saveUsers();

        const senderInfo = formatSenderTag(ctx.from);

        await ctx.reply(
            '✅ የ ' + withdrawAmount.toFixed(2) + ' ብር የ Withdraw ጥያቄህ በ ' + method + ' ተመዝግቧል!\n' +
            '📌 መረጃ፦ ' + rawText + '\n' +
            '🏦 ቀሪ Main Wallet፦ 0.00 ብር'
        );

        await notifyAdmin((adminId) =>
            ctx.telegram.sendMessage(
                adminId,
                '💸 አዲስ Withdraw ጥያቄ (' + method + ')\n\n' +
                '👤 User ID: ' + ctx.from.id + '\n' +
                '📛 Name: ' + senderInfo + '\n' +
                '💵 የሚወጣ መጠን: ' + withdrawAmount.toFixed(2) + ' ብር\n' +
                '🏦 የመቀበያ ዝርዝር (' + method + '): ' + rawText
            )
        );
        return;
    }

    if (!user.pendingDepositMethod) return next();

    const method = user.pendingDepositMethod;

    if (!looksLikePaymentSms(rawText)) {
        return ctx.reply(
            '❌ ስህተት / Wrong!\nእባክህ ወደ Biniyam (0912698277 / 1000161123726) የከፈልክበትን ትክክለኛ የ SMS መልዕክት ወይም ስክሪንሾት (Photo) ላክ።'
        );
    }

    if (!smsSentToOwner(rawText)) {
        return ctx.reply(
            '❌ ስህተት / Wrong!\nይህ የክፍያ SMS ወደ Biniyam (0912698277 / 1000161123726) የተላከ አይደለም! ለሌላ ሰው የተላከ ማስረጃ ተቀባይነት የለውም።'
        );
    }

    const smsHash = hashText(rawText);
    if (usedProofs.sms[smsHash]) {
        return ctx.reply(
            '❌ ስህተት / Wrong!\nይህ የ SMS መልዕክት ቀድሞ ተልኳል! ተመሳሳይ SMS ደጋግሞ መላክ ስህተት ነው።'
        );
    }

    usedProofs.sms[smsHash] = {
        userId: senderId,
        method,
        usedAt: new Date().toISOString()
    };
    saveProofs();

    user.pendingDepositMethod = null;
    saveUsers();

    const senderInfo = formatSenderTag(ctx.from);

    await ctx.reply('📩 የ ' + method + ' SMS ማስረጃህ ተመዝግቧል! ለማረጋገጫ በተጠባባሽ (Pending) ተይዟል።');

    await notifyAdmin((adminId) =>
        ctx.telegram.sendMessage(
            adminId,
            '🔔 አዲስ Deposit SMS (' + method + ')\n' +
            '👤 User ID: ' + ctx.from.id + '\n' +
            '📛 Name: ' + senderInfo + '\n' +
            '💬 SMS:\n' + rawText,
            Markup.inlineKeyboard([
                [Markup.button.callback('💳 Credit User (' + ctx.from.id + ')', 'admin_credit_' + ctx.from.id)]
            ])
        )
    );
});

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

  
