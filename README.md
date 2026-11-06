# Discord Bot

A small Discord bot that does two things:

1. **Twitter/X link converter** – replies to tweet links with an embed-friendly `fixupx.com` version.
2. **Scheduled file poster** – on a cron schedule, picks files from a cloud folder (via [rclone](https://rclone.org/)), posts them to a Discord channel, and files them away so nothing is posted twice.

It also exposes a health endpoint, sends its logs to a Discord channel, and lets server admins switch features on and off with slash commands.

---

## Features

### Twitter/X link converter

When someone posts a link to a tweet (`x.com/.../status/...` or `twitter.com/.../status/...`), the bot replies with a converted `fixupx.com` link so the tweet embeds properly.

- Tracking parameters (`?...`) and trailing slashes are stripped.
- Duplicate links in one message are replied to once.
- Messages that already contain `fixupx.com`, `fxtwitter.com` or `vxtwitter.com` are ignored.

### Scheduled file poster

Each entry in `SCHEDULES` posts to one channel on its own cron schedule.

- **Safe against double posts** – a file is moved to a `posting` folder before it is sent, then to `posted` afterwards. If sending fails, the file goes back to the queue.
- **Split queues** – `queue` can be one folder or a list. Each run picks one folder at random, so large libraries stay fast. Empty or unreadable folders are skipped.
- **Size limit** – files over `MAX_UPLOAD_MB` are moved to `rejected` instead of failing the run.
- **Ordering** – random or alphabetical (`001_`, `002_`, …).
- **Options per schedule** – files per post (1–10), spoiler tags, optional caption, and an optional separate log channel.
- **Warnings** – logs a message when the queue is running low, and on startup reports any files left stuck in `posting` after a crash.
- **Safe rclone handling** – rclone commands run one at a time, time out if they hang, and the config is restored from the environment variable if it gets corrupted.

### Admin slash commands

Require the **Manage Server** permission.

| Command | What it does |
| --- | --- |
| `/status` | Shows which features are on or off |
| `/turn-on feature:<name>` | Turns a feature on |
| `/turn-off feature:<name>` | Turns a feature off |

Available features: `twitter`, `scheduler`.

Switch states are saved in a pinned message in the log channel, so they survive restarts.

---

## Requirements

- Node.js 18+
- A Discord bot application with:
  - the **Message Content** privileged intent enabled
  - the `bot` and `applications.commands` scopes when inviting it
  - permission to view, send messages, attach files, and pin messages in the channels it uses
- An rclone binary at `bin/rclone` (needed only for the scheduler)
- An rclone config containing the remote(s) used in `SCHEDULES` (for example `pikpak2`)

Dependencies (installed from `package.json`): `discord.js`, `express`, `node-cron`.

---

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Put rclone in place**

   Download the rclone binary for your platform and save it as `bin/rclone` (make sure it is executable).

3. **Set environment variables**

   | Variable | Required | Description |
   | --- | --- | --- |
   | `BOT_TOKEN` | Yes | Your Discord bot token |
   | `RCLONE_CONF_B64` | For the scheduler | Your `rclone.conf` encoded as base64 |
   | `PORT` | No | Port for the health server (default `3000`) |

   To create `RCLONE_CONF_B64`:

   ```bash
   base64 -w 0 ~/.config/rclone/rclone.conf
   ```

   Keep secrets in environment variables only. Never commit them.

4. **Edit the configuration** at the top of `index.js` (see below).

5. **Run it**

   ```bash
   npm start
   ```

---

## Configuration

Everything you may want to change is in the configuration block at the top of `index.js`.

### Channels

```js
const LOG_CHANNEL_ID = 'YOUR_LOG_CHANNEL_ID'; // logs, errors and saved switch state go here
```

To get an ID, enable Developer Mode in Discord, then right-click a channel → **Copy Channel ID**.

### Scheduler settings

| Setting | Description |
| --- | --- |
| `SCHEDULER_ENABLED` | `false` turns the whole scheduler off |
| `TIMEZONE` | Time zone used for cron schedules (e.g. `Asia/Kolkata`) |
| `MAX_UPLOAD_MB` | Maximum size per post; raise it if your server is boosted |
| `FILE_EXTS` | File types picked up from the queue |
| `LOW_QUEUE_WARNING` | Warn when this many files or fewer are left (`0` = off) |
| `RCLONE_TIMEOUT_SEC` | Give up on a stuck rclone command after this long |

### Schedules

Add one entry to `SCHEDULES` per channel:

```js
{
  channelId: 'DISCORD_CHANNEL_ID',      // where files are posted
  logChannelId: '',                     // '' = use LOG_CHANNEL_ID
  cron: '0 */6 * * *',                  // when to post
  queue: ['myremote:Folder/queue'],     // one folder or a list of folders
  posting:  'myremote:Folder/posting',  // temporary "claimed" folder
  posted:   'myremote:Folder/posted',   // already posted
  rejected: 'myremote:Folder/rejected', // too big for Discord
  perPost: 1,                           // files per post (1-10)
  random: true,                         // false = alphabetical order
  spoiler: false,                       // true = hide files behind spoiler tags
  caption: ''                           // optional text sent with each post
}
```

Each schedule needs its own `posting`, `posted` and `rejected` folders.

### Cron cheat-sheet

Format: `minute hour day month weekday`

| Expression | Meaning |
| --- | --- |
| `0 9,21 * * *` | Every day at 09:00 and 21:00 |
| `0 */6 * * *` | Every 6 hours |
| `30 18 * * *` | Every day at 18:30 |
| `0 12 * * 1,4` | Mondays and Thursdays at 12:00 |
| `*/30 * * * *` | Every 30 minutes |

---

## Health check

`GET /health` returns JSON with bot status, uptime, memory use, scheduler status (active jobs, last post time, last error) and a timestamp. This is handy for uptime monitors on hosts like Render.

---

## Deployment notes

- On `SIGTERM` or `SIGINT` (for example during a redeploy), the bot waits up to 25 seconds for any post in progress to finish before exiting.
- If the bot crashes mid-post, the file stays in the `posting` folder. On the next startup the bot lists those files in the log channel. Move them back to the queue if they were not posted, or to `posted` if they were.

---

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Slash commands don't appear | Re-invite the bot with the `applications.commands` scope |
| Link converter does nothing | Make sure the Message Content intent is enabled and `twitter` is switched on with `/status` |
| Scheduler doesn't start | `RCLONE_CONF_B64` must be set, and `SCHEDULER_ENABLED` must be `true` |
| "rclone config" errors in the log channel | Re-export and re-encode your rclone config; the password in it must be in rclone's obscured format |
| Log messages are missing | Check `LOG_CHANNEL_ID` and the bot's permissions in that channel |
| Files rejected | They exceed `MAX_UPLOAD_MB`; raise it or shrink the files |
