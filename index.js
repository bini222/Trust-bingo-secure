const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

if (!process.env.BOT_TOKEN) {
  console.error('Missing BOT_TOKEN');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID).trim() : '8776479328';
const MIN_WITHDRAW = 1000;
const PAYOUT_RATE = 0.80;

const ACCOUNTS = {
  Telebirr: { label: 'Telebirr', account: '0912698277', holder: 'Biniyam' },
  CBE: { label: 'CBE', account: '1000161123726', holder: 'Biniyam' }
};

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PROOFS_FILE = path.join(DATA_DIR, 'used_proofs.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let users = readJson(USERS_FILE, {});
let proofs = readJson(PROOFS_FILE, { photos: {}, sms: {} });
if (!proofs.photos) proofs.photos = {};
if (!proofs.sms) proofs.sms = {};

let pendingCreditTarget = null;

function norm(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sha(s) {
  return crypto.createHash('sha256').update(norm(s)).digest('hex');
}

function isSms(text) {
  const t = norm(text);
  const keys = ['telebirr', 'birr', 'etb', 'cbe', 'transferred', 'paid to', 'transaction', 'ብር', 'ክፍያ', 'ተላልፏል', '2519', '09', '1000'];
  return t.length >= 20 && keys.some((k) => t.includes(k));
}

function isToBiniyam(text) {
  const t = norm(text);
  const c = t.replace(/[\s\-+*]/g, '');
  if (t.includes('to birhanu') || c.includes('2519****6699')) return false;
  if (/transferred\s+(?:etb|birr)?\s*[\d,.]+\s+(?:etb|birr)?\s*to\s+(?!biniyam\b)/i.test(text)) return false;
  if (/paid\s+(?:etb|birr)?\s*[\d,.]+\s+(?:etb|birr)?\s*to\s+(?!biniyam\b)/i.test(text)) return false;
  return ['0912698277', '251912698277', '1000161123726', 'to biniyam'].some((x) => c.includes(x.replace(/\s+/g, '')) || t.includes(x));
}

function getUser(id) {
  const k = String(id);
  if (!users[k]) {
    users[k] = { mainWallet: 0, playWallet: 100, depMethod: null, wdMethod: null };
    writeJson(USERS_FILE, users);
  }
  return users[k];
}

function totalBal(u) {
  return Number((Number(u.mainWallet || 0) + Number(u.playWallet || 0)).toFixed(2));
}

function spendBal(u, amt) {
  if (totalBal(u) < amt) return false;
  let rem = Number(amt);
  if (u.playWallet >= rem) {
    u.playWallet = Number((u.playWallet - rem).toFixed(2));
  } else {
    rem = Number((rem - u.playWallet).toFixed(2));
    u.playWallet = 0;
    u.mainWallet = Number((u.mainWallet - rem).toFixed(2));
  }
  writeJson(USERS_FILE, users);
  return true;
}

const CARTELA_COUNT = 300;
const rooms = {};
[10, 20, 50].forEach((s) => { rooms[s] = { stake: s, taken: {} }; });

function roomSummary(stake) {
  const r = rooms[stake] || { stake, taken: {} };
  const ids = Object.keys(r.taken).map(Number);
  const pool = ids.length * r.stake;
  return { stake: r.stake, takenCount: ids.length, takenCartelas: ids, totalPool: pool, derash: Math.floor(pool * PAYOUT_RATE) };
}

function seededRand(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function shuffleSeed(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeCartela(id) {
  const rand = seededRand(id * 7919 + 104729);
  const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
  const cols = ranges.map(([lo, hi]) => {
    const p = [];
    for (let n = lo; n <= hi; n++) p.push(n);
    return shuffleSeed(p, rand).slice(0, 5);
  });
  const card = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) row.push(r === 2 && c === 2 ? 'FREE' : cols[c][r]);
    card.push(row);
  }
  return card;
}

const cartelas = {};
for (let i = 1; i <= CARTELA_COUNT; i++) cartelas[i] = makeCartela(i);

function mainKb() {
  return Markup.keyboard([
    ['Play', 'Deposit'],
    ['Withdraw', 'Check Balance'],
    ['Invite', 'How To Play']
  ]).resize();
}

function playMarkup(userId) {
  if (APP_URL && APP_URL.startsWith('https://')) {
    return Markup.inlineKeyboard([[Markup.button.webApp('Open Trust Bingo', APP_URL + '?userId=' + userId)]]);
  }
  return Markup.inlineKeyboard([[Markup.button.callback('Set APP_URL', 'need_url')]]);
}

async function toAdmin(fn) {
  if (!ADMIN_ID) return;
  try { await fn(ADMIN_ID); } catch (e) { console.error('Admin msg err:', e.message); }
}

bot.start((ctx) => {
  const u = getUser(ctx.from.id);
  u.depMethod = null;
  u.wdMethod = null;
  writeJson(USERS_FILE, users);
  ctx.reply(
    'Welcome to Trust Bingo!\nMain Wallet: ' + u.mainWallet.toFixed(2) + ' Birr\nPlay Wallet: ' + u.playWallet.toFixed(2) + ' Birr\nTotal: ' + totalBal(u).toFixed(2) + ' Birr',
    mainKb()
  );
});

bot.hears(['Play', '🎮 Play', '🎮 Play Game'], (ctx) => {
  ctx.reply('Open Trust Bingo Mini App:', playMarkup(ctx.from.id));
});

bot.action('need_url', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('Add APP_URL in Render Environment Variables.');
});

bot.hears(['Check Balance', '💳 Check Balance'], (ctx) => {
  const u = getUser(ctx.from.id);
  ctx.reply('Main Wallet: ' + u.mainWallet.toFixed(2) + ' Birr\nPlay Wallet: ' + u.playWallet.toFixed(2) + ' Birr\nTotal Balance: ' + totalBal(u).toFixed(2) + ' Birr');
});

bot.hears(['Deposit', '💰 Deposit'], (ctx) => {
  const u = getUser(ctx.from.id);
  u.depMethod = null;
  u.wdMethod = null;
  writeJson(USERS_FILE, users);
  ctx.reply('Choose payment method:', Markup.inlineKeyboard([
    [Markup.button.callback('Telebirr', 'dep_Telebirr'), Markup.button.callback('CBE', 'dep_CBE')]
  ]));
});

bot.action(/^dep_(Telebirr|CBE)$/, async (ctx) => {
  const m = ctx.match[1];
  const acc = ACCOUNTS[m];
  const u = getUser(ctx.from.id);
  u.depMethod = m;
  u.wdMethod = null;
  writeJson(USERS_FILE, users);
  await ctx.answerCbQuery();
  await ctx.reply(acc.label + ' Account: ' + acc.account + '\nName: ' + acc.holder + '\nSend payment screenshot or SMS after paying.');
});

bot.action(/^cred_(\d+)$/, async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Admin only', { show_alert: true });
  pendingCreditTarget = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply('Enter amount to add for User ' + pendingCreditTarget + ' (example: 100):');
});

