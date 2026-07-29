#!/usr/bin/env bash
# Fail if more than one Vercel project is linked to yjgoja/super-alpha.
# Prevents accidental `vercel link` creating a second project (e.g. "workspace")
# that redeploys on every push and emails build failures.
set -euo pipefail

TEAM="${VERCEL_TEAM_SCOPE:-watch-s-projects}"
REPO_SLUG="${VERCEL_EXPECTED_REPO:-yjgoja/super-alpha}"
EXPECTED_PROJECT="${VERCEL_EXPECTED_PROJECT:-super-alpha}"

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "SKIP: VERCEL_TOKEN not set (ok for local without token)."
  exit 0
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl -fsS -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v9/projects?teamId=${TEAM}&limit=100" >"$TMP"

LINKED="$(
  python3 - "$TMP" "$REPO_SLUG" <<'PY'
import json, sys
path, slug = sys.argv[1], sys.argv[2]
data = json.load(open(path))
names = []
for p in data.get("projects") or []:
    link = p.get("link") or {}
    if f"{link.get('org')}/{link.get('repo')}" == slug:
        names.append(p.get("name") or "?")
print("\n".join(sorted(names)))
PY
)"

COUNT="$(printf '%s\n' "$LINKED" | sed '/^$/d' | wc -l | tr -d ' ')"

echo "Vercel projects linked to ${REPO_SLUG}:"
if [[ -z "$LINKED" ]]; then
  echo "  (none)"
else
  printf '%s\n' "$LINKED" | sed 's/^/  - /'
fi

if [[ "$COUNT" -eq 0 ]]; then
  echo "ERROR: no Vercel project linked to ${REPO_SLUG}."
  exit 1
fi

if [[ "$COUNT" -ne 1 ]]; then
  echo "ERROR: expected exactly 1 linked project (${EXPECTED_PROJECT}), found ${COUNT}."
  echo "Delete extras in Vercel dashboard or unlink git — do not create a second project via vercel link."
  exit 1
fi

if [[ "$LINKED" != "$EXPECTED_PROJECT" ]]; then
  echo "ERROR: linked project is '${LINKED}', expected '${EXPECTED_PROJECT}'."
  exit 1
fi

echo "OK: only ${EXPECTED_PROJECT} is linked."
