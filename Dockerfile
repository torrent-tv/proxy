# syntax=docker/dockerfile:1.7
FROM node:24-alpine

ENV NODE_ENV=production
ENV PORT=9090
ENV HOST=0.0.0.0

WORKDIR /app

# ffmpeg is needed for optional HLS audio transcode mode.
RUN apk add --no-cache ffmpeg

# Create an unprivileged runtime user.
RUN addgroup -S app && adduser -S -G app app

# Install only production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application sources.
COPY --chown=app:app . .

USER app

EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch(`http://127.0.0.1:${process.env.PORT || 9090}/healthz`).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-ec", "if [ -z \"${SERVER_URL:-}\" ]; then echo 'SERVER_URL is required' >&2; exit 1; fi; exec node ./bin/cli.js --server-url \"$SERVER_URL\" --host \"$HOST\" --port \"$PORT\" ${PROXY_EXTRA_ARGS:-}"]
