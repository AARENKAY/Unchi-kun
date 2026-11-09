const express = require('express');
const {
  Client, GatewayIntentBits, ActivityType, AttachmentBuilder,
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags
} = require('discord.js');
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
//  1) DISCORD CHANNELS
// ---------------------------------------------------------------------
const LOG_CHANNEL_ID  = '1530804280720887918';   // logs and errors are sent here

// ---------------------------------------------------------------------
//  2) SCHEDULED FILE POSTER
// ---------------------------------------------------------------------
const SCHEDULER_ENABLED = true;        // false = turn the whole scheduler off
const TIMEZONE          = 'Asia/Kolkata';
const MAX_UPLOAD_MB     = 11;          // Discord upload limit per post (raise if server is boosted)
const FILE_EXTS         = ['.jpg', '.jpeg', '.png', '.gif', '.mp4'];   // file types picked from the queue (add or remove as needed)
const LOW_QUEUE_WARNING = 5;           // log a warning when this many files or fewer are left (0 = off)
const RCLONE_TIMEOUT_SEC = 120;        // give up on a stuck rclone command after this long

// One entry per channel. Copy an entry to post in more channels
// (each needs its own queue/posting/posted/rejected folders).
//
// SPLIT QUEUES: "queue" can be ONE folder ('pikpak2:Discord/queue') or a LIST of folders.
// With a list, every run picks one folder at random and lists only that one (fast, even
// with thousands of files). A folder that is empty or missing is skipped automatically.
//
// LOG CHANNEL PER SCHEDULE: logChannelId = where THIS schedule's messages go (posted, queue
// low, errors, files stuck in "posting"). Leave it '' to use the global LOG_CHANNEL_ID above.
const SCHEDULES = [
  {
    channelId: '1466297782502559806',  // right-click channel -> Copy Channel ID
    logChannelId: '',                  // log channel for this schedule ('' = use the global one)
    cron: '0 12 * * *',              // WHEN to post (cheat-sheet below)
    queue: [                           // files waiting to be posted (add more folders here)
      'pikpak2:Jade/queue'
    ],
    posting:  'pikpak2:Jade/posting',       // temporary "claimed" folder (prevents double posts)
    posted:   'pikpak2:Jade/posted',        // files already posted
    rejected: 'pikpak2:Jade/rejected',      // files too big for Discord
    perPost: 1,                        // files per post (1-10)
    random: false,                      // true = random order, false = alphabetical (001_, 002_, ...)
    spoiler: false,                    // true = hide files behind a spoiler
    caption: ''                        // optional text sent with each post
  },
  {
    channelId: '1504738628725899324',  // right-click channel -> Copy Channel ID
    logChannelId: '',                  // log channel for this schedule ('' = use the global one)
    cron: '0 0 * * *',              // WHEN to post (cheat-sheet below)
    queue: [                           // files waiting to be posted (add more folders here)
      'pikpak2:nonJAV/queue',
      'pikpak2:nonJAV/queue2'
    ],
    posting:  'pikpak2:nonJAV/posting',       // temporary "claimed" folder (prevents double posts)
    posted:   'pikpak2:nonJAV/posted',        // files already posted
    rejected: 'pikpak2:nonJAV/rejected',      // files too big for Discord
    perPost: 1,                        // files per post (1-10)
    random: false,                      // true = random order, false = alphabetical (001_, 002_, ...)
    spoiler: false,                    // true = hide files behind a spoiler
    caption: ''                        // optional text sent with each post
  }
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
app.get('/', (req, res) => res.send('Discord Bot - Health: /health'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Health server on port ${PORT}`));

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

// targetId = which channel gets the message (default: the global log channel).
// If a schedule's own log channel can't be used, the message goes to the global one instead.
const logAndSend = async (message, level = 'log', targetId = LOG_CHANNEL_ID) => {
  originalLog(message);

  let msg = suppressEmbeds(message);
  if (msg.length > 1900) {
    msg = msg.slice(0, 1900) + '... (truncated)';
  }

  try {
    const channel = await client.channels.fetch(targetId);
    if (!channel) throw new Error('channel not found');
    await channel.send(msg);
  } catch (e) {
    originalError(`Failed to send log to Discord (${targetId}):`, e.message);
    if (targetId === LOG_CHANNEL_ID) return;
    try {
      const fallback = await client.channels.fetch(LOG_CHANNEL_ID);
      await fallback.send(`${msg}\n⚠️ (could not write to log channel <#${targetId}>, check the ID and the bot's permissions)`.slice(0, 2000));
    } catch { /* nothing more we can do */ }
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

// ---------- ON/OFF SWITCHES (use /turn-on, /turn-off and /status in Discord) ----------
const FEATURES = {
  twitter:   'Twitter link converter',
  scheduler: 'Scheduled file poster'
};
const features = { twitter: true, scheduler: true };   // defaults when nothing is saved yet
const STATE_PREFIX = '⚙️ BOT_STATE ';   // the bot keeps its switches in one pinned message in the log channel
let stateMessage = null;

async function loadState() {
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    const isState = m => m.author.id === client.user.id && m.content.startsWith(STATE_PREFIX);

    // 1) look in pinned messages
    let found = null;
    try {
      const pins = ch.messages.fetchPins
        ? (await ch.messages.fetchPins()).items.map(p => p.message)
        : [...(await ch.messages.fetchPinned()).values()];
      found = pins.find(isState) || null;
    } catch { /* ignore, try recent messages next */ }

    // 2) fall back to recent messages
    if (!found) {
      const recent = [...(await ch.messages.fetch({ limit: 100 })).values()];
      found = recent.find(isState) || null;
    }

    stateMessage = found;
    if (found) {
      const saved = JSON.parse(found.content.slice(STATE_PREFIX.length));
      for (const key of Object.keys(features)) {
        if (typeof saved[key] === 'boolean') features[key] = saved[key];
      }
    }
  } catch (e) {
    console.error(`Could not load saved switches (using defaults): ${e.message}`);
  }
}

async function saveState() {
  const content = STATE_PREFIX + JSON.stringify(features);
  try {
    if (stateMessage) {
      try { await stateMessage.edit(content); return; }
      catch { stateMessage = null; }   // message was deleted, make a new one
    }
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    stateMessage = await ch.send(content);
    await stateMessage.pin().catch(() => {});
  } catch (e) {
    console.error(`Could not save switches: ${e.message}`);
  }
}

const featureChoices = Object.keys(FEATURES).map(key => ({ name: key, value: key }));
const COMMANDS = [
  new SlashCommandBuilder()
    .setName('turn-off')
    .setDescription('Turn a bot feature off')
    .addStringOption(o => o.setName('feature').setDescription('What to turn off')
      .setRequired(true).addChoices(...featureChoices))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('turn-on')
    .setDescription('Turn a bot feature on')
    .addStringOption(o => o.setName('feature').setDescription('What to turn on')
      .setRequired(true).addChoices(...featureChoices))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show which bot features are on or off')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(c => c.toJSON());

async function registerCommands() {
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(COMMANDS);
    } catch (e) {
      console.error(`Could not register slash commands in ${guild.name}: ${e.message} (re-invite the bot with the "applications.commands" scope)`);
    }
  }
}

const statusText = () =>
  Object.entries(FEATURES)
    .map(([key, label]) => `${features[key] ? '🟢' : '🔴'} **${key}** - ${label}`)
    .join('\n');

// ---------- SCHEDULED FILE POSTER ----------
const run = promisify(execFile);
const RCLONE_BIN = path.resolve('bin', 'rclone');
const RCLONE_CONF = path.join(os.tmpdir(), 'rclone.conf');
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// The rclone config file always comes from the RCLONE_CONF_B64 environment variable.
// This (re)writes a fresh copy of it to disk.
function writeRcloneConfig() {
  fs.writeFileSync(
    RCLONE_CONF,
    Buffer.from(process.env.RCLONE_CONF_B64 || '', 'base64'),
    { mode: 0o600 }
  );
}

// Reads the config and logs clear errors if it looks broken (never prints secrets)
function checkRcloneConfig(jobs) {
  let text = '';
  try { text = fs.readFileSync(RCLONE_CONF, 'utf8'); } catch {}

  const remotes = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const sec = line.match(/^\[(.+)\]\s*$/);
    if (sec) { current = sec[1]; remotes[current] = {}; continue; }
    const kv = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (kv && current) remotes[current][kv[1]] = kv[2].trim();
  }

  const names = Object.keys(remotes);
  if (!names.length) {
    console.error('RCLONE_CONF_B64 decoded to an empty or invalid config - re-export it from Termux and paste it again');
    return;
  }
  console.log(`🔑 rclone config loaded, remotes: ${names.join(', ')}`);

  const used = new Set(jobs.flatMap(j => [].concat(j.queue)).map(q => q.split(':')[0]));
  for (const name of used) {
    if (!remotes[name]) {
      console.error(`Remote "${name}" is used in SCHEDULES but missing from RCLONE_CONF_B64`);
      continue;
    }
    const pass = remotes[name].pass;
    if (pass && !/^[A-Za-z0-9_-]+$/.test(pass)) {
      console.error(`The password saved for remote "${name}" is not in rclone's obscured format - the env var content is damaged, re-export it from Termux`);
    }
  }
}

