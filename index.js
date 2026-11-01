const express = require('express');
const { Client, GatewayIntentBits, ActivityType, AttachmentBuilder } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

// =====================================================================
//  ⚙️  CONFIGURATION  -  everything you may want to change is in here
// =====================================================================
//  Secrets live in Render environment variables, NOT in this file:
//    BOT_TOKEN         your Discord bot token
//    RCLONE_CONF_B64   base64 of your pikpak2 rclone config
// =====================================================================

// ---------------------------------------------------------------------
//  1) DISCORD CHANNELS / BOTS
// ---------------------------------------------------------------------
const LOG_CHANNEL_ID  = '1530804280720887918';   // logs and errors are sent here
const TEST_CHANNEL_ID = '1537376472149524480';   // "#test" messages are re-posted here
const TARGET_BOT_IDS  = ['1531274702067073157']; // bots whose messages get cleaned

// ---------------------------------------------------------------------
//  2) LINK CLEANER
// ---------------------------------------------------------------------
// channel ID -> list of subreddits (lowercase) that get redirected there
const SUBREDDIT_CHANNEL_GROUPS = {
  '1544045468013559880': ['scatporn2', 'pee', 'girlsfarting']
};
const ALLOWED_EXTS = ['.mp4', '.gif', '.gifv', '.webm'];   // link types that are kept
const REDDIT_NATIVE_DOMAINS = ['i.redd.it', 'v.redd.it'];  // preferred over other links

// ---------------------------------------------------------------------
//  3) SCHEDULED IMAGE POSTER
// ---------------------------------------------------------------------
const SCHEDULER_ENABLED = true;        // false = turn the whole scheduler off
const TIMEZONE          = 'Asia/Kolkata';
const MAX_UPLOAD_MB     = 10;          // Discord upload limit per post (raise if server is boosted)
const IMAGE_EXTS        = ['.jpg', '.jpeg'];   // file types picked from the queue (e.g. add '.png', '.webp')
const LOW_QUEUE_WARNING = 5;           // log a warning when this many files or fewer are left (0 = off)
const RCLONE_TIMEOUT_SEC = 120;        // give up on a stuck rclone command after this long

// One entry per channel. Copy an entry to post in more channels
// (each needs its own queue/posting/posted/rejected folders).
const SCHEDULES = [
  {
    channelId: '1566080373899657277',  // right-click channel -> Copy Channel ID
    cron: '0 */3 * * *',               // WHEN to post (cheat-sheet below)
    queue:    'pikpak2:queue',         // images waiting to be posted
    posting:  'pikpak2:posting',       // temporary "claimed" folder (prevents double posts)
    posted:   'pikpak2:posted',        // images already posted
    rejected: 'pikpak2:rejected',      // images too big for Discord
    perPost: 1,                        // images per post (1-10)
    random: true,                      // true = random order, false = alphabetical (001_, 002_, ...)
    spoiler: false,                    // true = hide images behind a spoiler
    caption: ''                        // optional text sent with each post
  }
  // ,{
  //   channelId: 'SECOND_CHANNEL_ID',
  //   cron: '0 */6 * * *',
  //   queue: 'pikpak2:queue2', posting: 'pikpak2:posting2',
  //   posted: 'pikpak2:posted2', rejected: 'pikpak2:rejected2',
  //   perPost: 3, random: false, spoiler: false, caption: ''
  // }
];

// CRON CHEAT-SHEET  (minute hour day month weekday)
//   '0 9,21 * * *'     every day at 09:00 and 21:00
//   '0 */6 * * *'      every 6 hours
//   '30 18 * * *'      every day at 18:30
//   '0 12 * * 1,4'     Mondays and Thursdays at 12:00
//   '*/30 * * * *'     every 30 minutes

// =====================================================================
//  END OF CONFIGURATION  -  nothing below needs editing
// =====================================================================

// ---------- CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const app = express();
const PORT = process.env.PORT || 3000;
const schedulerStatus = { jobs: 0, lastPostAt: null, lastError: null };

