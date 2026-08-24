#!/usr/bin/env bash
# ============================================================================
# restore-tenant-from-offsite.sh
#
# AP3.2 (Wochenplaner-Mandantenfaehigkeit): Host-seitiger Orchestrierungs-
# Wrapper fuer den vollstaendigen Per-Tenant-Restore-Ablauf, Gegenstueck zu
# backup-tenant-offsite.sh:
#   1. Pruefsummenkontrolle (SHA-256) der abgeholten .json.gpg-Datei
#   2. Entschluesselung per GPG (dieselbe Passphrase-Datei wie beim Backup)
#   3. Restore ueber app/scripts/import-tenant.mjs (Owner-Rolle, isoliert
#      in eine Ziel-DB, siehe dort fuer die PK-/E-Mail-Kollisionsbehandlung)
#
# WICHTIG: Wie beim Backup ist $OFFSITE_DIR (Default:
# ./ops/offsite-backup-simulation) lokal simuliert -- siehe Kopfkommentar
# in backup-tenant-offsite.sh und ap3.2-backup-konzept.md.
#
# Aufruf:
#   ./ops/restore-tenant-from-offsite.sh <backup-datei.json.gpg> <ziel-db> [--dry-run] [--household-id N]
#
# Beispiel (Restore in eine isolierte Test-DB, keine automatische
# household_id-Wiederverwendung):
#   ./ops/restore-tenant-from-offsite.sh \
#     ops/offsite-backup-simulation/tenant-6-ap31-test-kunde-e-20260821T120000Z.json.gpg \
#     restore_test
# ============================================================================
set -euo pipefail

BACKUP_FILE="${1:?Verwendung: restore-tenant-from-offsite.sh <backup-datei.json.gpg> <ziel-db> [--dry-run] [--household-id N]}"
TARGET_DB="${2:?Ziel-Datenbankname fehlt (zweites Argument)}"
shift 2
IMPORT_ARGS=("$@")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
KEY_FILE="${BACKUP_KEY_FILE:-$STACK_DIR/secrets/backup-encryption.key}"

if [ ! -f "$KEY_FILE" ]; then
  echo "Fehler: Schluesseldatei nicht gefunden: $KEY_FILE" >&2
  exit 1
fi
if [ ! -f "$BACKUP_FILE" ]; then
  echo "Fehler: Backup-Datei nicht gefunden: $BACKUP_FILE" >&2
  exit 1
fi

SUM_FILE="${BACKUP_FILE}.sha256"
if [ -f "$SUM_FILE" ]; then
  echo "==> Pruefe Integritaet gegen $SUM_FILE ..." >&2
  ACTUAL="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
  EXPECTED="$(cat "$SUM_FILE")"
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "Fehler: Pruefsumme stimmt NICHT ueberein. Backup-Datei moeglicherweise beschaedigt/manipuliert." >&2
    echo "  erwartet: $EXPECTED" >&2
    echo "  gefunden: $ACTUAL" >&2
    exit 1
  fi
  echo "==> Pruefsumme ok." >&2
else
  echo "Warnung: keine .sha256-Datei zu $BACKUP_FILE gefunden -- Integritaet wird nicht geprueft." >&2
fi

echo "==> Entschluessle und spiele in Ziel-DB '$TARGET_DB' zurueck ..." >&2
cd "$STACK_DIR"
gpg --batch --yes --passphrase-file "$KEY_FILE" --decrypt "$BACKUP_FILE" 2>/dev/null \
  | docker compose exec -T app node scripts/import-tenant.mjs --target-db "$TARGET_DB" "${IMPORT_ARGS[@]}"
