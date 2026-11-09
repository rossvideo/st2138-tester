# Multi-stage build for Test-Your-Catena

# Compile portable JavaScript and run tests natively, even when cross-building.
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY src ./src
COPY tests ./tests
COPY scripts/copy-ui.mjs ./scripts/
COPY vendor ./vendor

# Build TypeScript
RUN npm test && npm run build

# Runtime stage
FROM node:24-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk upgrade --no-cache && apk add --no-cache dumb-init

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /opt/yarn* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy the vendored SMPTE st2138-a submodule. The app uses its tools/src validator
# at runtime (schema validation + conformance checks) and compiles
# tools/src/data/device.json from interface/schema/device.yaml on first use — no
# runtime downloads. NOTE: the submodule must be checked out on the host before
# building (`git submodule update --init --recursive`), since .git is excluded
# from the build context.
COPY vendor ./vendor

ENV NODE_ENV=production PORT=3000
RUN mkdir -p vendor/st2138-a/tools/src/data \
  && chown -R node:node vendor/st2138-a/tools/src/data
USER node

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const req = require('http').get('http://127.0.0.1:3000/health', res => process.exit(res.statusCode === 200 ? 0 : 1)); req.on('error', () => process.exit(1)); req.setTimeout(2000, () => { req.destroy(); process.exit(1); });"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/server.js"]