// ---------- HEALTH ENDPOINT ----------
app.get('/health', (req, res) =>
  res.json({
    status: 'ok',
    bot: client.user?.tag || 'Starting...',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    ready: client.isReady(),
    scheduler: schedulerStatus,
    timestamp: new Date().toISOString()
  })
);
app.get('/', (req, res) => res.send('Discord Link Cleaner Bot - Health: /health'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Health server on port ${PORT}`));

// ---------- LOOKUP MAPS ----------
const SUBREDDIT_CHANNEL_MAP = Object.fromEntries(
  Object.entries(SUBREDDIT_CHANNEL_GROUPS)
    .flatMap(([channelId, subreddits]) =>
      subreddits.map(sub => [sub.toLowerCase(), channelId])
    )
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- LOGGER ----------
const originalLog = console.log;
const originalError = console.error;

// only wraps URLs that are not already inside < >
const suppressEmbeds = text => {
  if (!text) return text;
  return text.replace(
    /(?<!<)https?:\/\/[^\s<>"]+(?!>)/gi,
    '<$&>'
  );
};

const logAndSend = async (message, level = 'log') => {
  originalLog(message);

  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!channel) return;

    let msg = suppressEmbeds(message);

    if (msg.length > 1900) {
      msg = msg.slice(0, 1900) + '... (truncated)';
    }

    await channel.send(msg);

  } catch (e) {
    originalError('Failed to send log to Discord:', e.message);
  }
};

// Errors used to print as "{}" - now they show their message
const fmtArg = a => {
  if (a instanceof Error) return a.message;
  if (typeof a === 'object' && a !== null) return JSON.stringify(a);
  return String(a);
};

console.log = (...args) => {
  logAndSend(args.map(fmtArg).join(' '));
};
console.error = (...args) => {
  logAndSend(`❌ ${args.map(fmtArg).join(' ')}`, 'error');
};

// Never let one stray error kill the bot
process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
});

// ---------- HELPERS ----------
const cleanUrl = url => {
  if (!url) return url;
  let c = url.replace('www.redgifs.com', 'redgifs.com');
  if (c.includes('preview.redd.it')) {
    const m = c.match(/preview\.redd\.it\/([^?]+)/);
    if (m) c = `https://i.redd.it/${m[1].split('?')[0]}`;
  }
  return c.split('?')[0].replace(/\/+$/, '');
};

const formatMessage = async (ch, postInfo, urls) => {
  const { title, subreddit, author, subredditLink, postLink } = postInfo;

  let msg = `# [${title}](<${postLink || '#'}>)\n`;
  msg += `*Posted in:*  **[r/${subreddit}](<${subredditLink || '#'}>)**   *By:*  **${author}**`;

  for (const url of urls) {
    msg += `[.](${url})\n`;
  }

  if (msg.length > 1900) {
    const chunks = msg.match(/[\s\S]{1,1900}/g) || [];
    for (const chunk of chunks) {
      await ch.send(chunk);
    }
  } else {
    await ch.send(msg);
  }
  await ch.send('────────── • ────────── • ────────── • ──────────');
};

const getPostInfo = content => {
  let title = 'Reddit Post';
  let subreddit = 'unknown';
  let author = 'unknown';
  let subredditLink = '#';
  let postLink = '#';

  const subredditMatch = content.match(/r\/\[([^\]]+)\]/i);
  if (subredditMatch) subreddit = subredditMatch[1].trim();

  const subredditLinkMatch = content.match(/r\/\[[^\]]+\]\(<([^>]+)>\)/i);
  if (subredditLinkMatch) subredditLink = subredditLinkMatch[1].trim();

  const postMatch = content.match(/:\s*\[([\s\S]*)\]\(<([^>]+)>\)/i);
  if (postMatch) {
    title = postMatch[1].replace(/\s+/g, ' ').trim();
    postLink = postMatch[2].trim();
  }

  const authorMatch = content.match(/\*by\s+([^*\s·]+)/i);
  if (authorMatch) author = authorMatch[1].trim();

  title = title.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, '').trim();
  if (!title) title = 'Reddit Post';

  return { title, subreddit, author, subredditLink, postLink };
};

