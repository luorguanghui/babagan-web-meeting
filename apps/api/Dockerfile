FROM node:24.15.0-alpine3.23@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS build

WORKDIR /workspace

RUN apk add --no-cache python3 make g++ \
  && corepack enable \
  && corepack prepare pnpm@10.34.5 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages/contracts packages/contracts
RUN pnpm --filter @meeting/api build \
  && pnpm --filter @meeting/api --prod deploy /opt/api

FROM node:24.15.0-alpine3.23@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S -g 10001 meeting \
  && adduser -S -D -H -u 10001 -G meeting meeting \
  && mkdir /data \
  && chown meeting:meeting /data

COPY --from=build --chown=meeting:meeting /opt/api /app

USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/server.js"]
