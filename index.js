const express = require('express');
const { Client, GatewayIntentBits, ActivityType, AttachmentBuilder } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

// ---------- CLIENT FIRST ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- HEALTH ENDPOINT ----------
app.get('/health', (req, res) =>
  res.json({
    status: 'ok',
    bot: client.user?.tag || 'Starting...',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    ready: client.isReady(),
    timestamp: new Date().toISOString()
  })
);
app.get('/', (req, res) => res.send('Discord Link Cleaner Bot - Health: /health'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Health server on port ${PORT}`));

// ---------- CONFIG ----------
// Keys are lowercase to match .toLowerCase() lookup
const SUBREDDIT_CHANNEL_GROUPS = {
  '1544045468013559880': ['scatporn2','pee','girlsfarting']
};

// Generate subreddit -> channel lookup map
const SUBREDDIT_CHANNEL_MAP = Object.fromEntries(
  Object.entries(SUBREDDIT_CHANNEL_GROUPS)
    .flatMap(([channelId, subreddits]) =>
      subreddits.map(sub => [sub, channelId])
    )
);

const TARGET_BOT_IDS = ['1531274702067073157'];
const ALLOWED_EXTS = ['.mp4', '.gif', '.gifv', '.webm'];
const LOG_CHANNEL_ID = '1530804280720887918';
const REDDIT_NATIVE_DOMAINS = ['i.redd.it', 'v.redd.it'];
const TEST_CHANNEL_ID = '1537376472149524480';   // <-- NEW
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- LOGGER ----------
const originalLog = console.log;
const originalError = console.error;

// IMPROVED: only wraps URLs that are not already inside < >
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

console.log = (...args) => {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logAndSend(msg);
};
console.error = (...args) => {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logAndSend(`❌ ${msg}`, 'error');
};

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

// ----- FIXED getPostInfo – greedy title capture -----
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

// ---------- REDDIT PROCESSING LOGIC (refactored) ----------
async function processRedditMessage(msg) {
  const isTest = msg.content.trim().match(/^#test\b/i);   // <-- detect test command
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

  // Single comprehensive log for this message
  console.log(
    `🔎 **Analysis:**\n• From: **${msg.author.tag}**\n• Title: ${postInfo.title}\n• Subreddit: r/${postInfo.subreddit}\n` +
    `• URLs: ${urls.length} total, ${allAllowed.length} allowed, ${blocked.length} blocked\n` +
    (allAllowed.length ? `• Allowed: ${allAllowed.join(', ')}` : '') +
    (blocked.length ? `\n• Blocked: ${blocked.join(', ')}` : '')
  );

  if (allAllowed.length === 0 && blocked.length) {
    console.log(`🗑️ No allowed URLs, ${isTest ? 'nothing to send' : 'deleting original message'}`);
    if (!isTest) {
      return msg.delete();
    }
    return;
  }

  if (allAllowed.length) {
    try {
      // Only delete original if it's NOT a test
      if (!isTest) {
        console.log(`🗑️ Deleting original message...`);
        await msg.delete();
        console.log(`✅ Original message deleted`);
      } else {
        console.log(`🧪 Test mode – original message kept.`);
      }

      let targetChannel;
      if (isTest) {
        // Force test channel
        targetChannel = await client.channels.fetch(TEST_CHANNEL_ID);
        if (!targetChannel) {
          console.error(`❌ Test channel ${TEST_CHANNEL_ID} not found, falling back to original.`);
          targetChannel = msg.channel;
        } else {
          console.log(`🔄 Test message sent to <#${TEST_CHANNEL_ID}>`);
        }
      } else {
        // Normal redirection logic
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

// ---------- SCHEDULED JPEG POSTER ----------
const run = promisify(execFile);
const CONF = path.join(os.tmpdir(), 'rclone.conf');
const MAX_BYTES = 10 * 1024 * 1024;   // raise if the server is boosted
const IMG_RE = /\.jpe?g$/i;
const rc = (...a) =>
  run('./bin/rclone', ['--config', CONF, ...a], { maxBuffer: 50 * 1024 * 1024 });

const SCHEDULES = [
  {
    channelId: '1566080373899657277',
    cron: '0 9,21 * * *',            // 09:00 and 21:00 IST
    queue: 'pikpak2:queue',
    posting: 'pikpak2:posting',
    posted: 'pikpak2:posted',
    rejected: 'pikpak2:rejected',
    perPost: 1                        // JPEGs per post (max 10)
  }
];

async function postJpegs(job) {
  const ch = await client.channels.fetch(job.channelId);
  const { stdout } = await rc('lsjson', job.queue, '--files-only');
  const files = JSON.parse(stdout)
    .filter(f => IMG_RE.test(f.Name) && f.Size > 0)
    .sort((a, b) => a.Name.localeCompare(b.Name));

  const batch = [];
  let total = 0;
  for (const f of files) {
    if (batch.length >= Math.min(job.perPost || 1, 10)) break;
    if (f.Size > MAX_BYTES) {
      console.error(`${f.Name} too large, moved to rejected`);
      await rc('moveto', `${job.queue}/${f.Name}`, `${job.rejected}/${f.Name}`).catch(() => {});
      continue;
    }
    if (total + f.Size > MAX_BYTES) break;
    batch.push(f);
    total += f.Size;
  }
  if (!batch.length) return console.log('ℹ️ No JPEGs in queue');

  // claim files first so a second run can't grab them
  const claimed = [];
  for (const f of batch) {
    try {
      await rc('moveto', `${job.queue}/${f.Name}`, `${job.posting}/${f.Name}`);
      claimed.push(f);
    } catch {}
  }
  if (!claimed.length) return;

  const tmps = [];
  let sent = false;
  try {
    for (const f of claimed) {
      const tmp = path.join(os.tmpdir(), `${Date.now()}_${f.Name}`);
      await rc('copyto', `${job.posting}/${f.Name}`, tmp);
      tmps.push(tmp);
    }
    await ch.send({
      files: tmps.map((t, i) => new AttachmentBuilder(t, { name: claimed[i].Name }))
    });
    sent = true;
    for (const f of claimed) {
      await rc('moveto', `${job.posting}/${f.Name}`, `${job.posted}/${f.Name}`);
    }
    console.log(`✅ Posted ${claimed.length} JPEG(s) to <#${job.channelId}>`);
  } catch (e) {
    if (!sent) {
      for (const f of claimed) {
        await rc('moveto', `${job.posting}/${f.Name}`, `${job.queue}/${f.Name}`).catch(() => {});
      }
    }
    throw e;
  } finally {
    await Promise.all(tmps.map(t => fs.unlink(t).catch(() => {})));
  }
}

let busy = false;
function startSchedules() {
  if (!process.env.RCLONE_CONF_B64) {
    return console.error('RCLONE_CONF_B64 not set, scheduler disabled');
  }
  require('fs').writeFileSync(
    CONF,
    Buffer.from(process.env.RCLONE_CONF_B64, 'base64'),
    { mode: 0o600 }
  );
  for (const job of SCHEDULES) {
    cron.schedule(
      job.cron,
      async () => {
        if (busy) return;
        busy = true;
        try {
          await postJpegs(job);
        } catch (e) {
          console.error(`Scheduled post failed: ${e.message}`);
        } finally {
          busy = false;
        }
      },
      { timezone: 'Asia/Kolkata' }
    );
  }
  console.log(`⏰ ${SCHEDULES.length} schedule(s) active`);
}

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
  if (msg.author.id === client.user.id) return;

  // ---- Reddit cleaning: target bots OR #test command ----
  const isTargetBot = TARGET_BOT_IDS.includes(msg.author.id);
  const isTestCommand = msg.content.trim().match(/^#test\b/i) && !isTargetBot;

  if (isTargetBot || isTestCommand) {
    await processRedditMessage(msg);
    return;
  }

  // ---- Twitter conversion (unchanged) ----
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