bot.on('photo', async (ctx) => {
  const u = getUser(ctx.from.id);
  const m = u.depMethod || 'Telebirr/CBE';
  const ph = ctx.message.photo[ctx.message.photo.length - 1];
  if (proofs.photos[ph.file_unique_id]) {
    return ctx.reply('Wrong! Duplicate screenshot is not allowed.');
  }
  proofs.photos[ph.file_unique_id] = { userId: String(ctx.from.id), method: m, at: Date.now() };
  writeJson(PROOFS_FILE, proofs);
  u.depMethod = null;
  writeJson(USERS_FILE, users);
  await ctx.reply('Screenshot received. Waiting for admin approval.');
  await toAdmin((aid) => ctx.telegram.sendPhoto(aid, ph.file_id, {
    caption: 'Deposit Screenshot (' + m + ')\nUser ID: ' + ctx.from.id + '\nName: ' + (ctx.from.first_name || 'User'),
    ...Markup.inlineKeyboard([[Markup.button.callback('Credit User (' + ctx.from.id + ')', 'cred_' + ctx.from.id)]])
  }));
});

bot.command('credit', (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return;
  const p = ctx.message.text.trim().split(/\s+/);
  const tid = p[1];
  const amt = Number(p[2]);
  if (!tid || !Number.isFinite(amt) || amt <= 0) return ctx.reply('Usage: /credit <userId> <amount>');
  const tu = getUser(tid);
  tu.mainWallet = Number((tu.mainWallet + amt).toFixed(2));
  writeJson(USERS_FILE, users);
  ctx.reply('Credited +' + amt.toFixed(2) + ' to User ' + tid + '. New Main Wallet: ' + tu.mainWallet.toFixed(2));
  ctx.telegram.sendMessage(tid, 'Deposit approved! +' + amt.toFixed(2) + ' Birr added to Main Wallet.').catch(() => {});
});