// ---------- REDDIT PROCESSING LOGIC ----------
async function processRedditMessage(msg) {
  const isTest = msg.content.trim().match(/^#test\b/i);
  const mode = isTest ? '🧪 TEST' : '📩';

  console.log(`\n${mode} New message from *${msg.author.tag}* in <#${msg.channel.id}>\n📝 **Content:**\n${msg.content.slice(0, 500)}${msg.content.length > 500 ? '...' : ''}`);

  const urls = msg.content.match(/https?:\/\/[^\s<>"]+/gi);
  if (!urls) {
    console.log(`ℹ️ No URLs found in message`);
    return;
  }

  const postInfo = getPostInfo(msg.content);
  console.log(`ℹ️ Post info - Title: "${postInfo.title}", Sub: ${postInfo.subreddit}, Author: ${postInfo.author}`);

  // Check for restricted tags in title
  const restrictedPattern = /\[m\]|\(m\)|\[nb\]|\(nb\)|\[tf\]|\(tf\)|\[tm\]|\(tm\)/i;
  if (postInfo.title && restrictedPattern.test(postInfo.title)) {
    console.log(`🚫 Title contains forbidden tags, ${isTest ? 'skipping test' : 'deleting message without repost'}.`);
    if (!isTest) {
      await msg.delete().catch(console.error);
      console.log(`🚫 Deleted message from **${msg.author.tag}** because title contains restricted tags: ${postInfo.title}`);
    }
    return;
  }

  let allowed = [], blocked = [], seen = new Set();

  for (const u of urls) {
    const clean = cleanUrl(u);
    if (seen.has(clean)) continue;
    seen.add(clean);
    const low = clean.toLowerCase();
    if (
      low.includes('redgifs.com') ||
      low.includes('v.redd.it') ||
      ALLOWED_EXTS.some(ext => low.includes(ext) || low.endsWith(ext))
    ) {
      allowed.push(clean);
    } else {
      blocked.push(clean);
    }
  }

  let allAllowed = [...allowed];

  const hasRedditNative = allAllowed.some(url =>
    REDDIT_NATIVE_DOMAINS.some(domain => url.includes(domain))
  );
  if (hasRedditNative) {
    allAllowed = allAllowed.filter(url =>
      REDDIT_NATIVE_DOMAINS.some(domain => url.includes(domain))
    );
  }

  console.log(
    `🔎 **Analysis:**\n• From: **${msg.author.tag}**\n• Title: ${postInfo.title}\n• Subreddit: r/${postInfo.subreddit}\n` +
    `• URLs: ${urls.length} total, ${allAllowed.length} allowed, ${blocked.length} blocked\n` +
    (allAllowed.length ? `• Allowed: ${allAllowed.join(', ')}` : '') +
    (blocked.length ? `\n• Blocked: ${blocked.join(', ')}` : '')
  );

  if (allAllowed.length === 0 && blocked.length) {
    console.log(`🗑️ No allowed URLs, ${isTest ? 'nothing to send' : 'deleting original message'}`);
    if (!isTest) {
      // FIX: a failed delete (already deleted / missing permission) used to crash the bot
      await msg.delete().catch(console.error);
    }
    return;
  }

  if (allAllowed.length) {
    try {
      if (!isTest) {
        console.log(`🗑️ Deleting original message...`);
        await msg.delete();
        console.log(`✅ Original message deleted`);
      } else {
        console.log(`🧪 Test mode – original message kept.`);
      }

      let targetChannel;
      if (isTest) {
        targetChannel = await client.channels.fetch(TEST_CHANNEL_ID);
        if (!targetChannel) {
          console.error(`❌ Test channel ${TEST_CHANNEL_ID} not found, falling back to original.`);
          targetChannel = msg.channel;
        } else {
          console.log(`🔄 Test message sent to <#${TEST_CHANNEL_ID}>`);
        }
      } else {
        targetChannel = msg.channel;
        const subForRedirect = postInfo.subreddit.toLowerCase();
        if (SUBREDDIT_CHANNEL_MAP[subForRedirect]) {
          try {
            const channelId = SUBREDDIT_CHANNEL_MAP[subForRedirect];
            const fetchedChannel = await client.channels.fetch(channelId, { force: true });
            if (!fetchedChannel) {
              console.error(`❌ Channel ${channelId} not found (null), falling back to original`);
            } else {
              targetChannel = fetchedChannel;
              console.log(`🔄 Redirected to <#${channelId}> for subreddit r/${subForRedirect}`);
            }
          } catch (e) {
            console.error(`❌ Redirect fetch failed (${e.code}): ${e.message}. Falling back to original channel.`);
          }
        }
      }

      console.log(`📤 Sending cleaned message to ${targetChannel.id}...`);
      await formatMessage(targetChannel, postInfo, allAllowed);
      console.log(`✅ Cleaned message sent`);

      await sleep(2000);
      const redirectInfo = targetChannel.id !== msg.channel.id ? `\n• Redirected to <#${targetChannel.id}>` : '';
      console.log(
        `✅ **Cleaned:**\n• From: **${msg.author.tag}**\n• Posted: ${allAllowed.length} URLs\n• Blocked: ${blocked.length} URLs` +
        redirectInfo
      );
    } catch (e) {
      console.error(`❌ Error: ${e.message}\n• From: **${msg.author.tag}**`);
    }
  }
}

// ---------- SCHEDULED IMAGE POSTER ----------
const run = promisify(execFile);
const RCLONE_BIN = path.resolve('bin', 'rclone');
const RCLONE_CONF = path.join(os.tmpdir(), 'rclone.conf');
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const rc = (...args) =>
  run(RCLONE_BIN, ['--config', RCLONE_CONF, ...args], {
    maxBuffer: 50 * 1024 * 1024,
    timeout: RCLONE_TIMEOUT_SEC * 1000   // FIX: a hung rclone can no longer block the scheduler forever
  });

const hasImageExt = name => IMAGE_EXTS.includes(path.extname(name).toLowerCase());

// Fisher-Yates shuffle
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

let shuttingDown = false;
let activeRuns = 0;

async function postImages(job) {
  const ch = await client.channels.fetch(job.channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    throw new Error(`Channel ${job.channelId} not found or not a text channel`);
  }

  const { stdout } = await rc('lsjson', job.queue, '--files-only');
  const files = JSON.parse(stdout).filter(f => hasImageExt(f.Name) && f.Size > 0);

  if (job.random) shuffle(files);
  else files.sort((a, b) => a.Name.localeCompare(b.Name, undefined, { numeric: true }));

  // pick files for this post
  const batch = [];
  let total = 0;
  let rejectedCount = 0;
  const maxFiles = Math.min(Math.max(job.perPost, 1), 10);   // Discord max: 10 per message

  for (const f of files) {
    if (batch.length >= maxFiles) break;
    if (f.Size > MAX_BYTES) {
      console.error(`${f.Name} is over ${MAX_UPLOAD_MB} MB, moved to rejected`);
      await rc('moveto', `${job.queue}/${f.Name}`, `${job.rejected}/${f.Name}`).catch(() => {});
      rejectedCount++;
      continue;
    }
    if (total + f.Size > MAX_BYTES) continue;   // FIX: skip to a smaller file instead of stopping
    batch.push(f);
    total += f.Size;
  }
  if (!batch.length) return console.log(`ℹ️ No images in queue: ${job.queue}`);

  // claim files first so a second run can never grab them
  const claimed = [];
  for (const f of batch) {
    try {
      await rc('moveto', `${job.queue}/${f.Name}`, `${job.posting}/${f.Name}`);
      claimed.push(f);
    } catch { /* another run took it, skip */ }
  }
  if (!claimed.length) return;

  const tmps = [];
  let sent = false;
  try {
    for (let i = 0; i < claimed.length; i++) {
      const tmp = path.join(os.tmpdir(), `${Date.now()}_${i}_${claimed[i].Name}`);
      await rc('copyto', `${job.posting}/${claimed[i].Name}`, tmp);
      tmps.push(tmp);
    }

    await ch.send({
      content: job.caption || undefined,
      files: tmps.map((t, i) =>
        new AttachmentBuilder(t, { name: (job.spoiler ? 'SPOILER_' : '') + claimed[i].Name })
      )
    });
    sent = true;
  } catch (e) {
    // not sent: put files back in the queue so nothing is lost
    for (const f of claimed) {
      await rc('moveto', `${job.posting}/${f.Name}`, `${job.queue}/${f.Name}`).catch(() => {});
    }
    throw e;
  } finally {
    await Promise.all(tmps.map(t => fsp.unlink(t).catch(() => {})));
  }

  // sent: file them under "posted"
  for (const f of claimed) {
    try {
      await rc('moveto', `${job.posting}/${f.Name}`, `${job.posted}/${f.Name}`);
    } catch (e) {
      console.error(`Posted ${f.Name} but could not move it to posted (left in ${job.posting}): ${e.message}`);
    }
  }

  schedulerStatus.lastPostAt = new Date().toISOString();
  const remaining = files.length - rejectedCount - claimed.length;
  console.log(`✅ Posted ${claimed.length} image(s) to <#${job.channelId}> - ${remaining} left in queue`);
  if (LOW_QUEUE_WARNING > 0 && remaining <= LOW_QUEUE_WARNING) {
    console.log(`⚠️ Queue running low: ${remaining} image(s) left in ${job.queue}`);
  }
}

// On startup: check rclone works and warn about files stuck in "posting"
async function checkJob(job) {
  try {
    const { stdout } = await rc('lsjson', job.posting, '--files-only');
    const stuck = JSON.parse(stdout);
    if (stuck.length) {
      console.error(
        `${stuck.length} file(s) stuck in ${job.posting} (crash during a post): ` +
        `${stuck.map(f => f.Name).join(', ')}. ` +
        `If they were NOT posted, move them back to the queue; if they were, move them to posted.`
      );
    }
  } catch (e) {
    console.error(`rclone check failed for ${job.posting}: ${e.message}`);
    schedulerStatus.lastError = e.message;
  }
}

let schedulerStarted = false;
function startSchedules() {
  if (schedulerStarted) return;
  if (!SCHEDULER_ENABLED) return console.log('⏸️ Scheduler disabled in config');
  if (!process.env.RCLONE_CONF_B64) {
    return console.error('RCLONE_CONF_B64 not set, scheduler disabled');
  }
  schedulerStarted = true;

  fs.writeFileSync(
    RCLONE_CONF,
    Buffer.from(process.env.RCLONE_CONF_B64, 'base64'),
    { mode: 0o600 }
  );

  for (const raw of SCHEDULES) {
    const job = { perPost: 1, random: false, spoiler: false, caption: '', ...raw };

    if (!/^\d+$/.test(job.channelId)) {
      console.error(`Schedule skipped: "${job.channelId}" is not a valid channel ID`);
      continue;
    }
    if (!cron.validate(job.cron)) {
      console.error(`Schedule skipped: invalid cron "${job.cron}" for <#${job.channelId}>`);
      continue;
    }

    let running = false;   // FIX: one flag per schedule (a shared flag made schedules block each other)
    cron.schedule(
      job.cron,
      async () => {
        if (running || shuttingDown) return;
        running = true;
        activeRuns++;
        try {
          await postImages(job);
        } catch (e) {
          schedulerStatus.lastError = e.message;
          console.error(`Scheduled post failed: ${e.message}`);
        } finally {
          running = false;
          activeRuns--;
        }
      },
      { timezone: TIMEZONE }
    );

    schedulerStatus.jobs++;
    checkJob(job);
  }

  console.log(`⏰ ${schedulerStatus.jobs} schedule(s) active (${TIMEZONE})`);
}

// Render sends SIGTERM on every deploy/restart: finish any post in progress first
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  originalLog(`${signal} received, waiting for active posts to finish...`);
  const deadline = Date.now() + 25000;
  while (activeRuns > 0 && Date.now() < deadline) await sleep(500);
  client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------- BOT EVENTS ----------
client.once('clientReady', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: 'Cleaning links...', type: ActivityType.Watching }],
    status: 'online'
  });
  startSchedules();
});

