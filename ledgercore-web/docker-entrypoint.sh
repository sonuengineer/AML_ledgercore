#!/bin/sh
set -e

# Runtime configuration for a static build.
#
# THE PROBLEM
#
# Vite inlines `import.meta.env.VITE_*` at BUILD time. A naive setup therefore
# needs one image per environment -- staging and production differ only in an
# API URL, yet ship different artefacts. What was tested in staging is then
# not what runs in production, which defeats the point of staging.
#
# THE APPROACH
#
# Write the environment-specific values into a small config file at CONTAINER
# START, and have the app read them from `window`. One image, promoted
# unchanged from staging to production, configured by env vars like every
# other container.
#
# This is, notably, exactly what the legacy FinCore frontend did: Phase 0 found
# `Frontend/public/config.js` loaded at runtime so one build could be deployed
# per bank (WBIDFC, MCB, Janseva...) without a rebuild. That part of the legacy
# design was right, and is worth keeping.

CONFIG_FILE=/usr/share/nginx/html/config.js

cat > "$CONFIG_FILE" <<JSON
window.__LEDGERCORE_CONFIG__ = {
  apiBaseUrl: "${API_BASE_URL:-/api/v1}",
  environment: "${APP_ENV:-production}"
};
JSON

echo "runtime config written: apiBaseUrl=${API_BASE_URL:-/api/v1} environment=${APP_ENV:-production}"