bot.hears(['Withdraw', '💸 Withdraw'], (ctx) => {
  const u = getUser(ctx.from.id);
  u.depMethod = null;
  u.wdMethod = null;
  writeJson(USERS_FILE, users);
  if (u.mainWallet < MIN_WITHDRAW) {
    return ctx.reply('Minimum withdraw is ' + MIN_WITHDRAW + ' Birr. Main Wallet: ' + u.mainWallet.toFixed(2) + ' Birr');
  }
  ctx.reply('Select withdraw method:', Markup.inlineKeyboard([
    [Markup.button.callback('Telebirr', 'wd_Telebirr'), Markup.button.callback('CBE', 'wd_CBE')]
  ]));
});

bot.action(/^wd_(Telebirr|CBE)$/, async (ctx) => {
  const m = ctx.match[1];
  const u = getUser(ctx.from.id);
  if (u.mainWallet < MIN_WITHDRAW) return ctx.answerCbQuery('Insufficient Main Wallet', { show_alert: true });
  u.wdMethod = m;
  writeJson(USERS_FILE, users);
  await ctx.answerCbQuery();
  if (m === 'Telebirr') {
    await ctx.reply('Send your Telebirr Name and Phone Number:');
  } else {
    await ctx.reply('Send your CBE Name and Account Number:');
  }
});

bot.hears(['Invite', '🎁 Invite'], (ctx) => {
  const uname = ctx.botInfo && ctx.botInfo.username ? ctx.botInfo.username : 'Trusttbingobot';
  ctx.reply('Invite link: https://t.me/' + uname + '?start=ref_' + ctx.from.id);
});

bot.hears(['How To Play', '📖 How To Play'], (ctx) => {
  ctx.reply('Select stake (10/20/50), take cartelas (80% Derash pool), pay Biniyam (0912698277 / 1000161123726) and send SMS/screenshot.');
});

bot.on('text', async (ctx, next) => {
  const sid = String(ctx.from.id);
  const txt = ctx.message.text.trim();

  if (sid === ADMIN_ID && pendingCreditTarget) {
    const amt = Number(txt);
    const tid = pendingCreditTarget;
    pendingCreditTarget = null;
    if (!Number.isFinite(amt) || amt <= 0) return ctx.reply('Invalid amount. Enter a number.');
    const tu = getUser(tid);
    tu.mainWallet = Number((tu.mainWallet + amt).toFixed(2));
    writeJson(USERS_FILE, users);
    await ctx.reply('Added +' + amt.toFixed(2) + ' to User ' + tid + '. Main Wallet: ' + tu.mainWallet.toFixed(2));
    ctx.telegram.sendMessage(tid, 'Deposit approved! +' + amt.toFixed(2) + ' Birr added to Main Wallet.').catch(() => {});
    return;
  }

  const u = getUser(sid);

  if (u.wdMethod) {
    if (txt.length < 4) return ctx.reply('Please enter Name and Number/Account.');
    if (u.mainWallet < MIN_WITHDRAW) {
      u.wdMethod = null;
      writeJson(USERS_FILE, users);
      return ctx.reply('Insufficient Main Wallet.');
    }
    const m = u.wdMethod;
    const outAmt = Number(u.mainWallet.toFixed(2));
    u.mainWallet = 0;
    u.wdMethod = null;
    writeJson(USERS_FILE, users);
    await ctx.reply('Withdraw request sent (' + m + '): ' + outAmt.toFixed(2) + ' Birr. Remaining Main Wallet: 0.00 Birr.');
    await toAdmin((aid) => ctx.telegram.sendMessage(
      aid,
      'Withdraw Request (' + m + ')\nUser ID: ' + sid + '\nName: ' + (ctx.from.first_name || 'User') + '\nAmount: ' + outAmt.toFixed(2) + ' Birr\nDetails: ' + txt
    ));
    return;
  }

  if (!u.depMethod) return next();

  const m = u.depMethod;
  if (!isSms(txt)) return ctx.reply('Wrong! Send a valid payment SMS or screenshot.');
  if (!isToBiniyam(txt)) return ctx.reply('Wrong! Payment is not sent to Biniyam (0912698277 / 1000161123726).');
  const h = sha(txt);
  if (proofs.sms[h]) return ctx.reply('Wrong! Duplicate SMS is not allowed.');

  proofs.sms[h] = { userId: sid, method: m, at: Date.now() };
  writeJson(PROOFS_FILE, proofs);
  u.depMethod = null;
  writeJson(USERS_FILE, users);

  await ctx.reply('SMS received. Waiting for admin approval.');
  await toAdmin((aid) => ctx.telegram.sendMessage(
    aid,
    'Deposit SMS (' + m + ')\nUser ID: ' + sid + '\nName: ' + (ctx.from.first_name || 'User') + '\nSMS:\n' + txt,
    Markup.inlineKeyboard([[Markup.button.callback('Credit User (' + sid + ')', 'cred_' + sid)]])
  ));
});

