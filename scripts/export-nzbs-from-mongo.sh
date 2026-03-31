#!/bin/bash
# Export all NZB files from MongoDB to disk as {hash}.nzb
set -euo pipefail

NZB_DIR="/Users/jakob/git/openmedia-api/nzb-files"
mkdir -p "$NZB_DIR"

echo "[export] Counting versions with NZB data..."

# Get list of all hashes that have nzbFile data
docker exec mongo mongosh \
  --tls \
  --tlsCertificateKeyFile /etc/ssl/mongodb/client.pem \
  --tlsCAFile /etc/ssl/mongodb/ca.pem \
  --tlsAllowInvalidHostnames \
  -u root -p 'wirsindddie237J#0Mn' \
  --authenticationDatabase admin \
  --quiet \
  --eval "
db = db.getSiblingDB('media_cms');
db.movies.find({'versions.nzbFile': {\$exists: true, \$ne: ''}}).forEach(movie => {
  movie.versions.forEach(v => {
    if (v.nzbFile && v.hash) {
      print(v.hash);
    }
  });
});
" > /tmp/nzb-hashes.txt 2>/dev/null

TOTAL=$(wc -l < /tmp/nzb-hashes.txt | tr -d ' ')
echo "[export] Found ${TOTAL} versions with NZB data"

COUNT=0
SKIPPED=0
while IFS= read -r HASH; do
  DEST="${NZB_DIR}/${HASH}.nzb"
  
  if [ -f "$DEST" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  docker exec mongo mongosh \
    --tls \
    --tlsCertificateKeyFile /etc/ssl/mongodb/client.pem \
    --tlsCAFile /etc/ssl/mongodb/ca.pem \
    --tlsAllowInvalidHostnames \
    -u root -p 'wirsindddie237J#0Mn' \
    --authenticationDatabase admin \
    --quiet \
    --eval "
db = db.getSiblingDB('media_cms');
const movie = db.movies.findOne({'versions.hash': '${HASH}'});
if (movie) {
  const v = movie.versions.find(x => x.hash === '${HASH}');
  if (v && v.nzbFile) print(v.nzbFile);
}
" > "$DEST" 2>/dev/null

  if [ -s "$DEST" ]; then
    COUNT=$((COUNT + 1))
    echo "[export] ${COUNT}/${TOTAL} exported: ${HASH:0:16}..."
  else
    rm -f "$DEST"
    echo "[export] WARN: empty NZB for ${HASH:0:16}..."
  fi
done < /tmp/nzb-hashes.txt

echo "[export] Done. Exported: ${COUNT}, Skipped: ${SKIPPED}, Total: ${TOTAL}"
