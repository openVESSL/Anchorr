#!/bin/sh
# Fix ownership of the config volume mount so the non-root app user can write to it.
# Docker auto-creates bind-mount directories as root on the host, which blocks writes
# from the app user. Running this as root before dropping privileges fixes that.
chown -R app:app /usr/src/app/config
exec su-exec app "$@"