app.get('/api/state', (req, res) => {
  const uid = String(req.query.userId || 'guest');
  const s = [10, 20, 50].includes(Number(req.query.stake)) ? Number(req.query.stake) : 10;
  const u = getUser(uid);
  res.json({ userId: uid, mainWallet: u.mainWallet, playWallet: u.playWallet, balance: totalBal(u), cartelaCount: CARTELA_COUNT, room: roomSummary(s) });
});

app.post('/api/take-cartela', (req, res) => {
  const { userId = 'guest', stake = 10, cartelaId } = req.body || {};
  const s = [10, 20, 50].includes(Number(stake)) ? Number(stake) : 10;
  const id = parseInt(cartelaId, 10);
  if (isNaN(id) || id < 1 || id > CARTELA_COUNT) return res.status(400).json({ error: 'Invalid cartela ID' });
  const r = rooms[s];
  const uid = String(userId);
  if (r.taken[id]) {
    if (r.taken[id] === uid) return res.json({ balance: totalBal(getUser(uid)), room: roomSummary(s) });
    return res.status(409).json({ error: 'Cartela #' + id + ' is already taken.' });
  }
  const u = getUser(uid);
  if (!spendBal(u, s)) return res.status(400).json({ error: 'Insufficient balance.' });
  r.taken[id] = uid;
  res.json({ balance: totalBal(u), mainWallet: u.mainWallet, playWallet: u.playWallet, room: roomSummary(s) });
});

app.post('/api/start-game', (req, res) => {
  const { userId = 'guest', stake = 10, cartelaIds = [] } = req.body || {};
  const s = [10, 20, 50].includes(Number(stake)) ? Number(stake) : 10;
  const uid = String(userId);
  const r = rooms[s];
  const myIds = (Array.isArray(cartelaIds) ? cartelaIds : []).map((n) => parseInt(n, 10)).filter((n) => r.taken[n] === uid);
  if (!myIds.length) return res.status(400).json({ error: 'Take at least one cartela first.' });
  const sum = roomSummary(s);
  const pool = Array.from({ length: 75 }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  rooms[s] = { stake: s, taken: {} };
  res.json({ stake: s, takenCount: sum.takenCount, totalPool: sum.totalPool, derash: sum.derash, drawOrder: pool, boards: myIds.map((id) => ({ id, card: cartelas[id] })) });
});

app.post('/api/claim-win', (req, res) => {
  const { userId = 'guest', reward = 0 } = req.body || {};
  const prize = Number(reward);
  if (!Number.isFinite(prize) || prize <= 0 || prize > 100000) return res.status(400).json({ error: 'Invalid reward' });
  const u = getUser(String(userId));
  u.mainWallet = Number((u.mainWallet + prize).toFixed(2));
  writeJson(USERS_FILE, users);
  res.json({ balance: totalBal(u), mainWallet: u.mainWallet, playWallet: u.playWallet });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log('Server running on port ' + PORT));

bot.launch()
  .then(() => console.log('Bot running'))
  .catch((e) => console.error('Bot launch err:', e.message));
                                           
