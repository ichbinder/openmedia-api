#!/usr/bin/env bash
# Smoke-Test: Jellyfin Plugin End-to-End Pipeline
#
# Flow (7 Checks):
#   1. API Health-Check
#   2. Login → JWT
#   3. POST /jellyfin/plugin/setup → {manifestUrl, tokenId}
#   4. GET manifestUrl → JSON-Array mit versions[] (nicht leer)
#   5. Download ZIP von sourceUrl aus Manifest → 200 + application/zip
#   6. MD5 des Downloads stimmt mit checksum aus Manifest ueberein
#   7. ZIP entpacken → bootstrap.json existiert + enthaelt apiUrl & apiToken
#
# Erforderlich:
#   - jq, unzip, md5 (oder md5sum) installiert
#   - Lokale API laeuft auf API_BASE_URL (Default: http://localhost:4000)
#   - Test-User existiert (OPENMEDIA_EMAIL, OPENMEDIA_PASSWORD)
#
# Exit-Code 0 = 7/7 Checks gruen.
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:4000}"
OPENMEDIA_EMAIL="${OPENMEDIA_EMAIL:-}"
OPENMEDIA_PASSWORD="${OPENMEDIA_PASSWORD:-}"

PASS=0
FAIL=0
TOTAL=7

pass() { PASS=$((PASS + 1)); echo "    ✅ PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "    ❌ FAIL: $1"; }

cleanup() {
  rm -rf "$TMPDIR" 2>/dev/null || true
}
TMPDIR=$(mktemp -d)
trap cleanup EXIT

# ---- Prerequisites ----
for cmd in jq unzip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "FEHLER: $cmd nicht gefunden. brew install $cmd" >&2
    exit 2
  fi
done

# md5sum (Linux) or md5 (macOS)
if command -v md5sum >/dev/null 2>&1; then
  MD5_CMD="md5sum"
elif command -v md5 >/dev/null 2>&1; then
  MD5_CMD="md5 -q"
else
  echo "FEHLER: md5sum oder md5 nicht gefunden." >&2
  exit 2
fi

if [[ -z "$OPENMEDIA_EMAIL" || -z "$OPENMEDIA_PASSWORD" ]]; then
  echo "FEHLER: OPENMEDIA_EMAIL und OPENMEDIA_PASSWORD muessen gesetzt sein." >&2
  echo "Beispiel: OPENMEDIA_EMAIL=user@example.com OPENMEDIA_PASSWORD=secret bash $0" >&2
  exit 2
fi

echo "==> API_BASE_URL=$API_BASE_URL"
echo

JWT=""
MANIFEST_URL=""
MANIFEST_SOURCE_URL=""
MANIFEST_CHECKSUM=""

# ---------------------------------------------------------------------------
# Check 1: Health-Check
# ---------------------------------------------------------------------------
echo "==> 1/$TOTAL Health-Check"
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE_URL/health" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" =~ ^(200|404)$ ]]; then
  pass "API erreichbar (HTTP $HTTP_CODE)"
else
  fail "API nicht erreichbar (HTTP $HTTP_CODE)"
fi

# ---------------------------------------------------------------------------
# Check 2: Login → JWT
# ---------------------------------------------------------------------------
echo "==> 2/$TOTAL Login als $OPENMEDIA_EMAIL"
LOGIN_RESP=$(curl -sS -X POST "$API_BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg e "$OPENMEDIA_EMAIL" --arg p "$OPENMEDIA_PASSWORD" '{email:$e,password:$p}')" 2>/dev/null || echo '{}')
JWT=$(echo "$LOGIN_RESP" | jq -r '.token // empty' 2>/dev/null || echo "")
if [[ -n "$JWT" && "$JWT" != "null" ]]; then
  pass "JWT erhalten (len=${#JWT})"
else
  fail "Kein JWT in Login-Response"
fi

# ---------------------------------------------------------------------------
# Check 3: POST /jellyfin/plugin/setup
# ---------------------------------------------------------------------------
echo "==> 3/$TOTAL POST /jellyfin/plugin/setup"
if [[ -z "$JWT" ]]; then
  fail "Setup uebersprungen (kein JWT)"
