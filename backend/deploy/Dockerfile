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

COPY packages/protocol-types/package.json ./packages/protocol-types/
COPY packages/pq-wallet/package.json ./packages/pq-wallet/
COPY backend/package.json ./backend/
RUN cd backend && npm install --omit=dev --no-audit --no-fund

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
