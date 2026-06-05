# syntax=docker/dockerfile:1
#
# GraphPilot — MCP server over stdio.
#
# The default command starts the server, which answers JSON-RPC introspection
# (`initialize` / `tools/list`) on stdin. That handshake is what Glama's
# quality check exercises; no indexed repo is required for it to pass.
#
#   docker build -t graphpilot .
#   docker run --rm -i graphpilot          # speaks MCP over stdio

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# tree-sitter ships prebuilt binaries for common platforms; this toolchain is
# the node-gyp fallback for platforms without a matching prebuild.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Copy the whole context (pnpm workspace needs every package.json for a
# --frozen-lockfile install). node_modules/dist are excluded via .dockerignore
# so native addons are compiled for the image, not copied from the host.
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Optional: point GraphPilot at a repo to index/serve. Introspection works
# without it; clients usually pass GRAPHPILOT_ROOT or an MCP workspace root.
# ENV GRAPHPILOT_ROOT=/workspace

ENTRYPOINT ["node", "dist/cli.js", "mcp"]
