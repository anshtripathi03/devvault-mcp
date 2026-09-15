# Only the HTTP transport is served from a container. The stdio transport runs
# on the user's own machine via `npx @devvault/mcp` and is published to npm, not
# deployed here.

FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# No credentials baked in: the HTTP transport takes a bearer token per request,
# so one deployment serves every user and stores nothing.
ENV PORT=8080
EXPOSE 8080

# Don't run as root.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/bin/http.js"]
