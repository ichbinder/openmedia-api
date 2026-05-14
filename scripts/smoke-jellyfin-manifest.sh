#!/usr/bin/env bash
# Smoke-Test: Jellyfin Plugin Setup + Manifest Endpoint
#
# Flow:
#   1. Login mit OPENMEDIA_EMAIL/OPENMEDIA_PASSWORD → JWT
#   2. POST /jellyfin/plugin/setup → {manifestUrl, tokenId}
#   3. GET manifestUrl → valides Jellyfin-Manifest (200, JSON-Array mit guid/name/versions)
#   4. DELETE /auth/api-tokens/:tokenId → Token revoken
#   5. GET manifestUrl → 401 (revoked)
#
# Erforderlich:
#   - jq installiert
#   - Lokale API laeuft auf API_BASE_URL (Default: http://localhost:4000)
#   - Test-User existiert (OPENMEDIA_EMAIL, OPENMEDIA_PASSWORD)
#
# Exit-Code 0 = alle Checks gruen.
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:4000}"
OPENMEDIA_EMAIL="${OPENMEDIA_EMAIL:-}"
OPENMEDIA_PASSWORD="${OPENMEDIA_PASSWORD:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "FEHLER: jq nicht gefunden. brew install jq" >&2
  exit 2
fi

if [[ -z "$OPENMEDIA_EMAIL" || -z "$OPENMEDIA_PASSWORD" ]]; then
  echo "FEHLER: OPENMEDIA_EMAIL und OPENMEDIA_PASSWORD muessen gesetzt sein." >&2
  echo "Beispiel: OPENMEDIA_EMAIL=jakob@example.com OPENMEDIA_PASSWORD=xxx bash $0" >&2
  exit 2
fi

echo "==> API_BASE_URL=$API_BASE_URL"

# ---------------------------------------------------------------------------
# Schritt 0: API erreichbar?
# ---------------------------------------------------------------------------
echo "==> 0/5 Health-Check"
if ! curl -sS -o /dev/null -w "%{http_code}" "$API_BASE_URL/health" | grep -qE "^(200|404)$"; then
  echo "FEHLER: API unter $API_BASE_URL nicht erreichbar." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Schritt 1: Login → JWT
# ---------------------------------------------------------------------------
echo "==> 1/5 Login als $OPENMEDIA_EMAIL"
LOGIN_RESP=$(curl -sS -X POST "$API_BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg e "$OPENMEDIA_EMAIL" --arg p "$OPENMEDIA_PASSWORD" '{email:$e,password:$p}')")
JWT=$(echo "$LOGIN_RESP" | jq -r '.token // empty')
if [[ -z "$JWT" ]]; then
  echo "FEHLER: Kein JWT in Login-Response: $LOGIN_RESP" >&2
  exit 1
fi
echo "    OK — JWT len=${#JWT}"

# ---------------------------------------------------------------------------
# Schritt 2: POST /jellyfin/plugin/setup
# ---------------------------------------------------------------------------
echo "==> 2/5 POST /jellyfin/plugin/setup"
SETUP_RESP=$(curl -sS -X POST "$API_BASE_URL/jellyfin/plugin/setup" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json")
MANIFEST_URL=$(echo "$SETUP_RESP" | jq -r '.manifestUrl // empty')
TOKEN_ID=$(echo "$SETUP_RESP" | jq -r '.tokenId // empty')
TOKEN_NAME=$(echo "$SETUP_RESP" | jq -r '.name // empty')
if [[ -z "$MANIFEST_URL" || -z "$TOKEN_ID" ]]; then
  echo "FEHLER: Setup-Response fehlerhaft: $SETUP_RESP" >&2
  exit 1
fi
echo "    OK — tokenId=$TOKEN_ID name=\"$TOKEN_NAME\""
echo "    Manifest-URL: $MANIFEST_URL"

# ---------------------------------------------------------------------------
# Schritt 3: GET manifestUrl → 200 + valides Manifest
# ---------------------------------------------------------------------------
echo "==> 3/5 GET manifestUrl (erwartet 200 + JSON-Array)"
TMP_HEADERS=$(mktemp)
TMP_BODY=$(mktemp)
trap 'rm -f "$TMP_HEADERS" "$TMP_BODY"' EXIT
HTTP_CODE=$(curl -sS -o "$TMP_BODY" -D "$TMP_HEADERS" -w "%{http_code}" "$MANIFEST_URL")
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "FEHLER: Manifest GET lieferte HTTP $HTTP_CODE, erwartet 200" >&2
  cat "$TMP_BODY" >&2
  exit 1
fi
# Struktur-Check: Array mit mind. einem Eintrag, der guid/name/versions hat
if ! jq -e 'type == "array" and length >= 1 and (.[0] | has("guid") and has("name") and has("versions") and (.versions | type == "array"))' "$TMP_BODY" >/dev/null; then
  echo "FEHLER: Manifest-Struktur ungueltig:" >&2
  cat "$TMP_BODY" >&2
  exit 1
fi
ENTRIES=$(jq 'length' "$TMP_BODY")
FIRST_NAME=$(jq -r '.[0].name' "$TMP_BODY")
FIRST_VERSIONS=$(jq '.[0].versions | length' "$TMP_BODY")
echo "    OK — entries=$ENTRIES first.name=\"$FIRST_NAME\" first.versions=$FIRST_VERSIONS"

# ---------------------------------------------------------------------------
# Schritt 4: Token revoken
# ---------------------------------------------------------------------------
echo "==> 4/5 DELETE /auth/api-tokens/$TOKEN_ID"
REVOKE_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X DELETE "$API_BASE_URL/auth/api-tokens/$TOKEN_ID" \
  -H "Authorization: Bearer $JWT")
if [[ "$REVOKE_CODE" != "200" && "$REVOKE_CODE" != "204" ]]; then
  echo "FEHLER: Revoke lieferte HTTP $REVOKE_CODE, erwartet 200/204" >&2
  exit 1
fi
echo "    OK — HTTP $REVOKE_CODE"

# ---------------------------------------------------------------------------
# Schritt 5: GET manifestUrl nach Revoke → 401
# ---------------------------------------------------------------------------
echo "==> 5/5 GET manifestUrl nach Revoke (erwartet 401)"
REVOKED_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$MANIFEST_URL")
if [[ "$REVOKED_CODE" != "401" ]]; then
  echo "FEHLER: Manifest nach Revoke lieferte HTTP $REVOKED_CODE, erwartet 401" >&2
  exit 1
fi
echo "    OK — HTTP 401"

echo
echo "==> Alle 5 Checks gruen."
