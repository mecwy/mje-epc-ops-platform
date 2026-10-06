FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
ARG VITE_REPORT_LOCATION_ENABLED=false
ENV VITE_REPORT_LOCATION_ENABLED=$VITE_REPORT_LOCATION_ENABLED
RUN npm install --global pnpm@10.34.5
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm --filter @mje/api deploy --prod --legacy /runtime

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3300 WEB_ROOT=/app/web
WORKDIR /app
COPY --from=build --chown=node:node /runtime ./
COPY --from=build --chown=node:node /app/apps/web/dist ./web
ARG SOURCE_REVISION=unknown
ENV SOURCE_REVISION=$SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
USER node
EXPOSE 3300
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:3300/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
