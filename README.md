# EMA + Donchian crypto desk

Only two strategies ship in this project:

1. **Donchian Breakout** (20-bar close break of prior high/low)
2. **EMA Trend Following** (EMA20 / EMA50 cross)

Each research trade uses a **1.5 ATR stop**, **1.5R take-profit**, 0.5% risk, and fee/slip assumptions. Live alerts are **signals only** — this app does not place exchange orders.

## Local

```bash
# refresh 5y research JSON (Excel → ui/public + api summary)
python strategy_research_report.py

# UI + local Python API (port 8765)
npm run dev

# one-shot live scan (optional Telegram)
npm run scan
npm run scan -- --no-notify
```

Copy `.env.example` → `.env` and fill Telegram values before expecting notifications.

## Telegram setup

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy **bot token**
2. Open a chat with your bot and send any message
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy your **chat id**
4. Set in `.env` / Vercel env:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `CRON_SECRET` (random string; protects `/api/scan`)

## Vercel host

Vercel project already created: **crypto-ema-donchian** (`prj_9roQpMtIPDBgBJNSk7gyACTHI4vh`).

```bash
npx vercel login
npx vercel link   # select crypto-ema-donchian if asked
npx vercel --prod
```

Then in the Vercel project → **Settings → Environment Variables**, add for Production:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `CRON_SECRET`
- optional `SIGNAL_TIMEFRAME=1h`

Redeploy after saving env vars.

`vercel.json` cron runs **`/api/scan` daily at 00:05 UTC** (Hobby-safe). For near-hourly alerts on Hobby, point cron-job.org (or similar) at:

`https://YOUR_DOMAIN/api/scan?secret=YOUR_CRON_SECRET`

every hour at :05.

### Endpoints

| Path | Purpose |
|------|---------|
| `/api/health` | Liveness |
| `/api/results?strategy=&symbol=&timeframe=` | 5y research metrics |
| `/api/signals` | Live scan, no Telegram |
| `/api/scan` | Live scan + Telegram (auth with `CRON_SECRET`) |

## Research note

On the last 5y sample, **SOLUSDT 1h Donchian** was the only clearly profitable cell; most 15m runs lose to fees. Treat alerts as research aides, not a profit guarantee.
