FROM node:22-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g tsx

# ─── Bot: install deps with plain npm using clean package.json ────────────────
FROM base AS bot-deps
WORKDIR /bot
RUN echo '{ \
  "name": "tg-bot", \
  "version": "1.0.0", \
  "type": "module", \
  "dependencies": { \
    "telegraf": "^4.16.3", \
    "pg": "^8.20.0", \
    "axios": "^1.9.0", \
    "adm-zip": "^0.5.16", \
    "uuid": "^11.1.0" \
  } \
}' > package.json
RUN npm install

# ─── API: install deps + build with pnpm ─────────────────────────────────────
FROM base AS api-build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/db/package.json               ./lib/db/
COPY lib/api-spec/package.json         ./lib/api-spec/
COPY lib/api-zod/package.json          ./lib/api-zod/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/tg-bot/package.json     ./artifacts/tg-bot/
COPY scripts/package.json              ./scripts/

RUN pnpm install --frozen-lockfile

COPY lib/                  ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/

RUN pnpm --filter @workspace/api-server build

# ─── Final runner ─────────────────────────────────────────────────────────────
FROM base AS runner
ARG SERVICE=bot

WORKDIR /bot
COPY --from=bot-deps /bot/node_modules ./node_modules
COPY artifacts/tg-bot/src              ./src
RUN mkdir -p /projects

COPY --from=api-build /app/artifacts/api-server/dist /api/dist

ENV NODE_ENV=production
ENV PORT=8080
ENV SERVICE=${SERVICE}

EXPOSE 8080

CMD sh -c '\
  if [ "$SERVICE" = "api" ]; then \
    exec node --enable-source-maps /api/dist/index.mjs; \
  else \
    exec tsx /bot/src/index.ts; \
  fi'
