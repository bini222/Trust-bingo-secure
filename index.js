const { Telegraf, Markup } = require('telegraf');
const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ቶከኑ ከ Environment Variable ይመጣል (ደህንነቱ የተጠበቀ)
const bot = new Telegraf(process.env.BOT_TOKEN);

// --- የቢንጎ ጨዋታ ሎጂክ ---
// የተጫዋች ካርዶችን እና የጨዋታ ሁኔታን ለማስቀመጥ
const games = {};

function generateCard() {
    let card = [];
    let pool = Array.from({length: 75}, (_, i) => i + 1);
    pool.sort(() => Math.random() - 0.5);
    let index = 0;
    for (let r = 0; r < 5; r++) {
        let row = [];
        for (let c = 0; c < 5; c++) {
            if (r === 2 && c === 2) row.push('FREE');
            else row.push(pool[index++]);
        }
        card.push(row);
    }
    return card;
}

function formatCard(card, markedNumbers) {
    let text = "🎫 **የእርስዎ የቢንጎ ካርድ**\n\n";
    for (let r = 0; r < 5; r++) {
        text += card[r].map(num => {
            if (num === 'FREE') return '🟩';
            return markedNumbers.includes(num) ? `[${num}]` : ` ${num} `;
        }).join(" | ") + "\n";
    }
    return text;
}

const mainMenu = Markup.keyboard([
    ['🎮 ጨዋታ ጀምር (Play)', '💰 ባላንስ (Balance)'],
    ['💸 ገንዘብ አውጣ (Withdraw)', 'ℹ️ መረጃ (Info)']
]).resize();

bot.start((ctx) => {
    ctx.reply('እንኳን ወደ Trust Bingo በደህና መጣህ! 🎉\n\nከታች ካሉት ቁልፎች ውስጥ ምረጥ፦', mainMenu);
});

// --- ጨዋታውን መጀመር ---
bot.hears('🎮 ጨዋታ ጀምር (Play)', async (ctx) => {
    const userId = ctx.from.id;
    
    // አዲስ ካርድ መፍጠር
    const playerCard = generateCard();
    const drawnNumbers = [];
    
    games[userId] = { card: playerCard, drawn: drawnNumbers, active: true };

    await ctx.reply(formatCard(playerCard, drawnNumbers), { parse_mode: 'Markdown' });
    await ctx.reply('ቁጥሮች መውጣት ጀመሩ! 🎲');

    // ቁጥሮችን በየ 3 ሰከንዱ ማውጣት
    let interval = setInterval(async () => {
        if (!games[userId] || !games[userId].active) {
            clearInterval(interval);
            return;
        }

        let newNum;
        do {
            newNum = Math.floor(Math.random() * 75) + 1;
        } while (games[userId].drawn.includes(newNum));

        games[userId].drawn.push(newNum);
        
        // የወጣውን ቁጥር ማሳወቅ
        await ctx.reply(`📢 የወጣ ቁጥር፦ **${newNum}**\n\n${formatCard(games[userId].card, games[userId].drawn)}`, { parse_mode: 'Markdown' });

        // የማሸነፍ ሁኔታን መፈተሽ (ለምሳሌ 5 ቁጥሮች በአንድ ረድፍ ከተሞሉ)
        if (checkWin(games[userId].card, games[userId].drawn)) {
            clearInterval(interval);
            games[userId].active = false;
            await ctx.reply('🎉 **BINGO!** አሸንፈሃል! 🎉\n\nእንደገና ለመጫወት "🎮 ጨዋታ ጀምር" ተጫን።');
        }
    }, 3000); // በየ 3 ሰከንዱ
});

function checkWin(card, drawn) {
    // ረድፎችን መፈተሽ
    for (let r = 0; r < 5; r++) {
        if (card[r].every(num => num === 'FREE' || drawn.includes(num))) return true;
    }
    // አምዶችን መፈተሽ
    for (let c = 0; c < 5; c++) {
        if (card.every(row => row[c] === 'FREE' || drawn.includes(row[c]))) return true;
    }
    // ዲያጎናል መፈተሽ
    if (card.every((row, i) => row[i] === 'FREE' || drawn.includes(row[i]))) return true;
    if (card.every((row, i) => row[4-i] === 'FREE' || drawn.includes(row[4-i]))) return true;
    
    return false;
}

bot.hears('💰 ባላንስ (Balance)', (ctx) => {
    ctx.reply('ያለህ ባላንስ፦ 100 ብር (የምዝገባ ቦነስ)');
});

bot.hears('💸 ገንዘብ አውጣ (Withdraw)', (ctx) => {
    ctx.reply('ዝቅተኛው የማውጣት መጠን 1000 ብር ነው።');
});

bot.hears('ℹ️ መረጃ (Info)', (ctx) => {
    ctx.reply('Trust Bingo - የቢንጎ ጨዋታ ቦት።');
});

bot.launch();
console.log('Trust Bingo Bot is running... 🚀');

// ለ Render የድረ-ገጽ ሰርቨር
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Trust Bingo Bot is running!');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
