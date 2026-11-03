# Discord Link Cleaner Bot

A Discord bot that cleans up Reddit-feed messages, converts Twitter/X links, and posts images from a cloud folder on a schedule. Every feature can be switched on or off from inside Discord, with no code edits needed.

## Features

| Feature | What it does |
|---|---|
| **Reddit link cleaner** | Watches messages from chosen bots, strips tracking junk, keeps only video/GIF links, deletes the original and re-posts a clean version. |
| **Subreddit redirects** | Sends posts from specific subreddits to a specific channel. |
| **Twitter/X converter** | Replies to `x.com` / `twitter.com` status links with a `fixupx.com` version so they embed properly. |
| **Scheduled image poster** | Posts images from an rclone remote (e.g. PikPak) to a channel on a cron schedule. |
| **Slash-command switches** | `/turn-on`, `/turn-off`, `/status` to control each feature live. |
| **Discord logging** | All logs and errors are sent to a log channel. |
| **Health endpoint** | `/health` returns bot status, uptime and scheduler info (handy for uptime monitors). |

---

## Slash commands

| Command | Description |
|---|---|
| `/turn-off feature:<name>` | Turn a feature off |
| `/turn-on feature:<name>` | Turn a feature back on |
| `/status` | Show what is currently on or off |

Available features: `reddit`, `twitter`, `scheduler`.

- Only members with the **Manage Server** permission can use these commands.
- Settings are saved in a single pinned message in the log channel, so they survive restarts and redeploys. If that message is deleted, all features go back to **on**.
- Turning off `scheduler` pauses posting. The schedules stay loaded and resume when you turn it back on.

---

## How the Reddit cleaner works

1. A message arrives from one of the bots listed in `TARGET_BOT_IDS` (or from someone typing `#test`, see below).
2. The bot extracts the title, subreddit, author and links.
3. Titles containing restricted tags (`[m]`, `(m)`, `[nb]`, `(nb)`, `[tf]`, `(tf)`, `[tm]`, `(tm)`) are deleted without a repost.
4. Links are cleaned and filtered. Kept: `redgifs.com`, `v.redd.it`, and links ending in `.mp4`, `.gif`, `.gifv`, `.webm`. Everything else is dropped. If a Reddit-native link (`i.redd.it` / `v.redd.it`) exists, only those are kept.
5. If nothing usable is left, the original is deleted. Otherwise it is deleted and a clean version is posted, in the original channel or in the channel mapped to that subreddit.

**Test mode:** send a message starting with `#test` followed by a feed message. The bot processes it, leaves the original alone, and posts the result in `TEST_CHANNEL_ID`.

---

## How the scheduled poster works

Each schedule uses four rclone folders:

```
queue  ->  posting  ->  posted
   \
    ->  rejected (file too big for Discord)
```

1. On each cron tick, the bot lists images in `queue` (random or alphabetical order).
2. Files over the size limit are moved to `rejected`.
3. Chosen files are moved to `posting` first, so a second run can never grab the same file.
4. The files are downloaded, uploaded to Discord, then moved to `posted`.
5. If the upload fails, files are moved back to `queue` so nothing is lost.

On startup the bot warns you in the log channel about files stuck in `posting` (left over from a crash). When the queue drops to `LOW_QUEUE_WARNING` files or fewer, it logs a warning.

---

## Setup

