const { Telegraf, Markup } = require('telegraf');
const http = require('http');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- የጨዋታ እና የተጫዋቾች መረጃ ---
const ENTRY_FEE = 10;     // የአንድ ጨዋታ መግቢያ (ብር)
const WIN_REWARD = 50;    // የማሸነፊያ ሽልማት (ብር)
const MIN_WITHDRAW = 1000;// ዝቅተኛ የማውጣት መጠን (ብር)
const DRAW_INTERVAL = 3000; // ቁጥር የሚወጣበት ጊዜ (3 ሰከንድ)

const users = {}; // { userId: { balance: 100, selectedCartela: null } }
const games = {}; // { userId: { cartelaId, card, drawn, active, interval } }

function getUser(userId) {
    if (!users[userId]) {
        users[userId] = {
            balance: 100, // የምዝገባ ቦነስ
            selectedCartela: null
        };
    }
    return users[userId];
}

// --- Seeded Random Helper ለ 300 ካርቴላዎች ---
// እያንዳንዱ ካርቴላ (#1 - #300) የተወሰነ እና የተረጋጋ ፍርግርግ እንዲኖረው
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

// 300 ካርቴላዎችን ማመንጨት (#1 እስከ #300)
const CARTELA_COUNT = 300;
const cartelas = {};

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

    // ወደ 5x5 ረድፎች መቀየር
    const card = [];
    for (let r = 0; r < 5; r++) {
        const row = [];
        for (let c = 0; c < 5; c++) {
            if (r === 2 && c === 2) {
                row.push('FREE');
            } else {
                row.push(cols[c][r]);
            }
        }
        card.push(row);
    }
    return card;
}

for (let id = 1; id <= CARTELA_COUNT; id++) {
    cartelas[id] = buildCartela(id);
}

// የካርቴላ ማሳያ ቅርጸት (HTML)
function formatCard(cartelaId, card, markedNumbers) {
    let text = `🎫 <b>ካርቴላ #${cartelaId}</b> (B - I - N - G - O)\n\n`;
    for (let r = 0; r < 5; r++) {
        const rowText = card[r].map((cell) => {
            if (cell === 'FREE') return '🟩';
            if (markedNumbers.includes(cell)) return `✅${cell}`;
            return `${cell}`;
        }).join(' | ');
        text += rowText + '\n';
    }
    return text;
}

function checkWin(card, drawn) {
    // ረድፎች
    for (let r = 0; r < 5; r++) {
        if (card[r].every((num) => num === 'FREE' || drawn.includes(num))) return true;
    }
    // አምዶች
    for (let c = 0; c < 5; c++) {
        if (card.every((row) => row[c] === 'FREE' || drawn.includes(row[c]))) return true;
    }
    // ዋና ዲያጎናል
    if (card.every((row, i) => row[i] === 'FREE' || drawn.includes(row[i]))) return true;
    // ተቃራኒ ዲያጎናል
    if (card.every((row, i) => row[4 - i] === 'FREE' || drawn.includes(row[4 - i]))) return true;

    return false;
}

function stopExistingGame(userId) {
    if (games[userId]) {
        games[userId].active = false;
        if (games[userId].interval) {
            clearInterval(games[userId].interval);
            games[userId].interval = null;
        }
    }
}

// --- ሜኑዎች ---
const mainMenu = Markup.keyboard([
    ['🎮 ጨዋታ ጀምር (Play)', '🎟 ካርቴላ ምረጥ (1-300)'],
    ['💰 ባላንስ (Balance)', '💸 ገንዘብ አውጣ (Withdraw)'],
    ['ℹ️ መረጃ (Info)']
]).resize();

const inGameMenu = Markup.keyboard([
    ['⏹ ጨዋታ አቁም (Stop)'],
    ['💰 ባላንስ (Balance)']
]).resize();

bot.start((ctx) => {
    const user = getUser(ctx.from.id);
    const chosenText = user.selectedCartela ? `#${user.selectedCartela}` : 'አልተመረጠም (በራስ-ሰር ይመረጣል)';
    ctx.reply(
        `እንኳን ወደ <b>Trust Bingo</b> በደህና መጣህ! 🎉\n\n` +
        `💰 ባላንስ፦ <b>${user.balance} ብር</b>\n` +
        `🎟 የተመረጠ ካርቴላ፦ <b>${chosenText}</b>\n\n` +
        `ከታች ካሉት ቁልፎች ውስጥ ምረጥ፦`,
        { parse_mode: 'HTML', ...mainMenu }
    );
});

