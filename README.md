# HostBot — Telegram Cloud Hosting Bot

A Telegram bot that lets users deploy and manage live projects directly from a chat. Upload a file or ZIP archive and the bot runs it instantly — Python scripts, HTML pages, Node.js apps, Shell scripts, or Docker containers.

---

## Pre-built Docker Image

The image is automatically built and published to GitHub Container Registry on every push to `main`. No local build required.

```
ghcr.io/deplyapp/hosting-bot:latest
```

Use this image URL directly in Koyeb, Render, or any Docker host.

---

## Features

- **One-tap deploy** — send a file or `.zip` and the bot detects the type and runs it
- **Supported project types:**
  - 🐍 Python `.py` — runs with `python3`
  - 🌐 HTML `.html` — served via a built-in HTTP server with a public URL
  - 🟨 Node.js `.js` — runs with `node`
  - 🐚 Shell `.sh` — runs with `bash`
  - 🐳 Docker `Dockerfile` or ZIP — builds and runs the container
- **Project management** — start, stop, restart any project from inline buttons
- **Real-time logs** — view up to 300 lines of stdout/stderr output per project
- **Send commands** — pipe text input to a running process's stdin
- **Environment variables** — set, update, and remove per-project env vars; changes apply on restart
- **Auto-install Python packages** — if a Python project crashes with a missing module error, the bot detects it and offers a one-tap auto-install
- **Public URLs** — HTML and Docker projects get a public URL automatically
- **Persistent storage** — project state survives bot restarts via PostgreSQL
- **Per-user isolation** — each user's projects are stored in a separate directory

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (Node.js 22) |
| Bot framework | [Telegraf 4](https://telegrafjs.org) |
| Database | PostgreSQL (via `pg`) |
| Runtime | `tsx` (runs TypeScript directly) |
| Package manager | `pnpm` (monorepo) |
| Container | Docker |
| CI/CD | GitHub Actions → GitHub Container Registry |

---

## Project Structure

```
├── Dockerfile                        # Single image for both bot and API
├── docker-compose.yml                # Run both services locally
├── render.yaml                       # One-click Render.com deployment
├── .github/
│   └── workflows/
│       └── docker-publish.yml        # Auto-build & push image on every push to main
├── artifacts/
│   ├── tg-bot/                       # Telegram bot
│   │   └── src/
│   │       ├── index.ts              # Bot logic, commands, inline menus
│   │       ├── runner.ts             # Process manager (start/stop/logs/ports)
│   │       └── database.ts          # PostgreSQL queries
│   └── api-server/                   # Express REST API (optional companion)
│       └── src/
│           ├── app.ts
│           └── index.ts
└── lib/
    ├── db/                           # Shared Drizzle ORM schema
    ├── api-zod/                      # Zod-validated API types
    └── api-spec/                     # OpenAPI spec
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from [@BotFather](https://t.me/BotFather) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SERVICE` | Docker only | `bot` to run the Telegram bot, `api` to run the API server |
| `PORT` | API only | Port for the API server (default `8080`) |

---

## Deploy with Pre-built Image (Recommended)

The Docker image is already built and ready at:

```
ghcr.io/deplyapp/hosting-bot:latest
```

> If you get a pull error, go to `https://github.com/Deplyapp/Hosting-Bot/pkgs/container/hosting-bot` → **Package settings** → **Change visibility** → **Public**

---

### Deploy to Koyeb

Create **two services**, both using the same image URL:

1. Go to [koyeb.com](https://koyeb.com) → **Create Service** → **Docker**
2. Set image to `ghcr.io/deplyapp/hosting-bot:latest`
3. Repeat for both services:

| Service name | `SERVICE` | Additional env vars |
|---|---|---|
| `hosting-bot` | `bot` | `TELEGRAM_BOT_TOKEN`, `DATABASE_URL` |
| `hosting-api` | `api` | `DATABASE_URL`, `PORT=8080` |

4. Click Deploy — done, no build step needed

---

### Deploy to Render

The `render.yaml` in this repo is pre-configured to pull from the published image.

1. Go to [render.com](https://render.com) → **New** → **Blueprint**
2. Connect the `Deplyapp/Hosting-Bot` GitHub repo
3. Render reads `render.yaml` and creates both services automatically
4. Add the secret environment variables in the Render dashboard:
   - `TELEGRAM_BOT_TOKEN`
   - `DATABASE_URL` (use [Neon](https://neon.tech), [Supabase](https://supabase.com), or Render's managed PostgreSQL)
5. Deploy — Render pulls the pre-built image directly, no build time

> The bot runs as a **Background Worker**, the API as a **Web Service**. Both use the same image switched by the `SERVICE` variable.

---

## How the Image is Built (CI/CD)

Every push to the `main` branch triggers a GitHub Actions workflow that:

1. Builds the Docker image from `Dockerfile`
2. Pushes it to GitHub Container Registry with two tags:
   - `ghcr.io/deplyapp/hosting-bot:latest`
   - `ghcr.io/deplyapp/hosting-bot:sha-<commit>`

You can watch builds at: `https://github.com/Deplyapp/Hosting-Bot/actions`

Koyeb and Render can be configured to auto-redeploy when a new image is pushed.

---

## Local Setup (Without Docker)

### Prerequisites

- Node.js 22+
- pnpm (`npm install -g pnpm`)
- PostgreSQL database
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/Deplyapp/Hosting-Bot.git
cd Hosting-Bot

# 2. Install dependencies
pnpm install

# 3. Create environment file
cp .env.example .env
# Edit .env and fill in TELEGRAM_BOT_TOKEN and DATABASE_URL

# 4. Run the bot
cd artifacts/tg-bot
pnpm start
```

---

## Local Setup (With Docker)

```bash
# Copy and fill in your environment variables
cp .env.example .env

# Pull the pre-built image and run both services
docker compose up

# Or build locally and run
docker compose up --build

# Run just the bot
docker compose up bot

# Run just the API
docker compose up api
```

Or run manually with the pre-built image:

```bash
# Run as bot
docker run -e SERVICE=bot -e TELEGRAM_BOT_TOKEN=... -e DATABASE_URL=... \
  ghcr.io/deplyapp/hosting-bot:latest

# Run as API server
docker run -e SERVICE=api -e PORT=8080 -e DATABASE_URL=... -p 8080:8080 \
  ghcr.io/deplyapp/hosting-bot:latest
```

---

## Bot Commands & Navigation

All navigation is done through inline buttons. Start the bot with `/start`.

| Button | Action |
|---|---|
| 🚀 Deploy New Project | Upload a file to deploy |
| 📋 My Projects | List all your projects with live status |
| ▶️ Start | Start a stopped project |
| ⏹️ Stop | Stop a running project |
| 🔄 Restart | Restart a project (picks up new env vars) |
| 📋 Logs | View the last 300 lines of output |
| 🔑 Env Vars | Add, update, or remove environment variables |
| ⌨️ Send Command | Send a line of text to the process stdin |
| 🗑️ Delete | Remove the project and its files permanently |

---

## Database Schema

The bot auto-creates its tables on first run. No migrations needed.

```sql
-- Stores all deployments
CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,           -- python | html | nodejs | shell | docker
  status TEXT NOT NULL,         -- running | stopped | error
  port INTEGER,
  file_path TEXT NOT NULL,
  entry_file TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

-- Per-project environment variables
CREATE TABLE deployment_envs (
  id SERIAL PRIMARY KEY,
  deployment_id TEXT REFERENCES deployments(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(deployment_id, key)
);
```

---

## License

MIT
