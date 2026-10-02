# SPDX-License-Identifier: AGPL-3.0-or-later
# The community service: one image, three commands (api | worker | setup). Build from the repository root:
#
#   docker build -f apps/community-api/Dockerfile -t thefold/community-api .
#
# The workspace packages ship TypeScript source, run with tsx: no separate build step to drift from the tests.
FROM node:24-bookworm-slim

ENV NODE_ENV=production
RUN npm install -g pnpm@10.33.0 && npm cache clean --force

WORKDIR /app
# Manifests first, so dependency layers are reused when only source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/twenty-client/package.json packages/twenty-client/
COPY apps/community-api/package.json apps/community-api/
RUN pnpm install --frozen-lockfile --prod --filter "@thefold/community-api..." \
 && pnpm store prune

COPY packages/core/src packages/core/src
COPY packages/shared/src packages/shared/src
COPY packages/twenty-client/src packages/twenty-client/src
COPY apps/community-api/src apps/community-api/src
COPY apps/community-api/migrations apps/community-api/migrations
COPY apps/community-api/db apps/community-api/db

USER node
WORKDIR /app/apps/community-api
EXPOSE 4000
ENTRYPOINT ["node", "--import", "tsx", "src/main.ts"]
CMD ["api"]
