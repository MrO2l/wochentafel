#!/usr/bin/env bash
# ============================================================================
# backup-db-encrypted.sh
#
# Ersetzt den bisherigen, in README.md dokumentierten Cronjob
#   docker compose exec -T db pg_dump -U wochenplan wochenplan | gzip > ...
# der die komplette Datenbank UNVERSCHLUESSELT und ohne Pruefsumme ablegte.
# Dieses Skript dumpt/komprimiert/verschluesselt in EINER Pipeline -- der
# unverschluesselte Dump-Inhalt wird zu keinem Zeitpunkt als Datei auf die
# Platte geschrieben (auch nicht kurzzeitig), sondern ausschliesslich als
# Stream durch gzip und gpg gereicht. Es gibt also kein "Zwischenprodukt",
# das nachtraeglich geloescht werden muesste.
#
# Verschluesselungsmodell -- ASYMMETRISCH, bewusst anders als
# ops/backup-tenant-offsite.sh (dort: symmetrisch, eine gemeinsame
# Passphrase-Datei fuer Ver- und Entschluesselung liegt in secrets/ AUF DEM
# SERVER). Fuer den vollstaendigen, regelmaessigen DB-Dump -- der im
# Unterschied zum Einzel-Mandanten-Export ALLE Haushalte/Nutzer/Passwort-
# Hashes in einem Rutsch enthaelt -- ist das nicht ausreichend: wer den
# Server kompromittiert, faende dort automatisch auch den Schluessel fuer
# saemtliche bisherigen Backups. Deshalb hier GPG mit einem Schluesselpaar:
#   - NUR der OEFFENTLICHE Schluessel liegt auf dem Server
#     (secrets/db-backup-pubkey.asc, siehe PUBKEY_FILE unten) und wird
#     ausschliesslich zum VERSCHLUESSELN benutzt.
#   - Der PRIVATE Schluessel wird NIEMALS auf den Server kopiert. Er entsteht
#     und bleibt auf einer separaten, idealerweise nicht dauerhaft
#     netzangebundenen Maschine (z. B. Passwort-Manager mit Datei-Tresor,
#     verschluesselter USB-Stick). Ein kompromittierter Server kann damit
#     zwar NEUE Backups verschluesseln, aber KEIN einziges -- weder altes
#     noch neues -- wieder entschluesseln.
#
# Schluesselpaar EINMALIG erzeugen -- auf der separaten/offline Maschine,
# NICHT auf dem VPS:
#   gpg --batch --quick-generate-key \
#     "Wochenplaner DB-Backup <ops@deine-domain.de>" rsa4096 encr never
#   gpg --armor --export "Wochenplaner DB-Backup" > db-backup-pubkey.asc
# Anschliessend NUR db-backup-pubkey.asc (oeffentlicher Schluessel, kein
# Geheimnis) auf den Server nach secrets/db-backup-pubkey.asc kopieren.
# secrets/ ist per .gitignore ohnehin nie versioniert; der private
# Schluessel verlaesst die Erzeuger-Maschine idealerweise nie.
#
# Benoetigt GnuPG >= 2.1.13 (Option --recipient-file, verschluesselt direkt
# gegen eine Schluesseldatei, ganz ohne lokalen Schluesselbund/Import -- auf
# dem Server existiert damit zu keinem Zeitpunkt ein GPG-Keyring mit
# irgendeinem Schluessel darin, importiert wird nichts). Getestet mit
# GnuPG 2.4.9.
#
# Voraussetzungen:
#   - laufender Compose-Stack im aktuellen Arbeitsverzeichnis
#     (docker compose ps -> db healthy)
#   - secrets/db-backup-pubkey.asc vorhanden (siehe oben)
#
# Aufruf (keine Argumente -- fuer den unbeaufsichtigten Cron-Betrieb gedacht):
#   ./ops/backup-db-encrypted.sh
#
# Beispiel-Crontab-Zeile (taeglich 03:15, aus dem Stack-Verzeichnis heraus):
#   15 3 * * *  cd /pfad/zum/stack && ./ops/backup-db-encrypted.sh >> ops/db-backups/backup.log 2>&1
#
# Wiederherstellung (auf der Maschine mit dem PRIVATEN Schluessel, NICHT auf
# dem Server -- der Server kann per Konstruktion nicht entschluesseln):
#   sha256sum -c wochenplan-db-<timestamp>.sql.gz.gpg.sha256   # Integritaet
#   gpg --batch --yes --decrypt wochenplan-db-<timestamp>.sql.gz.gpg \
#     | gunzip \
#     | docker compose exec -T db psql -U wochenplan wochenplan
#
# Aufbewahrung: DB_BACKUP_RETENTION_DAYS (Default 30) loescht in BACKUP_DIR
# nur eigene Dateien (Namensmuster "wochenplan-db-*"), die aelter sind.
# 0 = keine automatische Loeschung.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PUBKEY_FILE="${DB_BACKUP_PUBKEY_FILE:-$STACK_DIR/secrets/db-backup-pubkey.asc}"
BACKUP_DIR="${DB_BACKUP_DIR:-$STACK_DIR/ops/db-backups}"
RETENTION_DAYS="${DB_BACKUP_RETENTION_DAYS:-30}"

if [ ! -f "$PUBKEY_FILE" ]; then
  echo "Fehler: oeffentlicher Schluessel nicht gefunden: $PUBKEY_FILE" >&2
  echo "Siehe Kopfkommentar dieses Skripts zur einmaligen Schluesselerzeugung." >&2
  exit 1
fi

if ! gpg --dump-options 2>/dev/null | grep -qx -- '--recipient-file'; then
  echo "Fehler: installierte GnuPG-Version unterstuetzt --recipient-file nicht (benoetigt >= 2.1.13)." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME="wochenplan-db-${TIMESTAMP}"
ENC_FILE="$BACKUP_DIR/${BASENAME}.sql.gz.gpg"
SUM_FILE="$ENC_FILE.sha256"

echo "==> Dumpe, komprimiere und verschluessele Produktivdatenbank (Stream, keine unverschluesselte Zwischendatei) ..." >&2
cd "$STACK_DIR"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip \
  | gpg --batch --yes --trust-model always --recipient-file "$PUBKEY_FILE" --encrypt -o "$ENC_FILE"

echo "==> Verschluesselt: $ENC_FILE" >&2

sha256sum "$ENC_FILE" | awk '{print $1}' > "$SUM_FILE"
echo "==> Pruefsumme:     $SUM_FILE ($(cat "$SUM_FILE"))" >&2

if [ "$RETENTION_DAYS" != "0" ]; then
  echo "==> Entferne eigene Backups aelter als $RETENTION_DAYS Tage aus $BACKUP_DIR ..." >&2
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'wochenplan-db-*' -mtime "+$RETENTION_DAYS" -print -delete >&2 || true
fi

echo "$ENC_FILE"
