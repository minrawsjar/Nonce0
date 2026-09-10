# The whole stack as ONE service, for a PaaS that gives one port and one TLS
# name (Railway: railway.json points here). docs/hosting.md.
#
# Six relays, the exit, the CRE stand-in, the egress and the credential
# authority in one process, every public route on $PORT. One box, one
# operator: the wallet's footer says so.
FROM node:22-alpine

RUN addgroup -S opaque && adduser -S -G opaque opaque
WORKDIR /app

# .dockerignore keeps .env, .stack and every .key out of this COPY. Secrets
# arrive as the service's environment variables, never in a layer.
COPY . .

# One install per directory: a bare import resolves from the importing file's
# own node_modules, and stack.ts reaches into all of these.
RUN for d in packages/protocol-types packages/pq-wallet packages/ring-client graph backend; do \
      npm ci --omit=dev --no-audit --no-fund --prefix "$d" || exit 1; done \
 && mkdir -p backend/.stack frontend/public \
 && chown opaque:opaque backend/.stack frontend/public

USER opaque
WORKDIR /app/backend
CMD ["node", "stack.ts"]
