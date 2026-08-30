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
#
# Rezeptbilder (AP-ART3MIS, Wochenplaner-Rezeptkarten, ergaenzt 2026-08-29):
#   Existiert neben <backup-datei>.json.gpg ein passendes
#   <backup-datei-ohne-.json.gpg>.images.tar.gpg (von
#   backup-tenant-offsite.sh erzeugt), wird es nach erfolgreichem DB-Restore
#   automatisch mitentschluesselt und flach (kein Unterordner, siehe
#   Konvention in docker-compose.yml/backup-tenant-offsite.sh) ins Volume
#   zurueckgespielt.
#   WICHTIG (1): import-tenant.mjs vergibt standardmaessig eine NEUE
#   household_id (siehe --household-id oben) -- die restaurierten
#   Bilddateien tragen aber weiterhin das Praefix der ALTEN household_id im
#   Dateinamen. Sollen Bilder und DB-Zustand nach dem Restore zusammen-
#   passen, entweder:
#     (a) --household-id <alte-id> explizit setzen (empfohlen, wenn die ID
#         in der Ziel-DB noch frei ist), oder
#     (b) Dateien nach dem Restore manuell umbenennen (Praefix anpassen),
#         siehe Hinweis am Ende dieses Skripts.
#   WICHTIG (2), STAND 2026-08-29: export-tenant.mjs/import-tenant.mjs
#   exportieren/importieren aktuell NUR households/users/weeks/invites --
#   NOCH NICHT die neue recipes-Tabelle (siehe app/migrations/008_recipes.sql).
#   Ohne restaurierte recipes-Zeilen bleiben restaurierte Bilddateien
#   verwaiste Dateien ohne referenzierenden Datensatz. Dieser Restore-
#   Schritt hier stellt NUR die Dateien wieder her -- die Erweiterung von
#   export-/import-tenant.mjs um die recipes-Tabelle ist ein offener
#   Folgepunkt (siehe Rueckmeldung an ANORAK).
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

# ----------------------------------------------------------------------
# Rezeptbilder (AP-ART3MIS): companion .images.tar.gpg, falls vorhanden
# (siehe Kopfkommentar fuer die household_id-Namenslogik).
# ----------------------------------------------------------------------
IMG_BACKUP_FILE="${BACKUP_FILE%.json.gpg}.images.tar.gpg"
IMG_SUM_FILE="${IMG_BACKUP_FILE}.sha256"

if [ -f "$IMG_BACKUP_FILE" ]; then
  if [ -f "$IMG_SUM_FILE" ]; then
    echo "==> Pruefe Integritaet der Bilder gegen $IMG_SUM_FILE ..." >&2
    IMG_ACTUAL="$(sha256sum "$IMG_BACKUP_FILE" | awk '{print $1}')"
    IMG_EXPECTED="$(cat "$IMG_SUM_FILE")"
    if [ "$IMG_ACTUAL" != "$IMG_EXPECTED" ]; then
      echo "Fehler: Pruefsumme der Bilddatei stimmt NICHT ueberein -- Bild-Restore uebersprungen (DB-Restore oben ist davon unberuehrt)." >&2
      exit 1
    fi
    echo "==> Pruefsumme (Bilder) ok." >&2
  else
    echo "Warnung: keine .sha256-Datei zu $IMG_BACKUP_FILE gefunden -- Integritaet der Bilder wird nicht geprueft." >&2
  fi

  echo "==> Entschluessle und stelle Rezeptbilder wieder her ($IMG_BACKUP_FILE) ..." >&2
  gpg --batch --yes --passphrase-file "$KEY_FILE" --decrypt "$IMG_BACKUP_FILE" 2>/dev/null \
    | docker compose exec -T app sh -c 'mkdir -p "$RECIPE_IMAGES_DIR" && tar -xf - -C "$RECIPE_IMAGES_DIR"'
  echo "==> Bilder wiederhergestellt (flach) in \$RECIPE_IMAGES_DIR im app-Container, Dateinamen tragen weiterhin das Praefix der ALTEN household_id." >&2
  echo "==> WICHTIG: Falls import-tenant.mjs oben eine NEUE household_id vergeben hat (kein --household-id gesetzt), passen Bild-Dateinamen (altes Praefix) und DB-Zustand (neue ID) nicht automatisch zusammen -- ggf. Praefix manuell umbenennen. Zusaetzlich: recipes-Zeilen selbst werden von import-tenant.mjs aktuell NOCH NICHT wiederhergestellt (siehe Kopfkommentar) -- diese Dateien sind bis zu dieser Erweiterung ohne referenzierenden Datensatz." >&2
else
  echo "==> Kein zugehoeriges Bild-Backup gefunden ($IMG_BACKUP_FILE) -- ueberspringe Bildwiederherstellung." >&2
fi
