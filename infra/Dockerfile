FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY eslint.config.mjs vitest.config.ts ./
COPY apps apps
COPY packages packages
COPY scripts scripts
COPY tests tests
RUN npm run generate && npm run build && npm run typecheck && npm run lint && npm test

FROM node:24.22.2-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/apps/api ./apps/api
USER 1000:1000
WORKDIR /app/apps/api
CMD ["node", "dist/server.js"]

FROM node:24.22.2-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=1000:1000 /app/apps/web/.next/standalone ./
COPY --from=build --chown=1000:1000 /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=1000:1000 /app/apps/web/public ./apps/web/public
USER 1000:1000
CMD ["node", "apps/web/server.js"]

FROM build AS tests
COPY tests tests
COPY vitest.integration.config.ts ./
USER 1000:1000
CMD ["npm", "run", "test:integration"]