// --- ካርቴላ መምረጥ (1 - 300) ---
bot.hears('🎟 ካርቴላ ምረጥ (1-300)', async (ctx) => {
    const sampleIds = [1, 7, 21, 50, 100, 150, 222, 300];
    const buttons = sampleIds.map((id) => Markup.button.callback(`#${id}`, `pick_cartela_${id}`));
    const rows = [
        buttons.slice(0, 4),
        buttons.slice(4, 8)
    ];

    await ctx.reply(
        `🎟 ከ <b>300 ካርቴላዎች (#1 - #300)</b> ውስጥ ምረጥ፦\n\n` +
        `• ከታች ካሉት ፈጣን ቁጥሮች አንዱን ተጫን፣ ወይም\n` +
        `• በቀጥታ ከ <b>1 እስከ 300</b> ያለ ቁጥር ጻፍ (ለምሳሌ፦ <code>45</code> ወይም <code>128</code>)።`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
    );
});

bot.action(/^pick_cartela_(\d+)$/, async (ctx) => {
    const cartelaId = parseInt(ctx.match[1], 10);
    if (cartelaId < 1 || cartelaId > CARTELA_COUNT) {
        return ctx.answerCbQuery('የተሳሳተ የካርቴላ ቁጥር');
    }

    const user = getUser(ctx.from.id);
    user.selectedCartela = cartelaId;

    await ctx.answerCbQuery(`ካርቴላ #${cartelaId} ተመርጧል!`);
    await ctx.reply(
        formatCard(cartelaId, cartelas[cartelaId], []),
        { parse_mode: 'HTML', ...mainMenu }
    );
});

// ተጠቃሚ 1-300 መካከል ቁጥር በቀጥታ ሲጽፍ (ጨዋታ ውስጥ ካልሆነ)
bot.on('text', async (ctx, next) => {
    const raw = ctx.message.text.trim();
    if (!/^\d+$/.test(raw)) return next();

    const num = parseInt(raw, 10);
    if (num >= 1 && num <= CARTELA_COUNT) {
        const activeGame = games[ctx.from.id] && games[ctx.from.id].active;
        if (activeGame) {
            return ctx.reply('ጨዋታ በሂደት ላይ ስለሆነ በመጀመሪያ ጨዋታውን አቁም።', { ...inGameMenu });
        }

        const user = getUser(ctx.from.id);
        user.selectedCartela = num;
        return ctx.reply(
            `✅ <b>ካርቴላ #${num}</b> ተመርጧል!\n\n` + formatCard(num, cartelas[num], []),
            { parse_mode: 'HTML', ...mainMenu }
        );
    }
    return next();
});

