# Streamora

Telegram Mini App + Telegram Bot + Xtream bridge for media libraries you are authorized to use.

## Current build

The first working foundation is included:

- Telegram Mini App with RTL mobile UI.
- Movies and series browsing.
- Search across active Xtream sources.
- Series seasons and episodes.
- Multiple Xtream accounts managed from the Telegram bot.
- Enable/disable/delete Xtream sources from the bot.
- Storage-channel ID managed from the bot.
- Platform name, rights text, and rights cover managed from the bot.
- Telegram Mini App `initData` signature verification.
- Xtream credentials remain server-side and are never returned to the Mini App.
- Movie/episode delivery through the bot.
- Optional private Telegram storage channel.
- First successful delivery can be cached in the storage channel; later requests use `copyMessage` instead of going back to Xtream.
- Movie/episode stream URLs are constructed only inside the backend.

> Use only with Xtream libraries and media that you own or are authorized to redistribute.

## Architecture

```text
Telegram user
    |
    v
Telegram Mini App
    |
    | signed initData
    v
Streamora backend
    |
    +--> Xtream source 1
    +--> Xtream source 2
    +--> Xtream source N
    |
    v
Telegram Bot
    |
    +--> optional private storage channel/cache
    |
    v
User chat
```

## Environment variables

Copy `.env.example` to `.env` locally, or add these variables to your host:

```env
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
ADMIN_ID=YOUR_TELEGRAM_NUMERIC_ID
WEBAPP_URL=https://your-public-streamora-url
PORT=3000
DATA_DIR=./data
DEV_ALLOW_NO_TELEGRAM=0
```

Do **not** commit the real bot token or admin credentials.

### Important about the bot token

If a bot token has ever been posted in a chat, issue tracker, public repository, screenshot, or any other place you do not fully control, revoke it in BotFather and create a new token before deployment.

## Run locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
npm start
```

Open:

```text
http://localhost:3000/health
```

For normal Mini App use, the site must be deployed on HTTPS and opened from the Telegram bot.

## Deploy

Streamora is suitable for a long-running Node.js host such as Railway, Render, Fly.io, or a VPS.

A persistent disk/volume is strongly recommended because the bot stores its configuration in:

```text
data/config.json
```

If the filesystem is ephemeral, Xtream sources, the selected channel, branding, and Telegram cache will disappear after redeploy/restart.

A `Dockerfile` is included.

## First setup after deployment

1. Deploy the repository.
2. Set `BOT_TOKEN`, `ADMIN_ID`, and `WEBAPP_URL` as host environment variables.
3. Start the service.
4. Open your Telegram bot and send:

```text
/admin
```

5. Choose **مصادر Xtream** → **إضافة Xtream**.
6. Send either:

```text
اسم المصدر | http://server:port | username | password
```

or:

```text
اسم المصدر | http://server:port/player_api.php?username=USER&password=PASS
```

The bot tests the Xtream account before saving it.

## Storage channel

Create a private Telegram channel and add the bot as an administrator.

From `/admin`:

```text
قناة التخزين
```

Then send its numeric channel ID, for example:

```text
-1001234567890
```

The ID can be changed or cleared later from the bot.

### Delivery/cache flow

When a user requests a movie or episode:

1. Streamora looks for a cached Telegram channel message.
2. If found, it uses `copyMessage` to deliver it quickly.
3. Otherwise the backend constructs the authorized Xtream stream URL.
4. The bot asks Telegram to fetch the media.
5. If a storage channel is configured, the first copy is stored there and its `message_id` is cached.
6. The stored message is copied to the requesting user.

Large files or Xtream servers that block Telegram's fetch infrastructure may fail to send directly. A dedicated ingest/remux worker can be added later for those cases.

## Branding and rights

From `/admin` → **الهوية والحقوق** you can manage:

- Platform name.
- Rights/caption text.
- Rights cover image.

The rights cover is stored as a Telegram `file_id`, not committed to GitHub.

When configured, it is sent before the requested media.

## Security

- Xtream usernames/passwords are never exposed to the Mini App.
- Direct stream URLs are not returned to the browser.
- User delivery endpoints require valid Telegram Mini App `initData`.
- The Telegram user ID used for delivery is taken from signed Telegram data; the browser cannot choose another chat ID.
- Bot administration is restricted to `ADMIN_ID`.
- `data/config.json` and `.env` are ignored by Git.

For a production release, the next security upgrade should be encryption-at-rest for Xtream credentials and database-backed configuration.

## API overview

```text
GET  /health
GET  /api/bootstrap
GET  /api/home?type=movie
GET  /api/home?type=series
GET  /api/search?type=movie&q=...
GET  /api/search?type=series&q=...
GET  /api/details/movie/:sourceId/:id
GET  /api/details/series/:sourceId/:id
POST /api/send
```

All Mini App API requests use:

```text
X-Telegram-Init-Data: <Telegram.WebApp.initData>
```

## Project status

This is the initial functional build. Recommended next milestones:

- Encrypted credential storage.
- Database/Supabase persistence instead of JSON.
- Category browsing and pagination.
- Per-source priority/failover.
- Delivery queue and rate limiting.
- Dedicated media ingest/remux worker for media Telegram cannot fetch directly.
- Admin analytics and delivery logs.
- User favorites and request history.
