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
#
# Rezeptbilder (AP-ART3MIS, Wochenplaner-Rezeptkarten, ergaenzt 2026-08-29):
#   Zusaetzlich zum DB-Export (JSON) wird -- falls vorhanden -- ein zweites,
#   GPG-verschluesseltes Archiv <basename>.images.tar.gpg mit den
#   Rezeptbildern dieses Mandanten erzeugt. Bilder liegen laut
#   app/migrations/008_recipes.sql (CHECK auf recipes.image_path erzwingt
#   einen FLACHEN Dateinamen ohne "/", kein Unterordner pro Haushalt
#   moeglich) direkt in "$RECIPE_IMAGES_DIR", mit household_id als
#   Dateinamens-Praefix: "<household_id>_<recipe_id>_<uuid>.<ext>". Dieses
#   Skript filtert per Glob "<household_id>_*" (siehe docker-compose.yml-
#   Kommentar bei RECIPE_IMAGES_DIR). Gibt es keine passenden Dateien (z. B.
#   Mandant hat noch keine Bilder, oder A3CHs tatsaechliche Namensgebung
#   weicht von dieser Konvention ab), wird dieser Schritt uebersprungen
#   (kein Fehler) -- siehe Meldung "Keine Rezeptbilder...".
# ============================================================================
set -euo pipefail

HOUSEHOLD_ID="${1:?Verwendung: backup-tenant-offsite.sh <household_id> [Label]}"
LABEL="${2:-tenant}"

# ZANDOR-Review (AP5.1, Fund 1): HOUSEHOLD_ID wird unten sowohl in einen
# lokalen Dateinamen (BASENAME) als auch -- via Environment-Variable, siehe
# Fund-1-Fix weiter unten -- in einen `docker compose exec ... sh -c`-Aufruf
# im App-Container eingespeist. Ohne diese Pruefung koennte ein Wert wie
# `1"; cat /proc/1/environ #` aus dem Shell-Kontext ausbrechen (Command
# Injection). Analog zum bestehenden parseHouseholdId()-Muster in
# server.js/DB-bigint erzwingen wir hier eine reine positive Ganzzahl.
if ! [[ "$HOUSEHOLD_ID" =~ ^[0-9]+$ ]]; then
  echo "Fehler: <household_id> muss eine positive Ganzzahl sein, erhalten: '$HOUSEHOLD_ID'" >&2
  exit 1
fi

# ZANDOR-Review (AP5.1, Fund 2): LABEL fliesst unten ungeprueft in den
# Dateinamen des lokal erzeugten Backups (BASENAME) ein. Enthaelt LABEL "/"
# oder "..", koennte die Ausgabedatei ausserhalb von $OFFSITE_DIR landen
# (Pfadtraversal). Beschraenkung auf ein sicheres Zeichenset statt bloss
# Ausschluss von "/"/"..", damit auch exotischere Trennzeichen keine Chance
# haben.
if ! [[ "$LABEL" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Fehler: [Label] darf nur Buchstaben, Ziffern, '_' und '-' enthalten, erhalten: '$LABEL'" >&2
  exit 1
fi

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

# ----------------------------------------------------------------------
# Rezeptbilder (AP-ART3MIS): zweites, separates Archiv -- nur falls
# mindestens eine Datei mit Praefix "<household_id>_" im flachen
# Bilder-Verzeichnis liegt (Konvention, siehe Kopfkommentar). Existenz-
# pruefung UND Tar laufen bewusst im selben `docker compose exec`-Aufruf des
# App-Containers wie der DB-Export oben -- liest $RECIPE_IMAGES_DIR direkt
# aus der Laufzeitumgebung des Containers, keine eigene Pfadannahme auf dem
# Host noetig (funktioniert unveraendert, falls RECIPE_IMAGES_DIR spaeter
# umkonfiguriert wird). `tar` archiviert die Dateien mit RELATIVEN Namen
# (kein Pfad-Praefix), damit sie beim Restore direkt wieder flach in
# $RECIPE_IMAGES_DIR passen.
# ----------------------------------------------------------------------
IMG_ENC_FILE="$OFFSITE_DIR/${BASENAME}.images.tar.gpg"
IMG_SUM_FILE="$OFFSITE_DIR/${BASENAME}.images.tar.gpg.sha256"

# ZANDOR-Review (AP5.1, Fund 1, strukturelle Entschaerfung): HOUSEHOLD_ID
# wird NICHT mehr per String-Interpolation ins sh-c-Skript eingebettet
# ("'"$HOUSEHOLD_ID"'"), sondern ueber `docker compose exec -e HID=...` als
# Environment-Variable an den App-Container uebergeben und im Skript als
# "$HID" referenziert. Das entfernt die Injection-Klasse strukturell (kein
# Uebersetzen von Nutzereingabe in Shell-Syntax mehr noetig), zusaetzlich
# zur oben bereits erzwungenen Ganzzahl-Validierung.
if docker compose exec -T -e HID="$HOUSEHOLD_ID" app sh -c 'cd "$RECIPE_IMAGES_DIR" && ls -- "${HID}"_* >/dev/null 2>&1'; then
  echo "==> Sichere Rezeptbilder (Praefix ${HOUSEHOLD_ID}_* in \$RECIPE_IMAGES_DIR) ..." >&2
  docker compose exec -T -e HID="$HOUSEHOLD_ID" app sh -c 'cd "$RECIPE_IMAGES_DIR" && tar -cf - -- "${HID}"_*' \
    | gpg --batch --yes --passphrase-file "$KEY_FILE" --symmetric --cipher-algo AES256 -o "$IMG_ENC_FILE"
  sha256sum "$IMG_ENC_FILE" | awk '{print $1}' > "$IMG_SUM_FILE"
  echo "==> Bilder verschluesselt: $IMG_ENC_FILE" >&2
  echo "==> Pruefsumme (Bilder):   $IMG_SUM_FILE ($(cat "$IMG_SUM_FILE"))" >&2
else
  echo "==> Keine Rezeptbilder fuer household_id=$HOUSEHOLD_ID gefunden (Praefix ${HOUSEHOLD_ID}_* in \$RECIPE_IMAGES_DIR) -- ueberspringe Bild-Backup (keine Rezeptbilder vorhanden oder Speicherlayout weicht von der dokumentierten Konvention ab)." >&2
fi

# --- OFFSITE-TRANSFER (hier: SIMULIERT, da bereits Ziel = $OFFSITE_DIR) ---
# Produktiv wuerde an dieser Stelle z. B. stehen:
#   rclone copy "$ENC_FILE" "$SUM_FILE" remote:wochenplaner-backups/
# oder:
#   rsync -avz "$ENC_FILE" "$SUM_FILE" backup-host:/srv/backups/wochenplaner/
# (bei vorhandenem Bild-Backup analog $IMG_ENC_FILE/$IMG_SUM_FILE mit
# uebertragen) -- siehe ap3.2-backup-konzept.md fuer den vollstaendigen
# Runbook-Text.
echo "==> [SIMULIERT] Offsite-Ablage abgeschlossen unter: $OFFSITE_DIR" >&2
echo "$ENC_FILE"
