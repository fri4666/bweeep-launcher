#!/bin/bash
set -euo pipefail
# Run only after the human owner approves Let's Encrypt registration and terms.
test "${BWEEP_LE_TERMS_ACCEPTED:-}" = yes || {
  echo "Explicit owner approval for Let's Encrypt registration and terms is required." >&2
  exit 1
}
install -d -m 755 /var/www/bweeep-acme
certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
  --preferred-profile shortlived --webroot --webroot-path /var/www/bweeep-acme \
  --ip-address 158.247.246.225 --cert-name 158.247.246.225 \
  --deploy-hook "systemctl reload nginx"
systemctl enable --now certbot.timer