// --- ጨዋታ መጀመር ---
bot.hears('🎮 ጨዋታ ጀምር (Play)', async (ctx) => {
    const userId = ctx.from.id;
    const user = getUser(userId);

    // ቀድሞ የሚሰራ ጨዋታ ካለ ማቆም
    stopExistingGame(userId);

    // ባላንስ መፈተሽ
    if (user.balance < ENTRY_FEE) {
        return ctx.reply(
            `❌ በቂ ባላንስ የለህም።\n` +
            `የጨዋታ መግቢያ፦ <b>${ENTRY_FEE} ብር</b>\n` +
            `ያለህ ባላንስ፦ <b>${user.balance} ብር</b>`,
            { parse_mode: 'HTML', ...mainMenu }
        );
    }

    // የመግቢያ ክፍያ መቀነስ
    user.balance -= ENTRY_FEE;

    // ካርቴላ መምረጥ (ካልተመረጠ ከ1-300 በዘፈቀደ ይመረጣል)
    const cartelaId = user.selectedCartela || (Math.floor(Math.random() * CARTELA_COUNT) + 1);
    const playerCard = cartelas[cartelaId];
    const drawnNumbers = [];

    const gameState = {
        cartelaId,
        card: playerCard,
        drawn: drawnNumbers,
        active: true,
        interval: null
    };
    games[userId] = gameState;

    await ctx.reply(
        `🎮 ጨዋታ ተጀምሯል! (-${ENTRY_FEE} ብር | ቀሪ ባላንስ፦ <b>${user.balance} ብር</b>)\n\n` +
        formatCard(cartelaId, playerCard, drawnNumbers),
        { parse_mode: 'HTML', ...inGameMenu }
    );
    await ctx.reply('ቁጥሮች መውጣት ጀመሩ! 🎲');

    gameState.interval = setInterval(async () => {
        if (!gameState.active || games[userId] !== gameState) {
            clearInterval(gameState.interval);
            return;
        }

        if (gameState.drawn.length >= 75) {
            clearInterval(gameState.interval);
            gameState.active = false;
            return ctx.reply('ሁሉም 75 ቁጥሮች ወጥተዋል። ጨዋታው ተጠናቋል።', { ...mainMenu });
        }

        let newNum;
        do {
            newNum = Math.floor(Math.random() * 75) + 1;
        } while (gameState.drawn.includes(newNum));

        gameState.drawn.push(newNum);

        try {
            await ctx.reply(
                `📢 የወጣ ቁጥር፦ <b>${newNum}</b>\n\n` +
                formatCard(gameState.cartelaId, gameState.card, gameState.drawn),
                { parse_mode: 'HTML' }
            );

            if (checkWin(gameState.card, gameState.drawn)) {
                clearInterval(gameState.interval);
                gameState.active = false;
                user.balance += WIN_REWARD;

                await ctx.reply(
                    `🎉 <b>BINGO!</b> አሸንፈሃል! 🎉\n` +
                    `🏆 ሽልማት፦ <b>+${WIN_REWARD} ብር</b>\n` +
                    `💰 አዲስ ባላንስ፦ <b>${user.balance} ብር</b>\n\n` +
                    `እንደገና ለመጫወት "🎮 ጨዋታ ጀምር (Play)" ተጫን።`,
                    { parse_mode: 'HTML', ...mainMenu }
                );
            }
        } catch (err) {
            console.error('Error sending draw update:', err.message);
            clearInterval(gameState.interval);
            gameState.active = false;
        }
    }, DRAW_INTERVAL);
});

// --- ጨዋታ ማቆም ---
bot.hears('⏹ ጨዋታ አቁም (Stop)', async (ctx) => {
    const userId = ctx.from.id;
    stopExistingGame(userId);
    await ctx.reply('⏹ ጨዋታው ተቋርጧል።', { ...mainMenu });
});

// --- ባላንስ ---
bot.hears('💰 ባላንስ (Balance)', (ctx) => {
    const user = getUser(ctx.from.id);
    ctx.reply(
        `💰 ያለህ ባላንስ፦ <b>${user.balance} ብር</b>`,
        { parse_mode: 'HTML' }
    );
});

// --- ገንዘብ ማውጣት ---
bot.hears('💸 ገንዘብ አውጣ (Withdraw)', (ctx) => {
    const user = getUser(ctx.from.id);
    if (user.balance < MIN_WITHDRAW) {
        return ctx.reply(
            `⚠️ ዝቅተኛው የማውጣት መጠን <b>${MIN_WITHDRAW} ብር</b> ነው።\n` +
            `ያለህ ባላንስ፦ <b>${user.balance} ብር</b> ነው።`,
            { parse_mode: 'HTML' }
        );
    }

    const amount = user.balance;
    user.balance = 0;
    ctx.reply(
        `✅ የ <b>${amount} ብር</b> የማውጣት ጥያቄ ተመዝግቧል።\n` +
        `አዲስ ባላንስ፦ <b>0 ብር</b>።`,
        { parse_mode: 'HTML' }
    );
});

// --- መረጃ ---
bot.hears('ℹ️ መረጃ (Info)', (ctx) => {
    ctx.reply(
        `ℹ️ <b>Trust Bingo</b>\n` +
        `• አጠቃላይ ካርቴላዎች፦ <b>300 (#1 - #300)</b>\n` +
        `• የጨዋታ መግቢያ፦ <b>${ENTRY_FEE} ብር</b>\n` +
        `• የማሸነፊያ ሽልማት፦ <b>${WIN_REWARD} ብር</b>\n` +
        `• ዝቅተኛ ማውጫ፦ <b>${MIN_WITHDRAW} ብር</b>`,
        { parse_mode: 'HTML' }
    );
});

bot.launch();
console.log('Trust Bingo Bot (300 Cartelas) is running... 🚀');

// ለ Render የድረ-ገጽ ሰርቨር
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Trust Bingo Bot is running!');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
