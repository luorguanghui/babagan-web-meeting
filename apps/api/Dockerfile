ARG NODE_IMAGE=node:24.15.0-alpine3.23@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
FROM ${NODE_IMAGE} AS build

ARG ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /workspace

RUN sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR}#g" /etc/apk/repositories \
  && apk add --no-cache python3 make g++ \
  && corepack enable \
  && corepack prepare pnpm@10.34.5 --activate \
  && pnpm config set registry "$NPM_REGISTRY"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages/contracts packages/contracts
RUN pnpm --filter @meeting/contracts build \
  && pnpm --filter @meeting/api build \
  && pnpm --filter @meeting/api --prod deploy /opt/api --legacy

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S -g 10001 meeting \
  && adduser -S -D -H -u 10001 -G meeting meeting \
  && mkdir /data \
  && chown meeting:meeting /data

COPY --from=build --chown=meeting:meeting /opt/api /app
# The migration runner loads these SQL files at runtime via import.meta.url.
# `pnpm deploy` copies JavaScript dependencies but not source SQL assets.
COPY --from=build --chown=meeting:meeting /workspace/apps/api/src/db/migrations /app/dist/db/migrations

USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/server.js"]
