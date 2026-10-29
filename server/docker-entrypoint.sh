#!/bin/sh
set -eu

umask 077
if [ "$(id -u)" -eq 0 ]; then
  echo "Run this service as a dedicated non-root user." >&2
  exit 1
fi
exec node src/index.js
