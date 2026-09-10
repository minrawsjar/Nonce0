# One relay. Three of these, run by three different people, is the mesh.
#
# Node 22.18+ strips TypeScript natively, so there is no build step and no
# bundler: the image runs the source. That is deliberate — an operator can read
# exactly what they are running, which matters more here than image size, since
# the whole premise is that you do not have to trust the other two relays.
FROM node:22-alpine

# Not root. A relay holds an ML-KEM secret key; a container escape from root is
# a mesh-wide compromise rather than one relay's.
RUN addgroup -S opaque && adduser -S -G opaque opaque

WORKDIR /app

# Dependencies first, so a code change does not re-resolve the tree.
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

# The signed directory, the pinned trust root and this relay's secret key are
# MOUNTED, never baked in. A key in an image layer is a key in every registry
# that image is ever pushed to.
VOLUME ["/config"]

USER opaque
EXPOSE 8080

# No default --id: a relay that starts as whoever it feels like is a relay that
# silently answers for another one. The operator must say who this is.
ENTRYPOINT ["node", "backend/mesh/run-relay.ts", \
            "--port", "8080", \
            "--directory", "/config/directory.json", \
            "--trust-root", "/config/trust-root.json"]
