# --- Stage 1: builder ---
# Installs EVERYTHING (including devDependencies — the TypeScript compiler,
# @nestjs/cli, etc.) since nest build genuinely needs them. None of this
# stage's contents ship in the final image; only its OUTPUT (dist/) does.
FROM node:24-slim AS builder

WORKDIR /app

# Copied separately from the rest of the source, deliberately — Docker
# caches each layer by its inputs. As long as package*.json hasn't changed,
# this npm ci layer is reused unchanged across rebuilds, even when app code
# has, which is what makes iterative builds fast.
COPY package*.json ./
RUN npm ci

COPY . .

# Runs `nest build` under the hood (see package.json's "build" script) —
# NOT `tsc` directly. This matters specifically because the @nestjs/swagger
# CLI plugin (nest-cli.json) only takes effect through Nest's own build
# process, not a plain TypeScript compile.
RUN npm run build


# --- Stage 2: runtime ---
# A genuinely fresh, clean base — nothing from the builder stage carries
# over except what's explicitly copied below.
FROM node:24-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
# --omit=dev is the actual point of this whole multi-stage split — the
# TypeScript compiler, test tooling, and everything else devDependencies-only
# never exists in this image at all, not even temporarily.
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Node's official images ship this user built in, specifically for this
# purpose — running as root inside a production container is a real,
# avoidable risk if the app were ever compromised through some other means.
USER node

EXPOSE 3000

# Uses the real /health endpoint (DrizzleHealthIndicator + memory check)
# already built — a plain inline Node script, avoiding the need to install
# curl into the image just for this one purpose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main.js"]