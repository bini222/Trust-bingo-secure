const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const path = require('path');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

// የ Mini App ሊንክ (በ Render Environment Variables ውስጥ APP_URL ያስገቡ)
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const MIN_WITHDRAW = 1000;

// የተጫዋቾች Wallet እና ሁኔታ
// { userId: { mainWallet: 0, playWallet: 100, pendingDepositMethod: null } }
const users = {};

function getUser(userId) {
    if (!users[userId]) {
        users[userId] = {
            mainWallet: 0,
            playWallet: 100, // የመነሻ ቦነስ
            pendingDepositMethod: null
        };
    }
    return users[userId];
}

function totalBalance(user) {
    return Number((user.mainWallet + user.playWallet).toFixed(2));
}

function spendFromWallets(user, amount) {
    if (totalBalance(user) < amount) return false;
    let remaining = amount;

    if (user.playWallet >= remaining) {
        user.playWallet = Number((user.playWallet - remaining).toFixed(2));
        return true;
    }

    remaining = Number((remaining - user.playWallet).toFixed(2));
    user.playWallet = 0;
    user.mainWallet = Number((user.mainWallet - remaining).toFixed(2));
    return true;
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
        { start: 1, end: 15 },   // B
        { start: 16, end: 30 },  // I
        { start: 31, end: 45 },  // N
        { start: 46, end: 60 },  // G
        { start: 61, end: 75 }   // O
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

const CARTELA_COUNT = 300;
const cartelas = {};
for (let id = 1; id <= CARTELA_COUNT; id++) {
    cartelas[id] = buildCartela(id);
}

// --- ዋና ሜኑ ---
function getMainKeyboard() {
    const rows = [
        ['🎮 Play', '💰 Deposit'],
        ['💸 Withdraw', '💳 Check Balance'],
        ['🎁 Invite', '📖 How To Play']
    ];
    return Markup.keyboard(rows).resize();
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
        `• ከ <b>#1 እስከ #300</b> ካርቴላ መምረጥ`,
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
    ctx.reply(
        `💳 እባክህ ገንዘብ ለማስገባት የምትጠቀመውን አማራጭ ምረጥ፦`,
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
    const user = getUser(ctx.from.id);
    user.pendingDepositMethod = method;

    await ctx.answerCbQuery(`${method} ተመርጧል`);
    await ctx.reply(
        `✅ <b>${method}</b> ተመርጧል።\n` +
        `ማስገባት የምትፈልገውን የገንዘብ መጠን በቁጥር ጻፍ (ለምሳሌ፦ <code>100</code>)፦`,
        { parse_mode: 'HTML' }
    );
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
    ctx.reply(
        `✅ የ <b>${amount.toFixed(2)} ብር</b> የማውጣት ጥያቄ ተመዝግቧል።\n` +
        `🏦 አዲስ Main Wallet: <b>0.00 ብር</b>`,
        { parse_mode: 'HTML' }
    );
});

bot.hears('🎁 Invite', (ctx) => {
    const botUsername = ctx.botInfo && ctx.botInfo.username ? ctx.botInfo.username : 'TrustBingoBot';
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
        `1️⃣ <b>Play</b> በመጫን Mini App ን ክፈት።\n` +
        `2️⃣ Stake (10 / 20 / 50 ብር) እና ከ <b>#1 - #300</b> ካርቴላ ምረጥ።\n` +
        `3️⃣ ቁጥሮች ሲወጡ ካርቴላህን ተከታተል፤ ረድፍ፣ አምድ ወይም ዲያጎናል ሲሟላ <b>BINGO!</b> ታሸንፋለህ።`,
        { parse_mode: 'HTML' }
    );
});

// የተቀመጠ Deposit መጠን ሲገባ
bot.on('text', (ctx, next) => {
    const user = getUser(ctx.from.id);
    if (!user.pendingDepositMethod) return next();

    const raw = ctx.message.text.trim();
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
        return ctx.reply('⚠️ እባክህ ትክክለኛ የገንዘብ መጠን በቁጥር አስገባ (ለምሳሌ፦ 50)።');
    }

    const method = user.pendingDepositMethod;
    user.pendingDepositMethod = null;
    user.mainWallet = Number((user.mainWallet + amount).toFixed(2));

    ctx.reply(
        `✅ በ <b>${method}</b> የ <b>${amount.toFixed(2)} ብር</b> ገቢ ተመዝግቧል!\n` +
        `🏦 Main Wallet: <b>${user.mainWallet.toFixed(2)} ብር</b>\n` +
        `💰 Total Balance: <b>${totalBalance(user).toFixed(2)} ብር</b>`,
        { parse_mode: 'HTML' }
    );
});

// --- Mini App REST API ---
app.get('/api/state', (req, res) => {
    const userId = String(req.query.userId || 'guest');
    const user = getUser(userId);
    res.json({
        userId,
        mainWallet: user.mainWallet,
        playWallet: user.playWallet,
        balance: totalBalance(user),
        cartelaCount: CARTELA_COUNT
    });
});

app.get('/api/cartela/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1 || id > CARTELA_COUNT) {
        return res.status(400).json({ error: 'Invalid cartela ID (1-300)' });
    }
    res.json({ id, card: cartelas[id] });
});

app.post('/api/start-game', (req, res) => {
    const { userId = 'guest', stake = 10, cartelaIds = [] } = req.body || {};
    const validStakes = [10, 20, 50];
    const chosenStake = validStakes.includes(Number(stake)) ? Number(stake) : 10;

    const cleanIds = [...new Set(
        (Array.isArray(cartelaIds) ? cartelaIds : [])
            .map((n) => parseInt(n, 10))
            .filter((n) => n >= 1 && n <= CARTELA_COUNT)
    )];

    if (cleanIds.length === 0) {
        return res.status(400).json({ error: 'ቢያንስ አንድ ካርቴላ (#1-#300) ምረጥ።' });
    }

    const totalCost = chosenStake * cleanIds.length;
    const user = getUser(String(userId));

    if (!spendFromWallets(user, totalCost)) {
        return res.status(400).json({
            error: `በቂ ባላንስ የለም። የሚያስፈልገው፦ ${totalCost} ብር፣ ያለህ፦ ${totalBalance(user)} ብር።`
        });
    }

    const pool = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    res.json({
        balance: totalBalance(user),
        mainWallet: user.mainWallet,
        playWallet: user.playWallet,
        stake: chosenStake,
        totalCost,
        reward: totalCost * 4,
        drawOrder: pool,
        boards: cleanIds.map((id) => ({ id, card: cartelas[id] }))
    });
});

app.post('/api/claim-win', (req, res) => {
    const { userId = 'guest', reward = 0 } = req.body || {};
    const prize = Number(reward);
    if (!Number.isFinite(prize) || prize <= 0 || prize > 50000) {
        return res.status(400).json({ error: 'Invalid reward amount' });
    }
    const user = getUser(String(userId));
    user.mainWallet = Number((user.mainWallet + prize).toFixed(2));
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
           
