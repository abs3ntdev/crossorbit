FROM node:24-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
LABEL org.opencontainers.image.source=https://github.com/abs3ntdev/crossorbit
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080 9090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "dist/index.js"]
