# install dependencies natively on the build host, not under QEMU emulation
# (works because all dependencies are pure JavaScript)
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev

# build the dashboard (React) on the build host; only its static output ships
FROM --platform=$BUILDPLATFORM node:22-alpine AS dashboard
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# use a stable node LTS
FROM node:22-alpine

# create app dir first
WORKDIR /usr/src/app

# install app dependencies
COPY package*.json ./
COPY --from=deps /usr/src/app/node_modules ./node_modules
RUN apk add --no-cache su-exec

# copy source
COPY . .
COPY --from=dashboard /build/dist ./frontend/dist
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Non-root user. The application files stay owned by root (read-only for the app);
# only the config and log directories are writable.
RUN addgroup -S app && adduser -S -G app app && \
    mkdir -p /usr/src/app/config /usr/src/app/logs && \
    chown app:app /usr/src/app/config /usr/src/app/logs

EXPOSE 8282

# Docker metadata
LABEL org.opencontainers.image.title="Anchorr" \
      org.opencontainers.image.description="Discord bot for requesting media and Jellyfin notifications" \
      org.opencontainers.image.authors="nairdahh" \
      org.opencontainers.image.url="https://github.com/openVESSL/Anchorr" \
      org.opencontainers.image.documentation="https://github.com/openVESSL/Anchorr/blob/main/README.md" \
      org.opencontainers.image.source="https://github.com/openVESSL/Anchorr" \
      org.opencontainers.image.icon="https://raw.githubusercontent.com/openVESSL/Anchorr/main/assets/logo.png" \
      org.opencontainers.image.volumes="/usr/src/app/config" \
      com.example.webui="http://localhost:8282" \
      org.unraid.icon="https://raw.githubusercontent.com/openVESSL/Anchorr/main/assets/logo.png" \
      org.unraid.category="MediaServer:Other" \
      org.unraid.support="https://github.com/openVESSL/Anchorr/issues" \
      org.unraid.webui="http://[IP]:[PORT:8282]" \
      org.unraid.volume.config="/usr/src/app/config" \
      org.unraid.volume.config.description="Configuration files (REQUIRED for persistence)" \
      webui.port="8282" \
      webui.protocol="http"

# set production mode
ENV NODE_ENV=production

# Declare config directory as a persistent volume
# This ensures data persists when container is recreated/updated
VOLUME ["/usr/src/app/config"]

# Entrypoint runs as root, fixes volume ownership, then drops to the app user
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "app.js"]
