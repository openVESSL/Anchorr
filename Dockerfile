# use a stable node LTS
FROM node:18-alpine

# create app dir first
WORKDIR /usr/src/app

# install app dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# copy source
COPY . .

# create non-root user
RUN addgroup -S app && adduser -S -G app app && \
    chown -R app:app /usr/src/app && \
    chmod -R 755 /usr/src/app

EXPOSE 8282

# Docker metadata
LABEL org.opencontainers.image.title="Anchorr" \
      org.opencontainers.image.description="Discord bot for requesting media and Jellyfin notifications" \
      org.opencontainers.image.authors="nairdahh" \
      org.opencontainers.image.url="https://github.com/nairdahh/anchorr" \
      org.opencontainers.image.documentation="https://github.com/nairdahh/anchorr/blob/main/README.md" \
      org.opencontainers.image.source="https://github.com/nairdahh/anchorr" \
      org.opencontainers.image.version="1.4.9" \
      org.opencontainers.image.icon="https://raw.githubusercontent.com/nairdahh/anchorr/main/assets/logo.png" \
      org.opencontainers.image.volumes="/usr/src/app/config" \
      com.example.webui="http://localhost:8282" \
      org.unraid.icon="https://raw.githubusercontent.com/nairdahh/anchorr/main/assets/logo.png" \
      org.unraid.category="MediaServer:Other" \
      org.unraid.support="https://github.com/nairdahh/anchorr/issues" \
      org.unraid.webui="http://[IP]:[PORT:8282]" \
      org.unraid.volume.config="/usr/src/app/config" \
      org.unraid.volume.config.description="Configuration files (REQUIRED for persistence)" \
      webui.port="8282" \
      webui.protocol="http"

# set production mode
ENV NODE_ENV=production

# Create config directory inside the app for persistent storage
# This keeps config with the application and avoids permission issues
RUN mkdir -p /usr/src/app/config && chown app:app /usr/src/app/config && chmod 755 /usr/src/app/config

# Declare config directory as a persistent volume
# This ensures data persists when container is recreated/updated
VOLUME ["/usr/src/app/config"]

# Switch to non-root user for runtime
# Volume mounts need to allow writes by uid/gid of the app user.
# On Docker: chown the host directory or use `userns-remap`.
# On Unraid: set the host path permissions to 777 or match the container user.
USER app

CMD ["node", "app.js"]