const RCLONE_CONFIG_ERROR = /failed to decode password|Failed to create file system|couldn't decrypt/i;

const rcOnce = (...args) =>
  run(RCLONE_BIN, ['--config', RCLONE_CONF, ...args], {
    maxBuffer: 50 * 1024 * 1024,
    timeout: RCLONE_TIMEOUT_SEC * 1000   // a hung rclone can no longer block the scheduler forever
  });

// All rclone calls run ONE AT A TIME (several rclone processes rewriting the same
// config file at once can corrupt it). If a config error shows up, the config is
// restored from the environment variable and the command is retried once.
let rcQueue = Promise.resolve();
const rc = (...args) => {
  const task = rcQueue.then(async () => {
    try {
      return await rcOnce(...args);
    } catch (e) {
      if (RCLONE_CONFIG_ERROR.test(`${e.message} ${e.stderr || ''}`)) {
        console.log('🔧 rclone config problem detected, restoring it from RCLONE_CONF_B64 and retrying');
        writeRcloneConfig();
        return await rcOnce(...args);
      }
      throw e;
    }
  });
  rcQueue = task.catch(() => {});
  return task;
};

const hasAllowedExt = name => FILE_EXTS.includes(path.extname(name).toLowerCase());

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
const warnedQueues = new Set();   // queue folders already reported as unreadable

