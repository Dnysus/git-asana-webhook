# syntax=docker/dockerfile:1
#
# Multi-stage build producing a small, non-root runtime image.
# Portable across Google Cloud Run, AWS App Runner, and Azure Container Apps:
# the app binds to $PORT (default 8080) and shuts down gracefully on SIGTERM.

# ── Stage 1: build — compile TypeScript with the full dependency tree ───────
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: deps — production-only node_modules ────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ── Stage 3: runtime — minimal final image ──────────────────────────────────
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Run as the unprivileged user that ships with the official Node image.
USER node

# Cloud Run injects PORT at runtime; 8080 is the conventional default.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
