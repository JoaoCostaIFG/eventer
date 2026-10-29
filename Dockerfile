# syntax=docker/dockerfile:1

# -- Build stage -------------------------------------------------------------
# node >= 22.23.4: security release that updates the bundled root CA store to
# NSS 3.131.1, dropping the compromised eMudhra "emSign ECC Root CA - G3"
# (CVE-2026-113812); its alpine base also ships ca-certificates 20261020-r0.
# Pinned by multi-arch index digest for reproducible builds (Renovate bumps
# tag + digest together).
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# -- Runtime stage -----------------------------------------------------------
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /app
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="eventer" \
	org.opencontainers.image.description="Events bot for self-hosted Fluxer instances: schedules, lists, and announces guild events in an events channel" \
	org.opencontainers.image.source=https://github.com/JoaoCostaIFG/eventer \
	org.opencontainers.image.url=https://github.com/JoaoCostaIFG/eventer \
	org.opencontainers.image.licenses=EUPL-1.2 \
	org.opencontainers.image.authors="JoaoCostaIFG"

COPY package.json package-lock.json* ./
# npm is needed only for the install above; strip it (plus corepack and
# yarn) from the final layer afterwards. The runtime only ever runs
# `node dist/index.js`, and the npm bundled with node 22 ships deps with
# open HIGH CVEs (brace-expansion, ip-address, pacote, picomatch,
# sigstore, ...) whose fixes only exist in npm 11's dependency tree, so
# no node 22 base image can ever clear them. Dropping the package
# managers removes that whole finding class (~90MB smaller too).
RUN npm ci --omit=dev || npm install --omit=dev \
	&& rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
		/usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
		/usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn*
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# The bot touches /tmp/bot-heartbeat whenever the gateway is alive
# (same pattern the Fluxer worker container uses). If the file goes stale
# the container is unhealthy and gets restarted.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD node -e "const fs=require('fs');const age=Date.now()-fs.statSync('/tmp/bot-heartbeat').mtimeMs;if(age>60000){console.error('gateway heartbeat is '+Math.round(age/60)+' minutes old');process.exit(1)}"

CMD ["node", "dist/index.js"]