async function postFiles(job) {
  const ch = await client.channels.fetch(job.channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    throw new Error(`Channel ${job.channelId} not found or not a text channel`);
  }

  // pick ONE queue folder per run: folders are tried in random order and the first one
  // that has usable files wins (empty or unreadable folders are skipped)
  const queues = shuffle([].concat(job.queue));
  let queueDir = null;
  let files = [];
  for (const q of queues) {
    try {
      const { stdout } = await rc('lsjson', q, '--files-only');
      const list = JSON.parse(stdout).filter(f => hasAllowedExt(f.Name) && f.Size > 0);
      if (list.length) { queueDir = q; files = list; break; }
    } catch (e) {
      if (!warnedQueues.has(q)) {
        warnedQueues.add(q);   // warn once per folder, not every run
        job.err(`Cannot read queue folder ${q} (skipping it, will not warn again): ${e.message}`);
      }
    }
  }
  if (!queueDir) return job.log(`ℹ️ No files in any queue folder: ${queues.join(', ')}`);

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
      job.err(`${f.Name} is over ${MAX_UPLOAD_MB} MB, moved to rejected`);
      await rc('moveto', `${queueDir}/${f.Name}`, `${job.rejected}/${f.Name}`).catch(() => {});
      rejectedCount++;
      continue;
    }
    if (total + f.Size > MAX_BYTES) continue;   // skip to a smaller file instead of stopping
    batch.push(f);
    total += f.Size;
  }
  if (!batch.length) return job.log(`ℹ️ No postable files in ${queueDir}`);

  // claim files first so a second run can never grab them
  const claimed = [];
  for (const f of batch) {
    try {
      await rc('moveto', `${queueDir}/${f.Name}`, `${job.posting}/${f.Name}`);
      claimed.push(f);
    } catch { /* another run took it, skip */ }
  }
  if (!claimed.length) return;

  const tmps = [];
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
  } catch (e) {
    // not sent: put files back in the queue so nothing is lost
    for (const f of claimed) {
      await rc('moveto', `${job.posting}/${f.Name}`, `${queueDir}/${f.Name}`).catch(() => {});
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
      job.err(`Posted ${f.Name} but could not move it to posted (left in ${job.posting}): ${e.message}`);
    }
  }

  schedulerStatus.lastPostAt = new Date().toISOString();
  const remaining = files.length - rejectedCount - claimed.length;
  job.log(`✅ Posted ${claimed.length} file(s) to <#${job.channelId}> - ${remaining} left in ${queueDir}`);
  if (LOW_QUEUE_WARNING > 0 && remaining <= LOW_QUEUE_WARNING) {
    job.log(`⚠️ Queue folder running low: ${remaining} file(s) left in ${queueDir}`);
  }
}