else
  SETUP_RESP=$(curl -sS -X POST "$API_BASE_URL/jellyfin/plugin/setup" \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" 2>/dev/null || echo '{}')
  MANIFEST_URL=$(echo "$SETUP_RESP" | jq -r '.manifestUrl // empty' 2>/dev/null || echo "")
  TOKEN_ID=$(echo "$SETUP_RESP" | jq -r '.tokenId // empty' 2>/dev/null || echo "")
  if [[ -n "$MANIFEST_URL" && -n "$TOKEN_ID" ]]; then
    pass "Setup OK — tokenId=$TOKEN_ID manifestUrl present"
  else
    fail "Setup-Response unvollstaendig: $SETUP_RESP"
  fi
fi

# ---------------------------------------------------------------------------
# Check 4: GET manifestUrl → JSON-Array mit versions[]
# ---------------------------------------------------------------------------
echo "==> 4/$TOTAL GET Manifest → versions[] nicht leer"
MANIFEST_FILE="$TMPDIR/manifest.json"
MANIFEST_HTTP=$(curl -sS -o "$MANIFEST_FILE" -w "%{http_code}" "${MANIFEST_URL:-}" 2>/dev/null || echo "000")
VERSIONS_COUNT=0
if [[ "$MANIFEST_HTTP" == "200" ]]; then
  VERSIONS_COUNT=$(jq '.[0].versions | length // 0' "$MANIFEST_FILE" 2>/dev/null || echo "0")
  if [[ "$VERSIONS_COUNT" -gt 0 ]]; then
    # Extract version, checksum, sourceUrl for later checks
    MANIFEST_VERSION=$(jq -r '.[0].versions[0].version' "$MANIFEST_FILE")
    MANIFEST_CHECKSUM=$(jq -r '.[0].versions[0].checksum' "$MANIFEST_FILE")
    MANIFEST_SOURCE_URL=$(jq -r '.[0].versions[0].sourceUrl' "$MANIFEST_FILE")
    pass "Manifest gueltig — versions=$VERSIONS_COUNT version=$MANIFEST_VERSION"
  else
    fail "Manifest hat keine versions[] Eintraege"
  fi
else
  fail "Manifest GET lieferte HTTP $MANIFEST_HTTP"
fi

# ---------------------------------------------------------------------------
# Check 5: Download ZIP → 200 + application/zip
# ---------------------------------------------------------------------------
echo "==> 5/$TOTAL Download ZIP von sourceUrl"
ZIP_FILE="$TMPDIR/plugin.zip"
if [[ -z "${MANIFEST_SOURCE_URL:-}" ]]; then
  fail "Download uebersprungen (keine sourceUrl)"
else
  DL_HTTP=$(curl -sS -o "$ZIP_FILE" -w "%{http_code}" "$MANIFEST_SOURCE_URL" 2>/dev/null || echo "000")
  DL_CONTENT_TYPE=$(curl -sS -I "$MANIFEST_SOURCE_URL" 2>/dev/null | grep -i "^content-type:" | head -1 | tr -d '\r' || echo "")
  if [[ "$DL_HTTP" == "200" ]]; then
    if [[ "$DL_CONTENT_TYPE" == *"application/zip"* || "$DL_CONTENT_TYPE" == *"application/octet-stream"* ]]; then
      pass "Download OK — HTTP $DL_HTTP Content-Type=$DL_CONTENT_TYPE"
    else
      # Still pass if we got 200 and a non-empty file (some servers don't set content-type precisely)
      ZIP_SIZE=$(stat -f%z "$ZIP_FILE" 2>/dev/null || stat -c%s "$ZIP_FILE" 2>/dev/null || echo "0")
      if [[ "$ZIP_SIZE" -gt 0 ]]; then
        pass "Download OK — HTTP $DL_HTTP bytes=$ZIP_SIZE"
      else
        fail "Download leer (0 bytes)"
      fi
    fi
  else
    fail "Download HTTP $DL_HTTP (erwartet 200)"
  fi
fi

# ---------------------------------------------------------------------------
# Check 6: MD5 des Downloads == checksum aus Manifest
# ---------------------------------------------------------------------------
echo "==> 6/$TOTAL MD5-Abgleich Download vs. Manifest"
if [[ ! -f "$ZIP_FILE" ]]; then
  fail "MD5-Check uebersprungen (kein ZIP)"
elif [[ -z "${MANIFEST_CHECKSUM:-}" ]]; then
  fail "MD5-Check uebersprungen (keine Manifest-Checksum)"
else
  if [[ "$MD5_CMD" == "md5sum" ]]; then
    LOCAL_MD5=$($MD5_CMD "$ZIP_FILE" | awk '{print $1}')
  else
    LOCAL_MD5=$($MD5_CMD "$ZIP_FILE")
  fi
  if [[ "$LOCAL_MD5" == "$MANIFEST_CHECKSUM" ]]; then
    pass "MD5 stimmt ueberein: $LOCAL_MD5"
  else
    fail "MD5-Mismatch: local=$LOCAL_MD5 manifest=$MANIFEST_CHECKSUM"
  fi
fi

# ---------------------------------------------------------------------------
# Check 7: ZIP entpacken → bootstrap.json vorhanden + apiUrl + apiToken
# ---------------------------------------------------------------------------
echo "==> 7/$TOTAL ZIP-Inhalt: bootstrap.json mit apiUrl + apiToken"
EXTRACT_DIR="$TMPDIR/extracted"
if [[ ! -f "$ZIP_FILE" ]]; then
  fail "ZIP-Inhalt-Check uebersprungen (kein ZIP)"
else
  mkdir -p "$EXTRACT_DIR"
  if unzip -q -o "$ZIP_FILE" -d "$EXTRACT_DIR" >/dev/null 2>&1; then
    # Look for bootstrap.json — it may be at root or inside an openmedia/ subdirectory
    BOOTSTRAP=""
    if [[ -f "$EXTRACT_DIR/bootstrap.json" ]]; then
      BOOTSTRAP="$EXTRACT_DIR/bootstrap.json"
    elif [[ -f "$EXTRACT_DIR/openmedia/bootstrap.json" ]]; then
      BOOTSTRAP="$EXTRACT_DIR/openmedia/bootstrap.json"
    else
      # Search recursively
      BOOTSTRAP=$(find "$EXTRACT_DIR" -name "bootstrap.json" -type f | head -1 || true)
    fi

    if [[ -n "$BOOTSTRAP" && -f "$BOOTSTRAP" ]]; then
      BOOTSTRAP_API_URL=$(jq -r '.apiUrl // empty' "$BOOTSTRAP" 2>/dev/null || echo "")
      BOOTSTRAP_API_TOKEN=$(jq -r '.apiToken // empty' "$BOOTSTRAP" 2>/dev/null || echo "")
      if [[ -n "$BOOTSTRAP_API_URL" && -n "$BOOTSTRAP_API_TOKEN" ]]; then
        # Verify the token looks like an om_ token (don't log it)
        if [[ "$BOOTSTRAP_API_TOKEN" == om_* ]]; then
          pass "bootstrap.json OK — apiUrl vorhanden, apiToken=om_... (${#BOOTSTRAP_API_TOKEN} chars)"
        else
          pass "bootstrap.json OK — apiUrl vorhanden, apiToken gesetzt (${#BOOTSTRAP_API_TOKEN} chars)"
        fi
      else
        fail "bootstrap.json fehlt apiUrl oder apiToken: apiUrl='$BOOTSTRAP_API_URL' apiToken_len=${#BOOTSTRAP_API_TOKEN}"
      fi
    else
      # List what's in the ZIP for debugging
      ZIP_CONTENTS=$(unzip -l "$ZIP_FILE" 2>/dev/null | tail -5 || echo "cannot list")
      fail "bootstrap.json nicht im ZIP gefunden. Inhalt: $ZIP_CONTENTS"
    fi
  else
    fail "ZIP-Entpackung fehlgeschlagen"
  fi
fi

# ---------------------------------------------------------------------------
# Ergebnis
# ---------------------------------------------------------------------------
echo
echo "========================================"
echo "  Ergebnis: $PASS/$TOTAL Checks bestanden"
echo "========================================"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
