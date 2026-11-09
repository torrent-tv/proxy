# The proxy as a container: exactly the npm package, its production
# dependencies, node and ffmpeg — nothing else. The image is built from the
# package `npm pack` makes, so `files` in package.json is the one list of what
# ships, here and on npm alike.
#
#   docker build -t torrent-tv-proxy .
#   docker run --network host -v ttv-proxy:/data torrent-tv-proxy --server-url https://webauth.courses

# Alpine comes from Google's mirror of Docker's official images (the same
# digest, sha256:294b683c…). Docker Hub and Amazon's copy both refuse
# anonymous pulls past a per-address limit, and the CI runners share their
# addresses: Docker Hub stopped the release twice on 2026-10-09, Amazon's
# copy four times running on 2026-10-16 ("toomanyrequests: Data limit exceeded").
# Every stage takes node from Alpine's own package, as the add-on does, so the
# native modules are compiled for the node that runs them.
FROM mirror.gcr.io/library/alpine:3 AS dependencies
# utp-native ships no musl prebuild, so it is compiled here.
RUN apk add --no-cache nodejs npm python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
# Install scripts are off for the whole tree: ip-set (a dependency of
# webtorrent) runs `npx only-allow pnpm` in `preinstall`, which aborts a plain
# npm install, and ffmpeg-static would download an ffmpeg this image does not
# use. The two native modules that need theirs are built, and checked, by
# scripts/install-native.sh — the one build every image of the proxy runs.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY scripts/install-native.sh scripts/install-native.sh
RUN sh scripts/install-native.sh /app

FROM mirror.gcr.io/library/alpine:3 AS package
RUN apk add --no-cache nodejs npm
WORKDIR /src
COPY . .
RUN npm pack --ignore-scripts --pack-destination /tmp \
 && mkdir /app \
 && tar -xzf /tmp/torrent-tv-proxy-*.tgz -C /app --strip-components=1

# The runtime has node and ffmpeg; npm stays in the stages that install.
FROM mirror.gcr.io/library/alpine:3
RUN apk add --no-cache nodejs ffmpeg \
 && addgroup -S app && adduser -S -G app app \
 && mkdir /data && chown app:app /data
COPY --from=package /app /app
COPY --from=dependencies /app/node_modules /app/node_modules

ENV NODE_ENV=production
USER app
WORKDIR /app

# The image checks itself: `--help` loads every module of the main thread,
# node-datachannel's native binding included, and exits before anything is
# started or connected, so the build fails when this node cannot load what the
# first stage built.
RUN node /app/bin/cli.js --help > /dev/null

# 9090/tcp is the HTTP API; WebRTC uses the same port number over UDP. Reaching
# peers and viewers from a bridge network needs both published, so host
# networking is what the README recommends.
EXPOSE 9090/tcp 9090/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9090/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# /data keeps what the host has measured about itself, its identity and its
# diagnostics across container recreation. Arguments given to `docker run`
# follow these, so `--server-url` is the one a user must add.
ENTRYPOINT ["node", "/app/bin/cli.js", "--host", "0.0.0.0", "--port", "9090", "--ffmpeg-bin", "/usr/bin/ffmpeg", "--state-dir", "/data"]
