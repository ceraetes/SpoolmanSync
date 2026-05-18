# SpoolmanSync Home Assistant add-on — Next.js + nginx ingress proxy
#
# Home Assistant Supervisor uses only this folder as the Docker build context, so paths
# like ../app do not exist. We shallow-clone the full monorepo, then copy app/ + rootfs.
# CI passes CLONE_REPO_URL / CLONE_REF as build-args; HA local builds rely on ARG defaults.

FROM alpine:3.21 AS fetch
RUN apk add --no-cache git ca-certificates
WORKDIR /opt/monorepo
# Include add-on metadata in this stage so Supervisor rebuilds re-clone the repo
# when the add-on version changes.
COPY config.yaml /tmp/spoolmansync-addon-config.yaml
# Fork default: yours. Other forks/changes → edit URL or mirror (see DOCS.md).
ARG CLONE_REPO_URL=https://github.com/ceraetes/SpoolmanSync.git
# Branch or tag readable by git clone (-b …), usually main.
ARG CLONE_REF=main
RUN git clone --depth 1 --branch "${CLONE_REF}" "${CLONE_REPO_URL}" src

FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app
COPY --from=fetch /opt/monorepo/src/app/package.json /opt/monorepo/src/app/package-lock.json* ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=fetch /opt/monorepo/src/app .

ENV DATABASE_URL="file:./placeholder.db"
ENV ADDON_BUILD=true
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HA_MODE=addon

RUN apk add --no-cache libc6-compat nginx bash jq curl

RUN mkdir -p /data

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/generated ./src/generated

COPY --from=deps /app/node_modules ./node_modules

COPY --from=fetch /opt/monorepo/src/spoolmansync-ha-addon/rootfs/etc/nginx/http.d/default.conf /etc/nginx/http.d/default.conf
COPY --from=fetch /opt/monorepo/src/spoolmansync-ha-addon/rootfs/run.sh /run.sh
RUN chmod a+x /run.sh

EXPOSE 3000 8099

ENV HOSTNAME="127.0.0.1"
ENV DATABASE_URL="file:/data/spoolmansync.db"

CMD ["/run.sh"]