### 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create an application, then add a bot.
2. Under **Bot -> Privileged Gateway Intents**, enable **Message Content Intent**.
3. Copy the bot token (you'll need it below).
4. Invite the bot using **OAuth2 -> URL Generator** with:
   - **Scopes:** `bot` and `applications.commands`
   - **Permissions:** View Channels, Send Messages, Read Message History, Attach Files, Manage Messages (needed to delete messages and pin the settings message)

> If slash commands don't appear, the bot was most likely invited without the `applications.commands` scope. Re-invite it.

### 2. Project files

```
.
├── index.js
├── package.json
└── bin/
    └── rclone        # rclone Linux binary (only needed for the scheduler)
```

Dependencies: `discord.js` (v14, recent version), `express`, `node-cron`. Requires Node.js 18 or newer.

### 3. Environment variables

Set these on your host (for example in Render). **Never put them in `index.js` or commit them to GitHub.**

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | Yes | Your Discord bot token |
| `RCLONE_CONF_B64` | For scheduler | Your rclone config file, base64-encoded |
| `PORT` | No | Health server port (defaults to `3000`) |

Create `RCLONE_CONF_B64` from your rclone config:

```bash
base64 -w 0 ~/.config/rclone/rclone.conf
```

### 4. Run

```bash
npm install
node index.js
```

---

## Configuration

Everything you may want to change is in the **CONFIGURATION** block at the top of `index.js`.

### Channels and bots

| Setting | Description |
|---|---|
| `LOG_CHANNEL_ID` | Where logs, errors and the saved switch state go |
| `TEST_CHANNEL_ID` | Where `#test` results are posted |
| `TARGET_BOT_IDS` | List of bot IDs whose messages get cleaned |

Tip: enable Developer Mode in Discord settings, then right-click a channel or bot and choose **Copy ID**.

### Link cleaner

| Setting | Description |
|---|---|
| `SUBREDDIT_CHANNEL_GROUPS` | Map of channel ID to list of lowercase subreddit names that get redirected there |
| `ALLOWED_EXTS` | Link file types that are kept |
| `REDDIT_NATIVE_DOMAINS` | Domains preferred over other links |

Example:

```js
const SUBREDDIT_CHANNEL_GROUPS = {
  '123456789012345678': ['subreddit_one', 'subreddit_two']
};
```

### Scheduler

| Setting | Description |
|---|---|
| `SCHEDULER_ENABLED` | Master switch in the code. If `false`, schedules never start and `/turn-on scheduler` can't start them. Leave `true` for runtime control. |
| `TIMEZONE` | Timezone for cron times (e.g. `Asia/Kolkata`) |
| `MAX_UPLOAD_MB` | Max upload size per post (raise it if your server is boosted) |
| `IMAGE_EXTS` | File types picked from the queue |
| `LOW_QUEUE_WARNING` | Warn when this many files or fewer remain (`0` = off) |
| `RCLONE_TIMEOUT_SEC` | Give up on a stuck rclone command after this long |

Each entry in `SCHEDULES` is one channel:

| Field | Description |
|---|---|
| `channelId` | Channel to post in |
| `cron` | When to post (see cheat-sheet) |
| `queue` / `posting` / `posted` / `rejected` | rclone folder paths. Each schedule needs its own set. |
| `perPost` | Images per post (1 to 10) |
| `random` | `true` = random order, `false` = alphabetical |
| `spoiler` | `true` = hide images behind a spoiler |
| `caption` | Optional text sent with each post |

To post in more channels, copy a schedule entry and give it its own folders.

**Cron cheat-sheet** (`minute hour day month weekday`):

| Expression | Meaning |
|---|---|
| `0 9,21 * * *` | Every day at 09:00 and 21:00 |
| `0 */6 * * *` | Every 6 hours |
| `30 18 * * *` | Every day at 18:30 |
| `0 12 * * 1,4` | Mondays and Thursdays at 12:00 |
| `*/30 * * * *` | Every 30 minutes |

---

## Health check

`GET /health` returns JSON with the bot's status, uptime, memory use and scheduler info (number of active jobs, last post time, last error). Point an uptime monitor at it to keep a free host awake.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Slash commands don't show up | Re-invite the bot with the `applications.commands` scope. Check the log channel for a registration error. |
| Bot ignores messages | Enable **Message Content Intent** in the Developer Portal. |
| Messages aren't deleted | Give the bot **Manage Messages** in that channel. |
| Scheduler doesn't start | Check that `RCLONE_CONF_B64` is set, `SCHEDULER_ENABLED` is `true`, and `bin/rclone` exists. |
| "rclone check failed" in logs | Verify the remote name (e.g. `pikpak2`) matches your rclone config and the folders exist. |
| Files stuck in `posting` | A crash happened mid-post. Move them back to `queue` if they weren't posted, or to `posted` if they were. |
| Switches reset to on after a restart | The pinned state message was deleted or the bot can't read the log channel's history. |

---

## Notes

- Keep your bot token and rclone config secret. If either leaks, regenerate it immediately.
- All `console.log` and `console.error` output is mirrored to the log channel, so avoid logging sensitive data.
