FROM node:26-alpine AS build
RUN npm install -g pnpm@12.18.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod --ignore-scripts \
  && cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
  && rm -rf deps src binding.gyp \
  && find prebuilds -type f ! -name "linuxmusl-$(node -p process.arch).node" -delete

FROM node:26-alpine
LABEL org.opencontainers.image.source=https://github.com/abs3ntdev/crossorbit
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080 8081 9090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
