# syntax=docker/dockerfile:1

# -- Build stage -------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# -- Runtime stage -----------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="eventer" \
	org.opencontainers.image.description="Events bot for self-hosted Fluxer instances: schedules, lists, and announces guild events in an events channel" \
	org.opencontainers.image.source=https://github.com/JoaoCostaIFG/eventer \
	org.opencontainers.image.url=https://github.com/JoaoCostaIFG/eventer \
	org.opencontainers.image.licenses=MIT \
	org.opencontainers.image.authors="JoaoCostaIFG"

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# The bot touches /tmp/bot-heartbeat whenever the gateway is alive
# (same pattern the Fluxer worker container uses). If the file goes stale
# the container is unhealthy and gets restarted.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD node -e "const fs=require('fs');const age=Date.now()-fs.statSync('/tmp/bot-heartbeat').mtimeMs;if(age>60000){console.error('gateway heartbeat is '+Math.round(age/60)+' minutes old');process.exit(1)}"

CMD ["node", "dist/index.js"]