// On startup: check rclone works and warn about files stuck in "posting"
async function checkJob(job) {
  try {
    const { stdout } = await rc('lsjson', job.posting, '--files-only');
    const stuck = JSON.parse(stdout);
    if (stuck.length) {
      job.err(
        `${stuck.length} file(s) stuck in ${job.posting} (crash during a post): ` +
        `${stuck.map(f => f.Name).join(', ')}. ` +
        `If they were NOT posted, move them back to the queue; if they were, move them to posted.`
      );
    }
  } catch (e) {
    job.err(`rclone check failed for ${job.posting}: ${e.message}`);
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

  writeRcloneConfig();
  checkRcloneConfig(SCHEDULES);

  for (const raw of SCHEDULES) {
    const job = { perPost: 1, random: false, spoiler: false, caption: '', logChannelId: '', ...raw };

    if (!/^\d+$/.test(job.channelId)) {
      console.error(`Schedule skipped: "${job.channelId}" is not a valid channel ID`);
      continue;
    }
    if (!cron.validate(job.cron)) {
      console.error(`Schedule skipped: invalid cron "${job.cron}" for <#${job.channelId}>`);
      continue;
    }

    // this schedule's own log channel ('' or missing = the global LOG_CHANNEL_ID)
    job.logChannelId = String(job.logChannelId || '').trim();
    if (job.logChannelId && !/^\d+$/.test(job.logChannelId)) {
      console.error(`logChannelId "${job.logChannelId}" for <#${job.channelId}> is not a valid channel ID, using the default log channel`);
      job.logChannelId = '';
    }
    const logTo = job.logChannelId || LOG_CHANNEL_ID;
    job.log = (...args) => logAndSend(args.map(fmtArg).join(' '), 'log', logTo);
    job.err = (...args) => logAndSend(`❌ ${args.map(fmtArg).join(' ')}`, 'error', logTo);

    let running = false;   // one flag per schedule so schedules never block each other
    cron.schedule(
      job.cron,
      async () => {
        if (running || shuttingDown) return;
        if (!features.scheduler) return;   // switched off with /turn-off scheduler
        running = true;
        activeRuns++;
        try {
          await postFiles(job);
        } catch (e) {
          schedulerStatus.lastError = e.message;
          job.err(`Scheduled post failed: ${e.message}`);
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
client.once('clientReady', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: 'Cleaning links...', type: ActivityType.Watching }],
    status: 'online'
  });
  await loadState();
  await registerCommands();
  console.log(`🎚️ Switches:\n${statusText()}`);
  startSchedules();
});

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  try {
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return i.reply({ content: '❌ You need the Manage Server permission.', flags: MessageFlags.Ephemeral });
    }

    if (i.commandName === 'status') {
      return i.reply({ content: statusText(), flags: MessageFlags.Ephemeral });
    }

    if (i.commandName === 'turn-on' || i.commandName === 'turn-off') {
      const key = i.options.getString('feature');
      if (!(key in FEATURES)) {
        return i.reply({ content: '❌ Unknown feature.', flags: MessageFlags.Ephemeral });
      }
      features[key] = i.commandName === 'turn-on';
      await saveState();
      console.log(`🎚️ ${i.user.tag} turned ${key} ${features[key] ? 'ON' : 'OFF'}`);
      return i.reply(`${features[key] ? '🟢' : '🔴'} **${key}** is now **${features[key] ? 'ON' : 'OFF'}**\n\n${statusText()}`);
    }
  } catch (e) {
    console.error(`Command error: ${e.message}`);
  }
});

client.on('messageCreate', async msg => {
  try {
    if (msg.author.id === client.user.id) return;

    // ---- Twitter conversion ----
    if (!features.twitter) return;   // switched off with /turn-off twitter
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