client.on('messageCreate', async msg => {
  try {
    if (msg.author.id === client.user.id) return;

    // ---- Reddit cleaning: target bots OR #test command ----
    const isTargetBot = TARGET_BOT_IDS.includes(msg.author.id);
    const isTestCommand = msg.content.trim().match(/^#test\b/i) && !isTargetBot;

    if (isTargetBot || isTestCommand) {
      await processRedditMessage(msg);
      return;
    }

    // ---- Twitter conversion ----
    if (
      msg.content.includes('fixupx.com') ||
      msg.content.includes('fxtwitter.com') ||
      msg.content.includes('vxtwitter.com')
    ) return;

    const urls = msg.content.match(/https?:\/\/[^\s<>"]+/gi);
    if (!urls) return;

    const twitterUrls = urls.filter(u => /x\.com|twitter\.com/i.test(u) && /\/status\//i.test(u));
    if (twitterUrls.length === 0) return;

    console.log(`\n🐦 Tweet link from ${msg.author.tag} in #${msg.channel.name}`);
    console.log(`Original: ${msg.content}`);

    const converted = twitterUrls.map(u => {
      let c = u.replace(/https?:\/\/(www\.)?(x\.com|twitter\.com)/i, 'https://fixupx.com');
      return c.split('?')[0].replace(/\/+$/, '');
    });
    const unique = [...new Set(converted)];

    const reply = unique.map(u => `[•](${u})`).join('\n');

    try {
      await msg.reply(reply);
      console.log(`✅ Replied with converted tweet(s): ${unique.join(', ')}`);
    } catch (e) {
      console.error(`❌ Tweet conversion error: ${e.message}`);
    }
  } catch (e) {
    console.error(`messageCreate handler error: ${e.message}`);
  }
});

// ---------- START BOT ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not set!');
  process.exit(1);
}
client.login(BOT_TOKEN).catch(error => {
  console.error('❌ Login failed:', error);
  process.exit(1);
});
