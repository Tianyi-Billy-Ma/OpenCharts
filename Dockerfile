# OpenCharts backend + terminal in one image.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:desk

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/lib ./src/lib
COPY opencharts.config.ts package.json ./
# SQLite lives here; mount a volume on it to keep approvals across rebuilds.
RUN mkdir data && chown node data
USER node
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
