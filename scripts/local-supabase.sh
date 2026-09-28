#!/bin/bash
# Throwaway local Supabase with this repo's migrations and functions, for
# end-to-end tests such as scripts/verify-server-auth.mjs. It runs from a copy
# under /tmp and never talks to the hosted project.
#   bash scripts/local-supabase.sh start | stop
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
DIR=${BWEEP_LOCAL_SUPABASE:-/tmp/bweeep-local-supabase}
CLI=(npx -y supabase@2)

case "${1:-start}" in
  start)
    rm -rf "$DIR"; mkdir -p "$DIR"
    cp -r "$REPO/supabase" "$DIR/"
    cd "$DIR"
    sed -i 's/^project_id = .*/project_id = "bweeep-local-check"/' supabase/config.toml
    # Asymmetric keys like production, so getClaims verifies tokens locally.
    "${CLI[@]}" gen signing-key --algorithm ES256 > supabase/signing_keys.json 2>/dev/null
    node -e 'const fs=require("fs");const p="supabase/signing_keys.json";const k=JSON.parse(fs.readFileSync(p,"utf8"));fs.writeFileSync(p,JSON.stringify(Array.isArray(k)?k:[k]))'
    sed -i '/^\[auth\]/a signing_keys_path = "./signing_keys.json"' supabase/config.toml
    # Texture URLs must use an address the game reaches, not the container address.
    sed -i 's|^# \[edge_runtime.secrets\]|[edge_runtime.secrets]\nBWEEP_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321"|' supabase/config.toml
    # rls_auto_enable() only exists on the hosted project.
    cat > supabase/migrations/20260915132059_revoke_rls_auto_enable_execute.sql <<'EOF'
do $$ begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
EOF
    "${CLI[@]}" start -x studio,imgproxy,mailpit,realtime,logflare,vector,supavisor,postgres-meta 2>&1 | grep -v -i 'key\|secret\|token' | tail -8
    ;;
  stop)
    if [ -d "$DIR" ]; then (cd "$DIR" && "${CLI[@]}" stop --no-backup); rm -rf "$DIR"; fi
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
