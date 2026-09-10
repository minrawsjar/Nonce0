# The executor and the egress. One image, two entrypoints, because they share
# every dependency and differ only in which file they run.
#
# The relay has its own image at backend/mesh/deploy/Dockerfile. Kept separate
# on purpose: a relay must be runnable by someone who runs nothing else of
# ours, and a relay operator should not be handed an image that also contains
# the component holding a key that can move money.
FROM node:22-alpine

RUN addgroup -S opaque && adduser -S -G opaque opaque
WORKDIR /app

# One install per directory: a bare import resolves from the importing file's
# own node_modules, so packages/* need theirs too. (Before .dockerignore this
# "worked" by copying the host's node_modules — and the host's secrets.)
COPY packages/protocol-types/package.json packages/protocol-types/package-lock.json ./packages/protocol-types/
COPY packages/pq-wallet/package.json packages/pq-wallet/package-lock.json ./packages/pq-wallet/
COPY backend/package.json backend/package-lock.json ./backend/
RUN for d in packages/protocol-types packages/pq-wallet backend; do \
      npm ci --omit=dev --no-audit --no-fund --prefix "$d" || exit 1; done

COPY packages/protocol-types ./packages/protocol-types
COPY packages/pq-wallet ./packages/pq-wallet
COPY backend ./backend

# Secrets are mounted or passed in the environment, never baked into a layer.
VOLUME ["/config"]
USER opaque

# No default script: `docker run ... node backend/cre/run-executor.ts` or
# `... node backend/mesh/run-egress.ts`. Naming the role at run time keeps it
# visible in `docker ps` instead of hidden behind an image tag.
ENTRYPOINT ["node"]
