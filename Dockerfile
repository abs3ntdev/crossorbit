FROM node:24-trixie-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod --ignore-scripts && mkdir /data \
  && cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
  && rm -rf deps src binding.gyp \
  && find prebuilds -type f ! -name "linux-$(node -p process.arch).node" -delete

FROM gcr.io/distroless/nodejs24-debian13:nonroot
LABEL org.opencontainers.image.source=https://github.com/abs3ntdev/crossorbit
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build --chown=nonroot:nonroot /data /data
VOLUME /data
EXPOSE 8080 9090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/nodejs/bin/node", "dist/healthcheck.js"]
CMD ["dist/index.js"]
