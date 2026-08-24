#!/usr/bin/env bash
# ============================================================================
# backup-tenant-offsite.sh
#
# AP3.2 (Wochenplaner-Mandantenfaehigkeit): Host-seitiger Orchestrierungs-
# Wrapper fuer den vollstaendigen Per-Tenant-Backup-Ablauf:
#   1. Export ueber app/scripts/export-tenant.mjs (Owner-Rolle, siehe dort)
#   2. Verschluesselung per GPG (symmetrisch, AES256, Passphrase-Datei)
#   3. Pruefsumme (SHA-256) fuer spaetere Integritaetspruefung nach Transfer
#   4. Ablage im Offsite-Ziel (siehe Hinweis unten -- lokal SIMULIERT)
#
# WICHTIG -- OFFSITE-ZIEL IST LOKAL SIMULIERT:
#   $OFFSITE_DIR (Default: ./ops/offsite-backup-simulation) ist ein lokales
#   Verzeichnis, das ein externes/offsite Ziel NUR STRUKTURELL nachbildet
#   (getrennter Pfad, keine Kunden-DB-Zugriffsrechte). Fuer den echten
#   produktiven Rollout MUSS dieser letzte Schritt (Zeile "OFFSITE-TRANSFER")
#   durch einen echten Offsite-Mechanismus mit eigenen Zugangsdaten des
#   Nutzers ersetzt werden (z. B. rclone/restic zu einem S3-kompatiblen
#   Objektspeicher oder scp/rsync zu einem zweiten, unabhaengigen Host) --
#   siehe ap3.2-backup-konzept.md, Abschnitt "Offsite-Ziel (Runbook)".
#
# Voraussetzungen:
#   - laufender Compose-Stack im aktuellen Arbeitsverzeichnis
#     (docker compose ps -> app/db healthy)
#   - Schluesseldatei unter secrets/backup-encryption.key (chmod 600,
#     NICHT versioniert -- siehe .gitignore *.key). Erzeugen mit:
#       openssl rand -base64 32 > secrets/backup-encryption.key
#       chmod 600 secrets/backup-encryption.key
#
# Aufruf:
#   ./ops/backup-tenant-offsite.sh <household_id> [Label]
#
# Beispiel:
#   ./ops/backup-tenant-offsite.sh 6 "ap31-test-kunde-e"
# ============================================================================
set -euo pipefail

HOUSEHOLD_ID="${1:?Verwendung: backup-tenant-offsite.sh <household_id> [Label]}"
LABEL="${2:-tenant}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
KEY_FILE="${BACKUP_KEY_FILE:-$STACK_DIR/secrets/backup-encryption.key}"
OFFSITE_DIR="${OFFSITE_DIR:-$STACK_DIR/ops/offsite-backup-simulation}"

if [ ! -f "$KEY_FILE" ]; then
  echo "Fehler: Schluesseldatei nicht gefunden: $KEY_FILE" >&2
  echo "Erzeugen mit:  openssl rand -base64 32 > \"$KEY_FILE\" && chmod 600 \"$KEY_FILE\"" >&2
  exit 1
fi
if [ "$(stat -c '%a' "$KEY_FILE" 2>/dev/null || stat -f '%Lp' "$KEY_FILE" 2>/dev/null)" != "600" ]; then
  echo "Warnung: $KEY_FILE hat nicht die Rechte 600 -- bitte pruefen (chmod 600 \"$KEY_FILE\")." >&2
fi

mkdir -p "$OFFSITE_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME="tenant-${HOUSEHOLD_ID}-${LABEL}-${TIMESTAMP}"
ENC_FILE="$OFFSITE_DIR/${BASENAME}.json.gpg"
SUM_FILE="$OFFSITE_DIR/${BASENAME}.json.gpg.sha256"

echo "==> Exportiere household_id=$HOUSEHOLD_ID (Owner-Rolle, DB-seitig gefiltert) ..." >&2
cd "$STACK_DIR"
docker compose exec -T app node scripts/export-tenant.mjs --household-id "$HOUSEHOLD_ID" \
  | gpg --batch --yes --passphrase-file "$KEY_FILE" --symmetric --cipher-algo AES256 -o "$ENC_FILE"

echo "==> Verschluesselt: $ENC_FILE" >&2

sha256sum "$ENC_FILE" | awk '{print $1}' > "$SUM_FILE"
echo "==> Pruefsumme:     $SUM_FILE ($(cat "$SUM_FILE"))" >&2

# --- OFFSITE-TRANSFER (hier: SIMULIERT, da bereits Ziel = $OFFSITE_DIR) ---
# Produktiv wuerde an dieser Stelle z. B. stehen:
#   rclone copy "$ENC_FILE" "$SUM_FILE" remote:wochenplaner-backups/
# oder:
#   rsync -avz "$ENC_FILE" "$SUM_FILE" backup-host:/srv/backups/wochenplaner/
# siehe ap3.2-backup-konzept.md fuer den vollstaendigen Runbook-Text.
echo "==> [SIMULIERT] Offsite-Ablage abgeschlossen unter: $OFFSITE_DIR" >&2
echo "$ENC_FILE"
