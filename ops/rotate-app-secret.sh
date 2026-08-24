#!/usr/bin/env bash
# ============================================================================
# rotate-app-secret.sh
#
# AP3.3 (Wochenplaner-Mandantenfaehigkeit, ART3MIS): Formalisiert das in AP3.1
# bereits live getestete Rotationsverfahren fuer WOCHENPLAN_APP_PASSWORD
# (siehe projects/wochenplaner-mandantenfaehigkeit/ap3.1-deployment-
# automatisierung.md, Abschnitt 6.3/7) als wiederholbaren, unbeaufsichtigt
# ausfuehrbaren Vorgang. Rotiert NICHT POSTGRES_PASSWORD (Owner-/Migrator-
# Rolle) -- die beiden Rollen sind bewusst getrennt rotierbar (AP1.2/AP2.2:
# Owner-Rolle darf nie fuer Laufzeitverkehr verwendet werden, ihre Rotation
# ist ein eigener, selteneren Vorgang mit anderem Blast Radius und hier
# bewusst nicht Teil dieses Skripts).
#
# Ablauf (identisch zum in AP3.1 live verifizierten Vorgehen):
#   1. Neues Zufalls-Secret erzeugen (openssl rand -hex 32)
#   2. .env sichern (Zeitstempel-Kopie unter .env-backups/)
#   3. WOCHENPLAN_APP_PASSWORD in .env ersetzen
#   4. Nur den app-Container neu erstellen (--no-deps, kein Compose-Down,
#      kein Downtime-Fenster fuer db) -- setzt beim Start idempotent per
#      ALTER ROLE (ensureAppRolePassword() in server.js) das neue Passwort
#   5. Health-Check pollen (max. WAIT_TIMEOUT Sekunden)
#   6. Bei Erfolg: alte .env-Sicherung bleibt als Audit-Spur, Skript meldet
#      Erfolg. Bei Fehlschlag: automatischer Rollback auf die vorherige .env
#      und erneuter --no-deps-Neustart, danach Skriptabbruch mit Fehlercode.
#
# WICHTIG: Dieses Skript ist fuer den lokalen Docker-Teststack sowie fuer den
# spaeteren produktiven Rollout gedacht -- es fuehrt selbst KEINE root-
# Operationen aus (kein systemctl, kein Eingriff auf Hostebene ausserhalb des
# Docker-Compose-Projektverzeichnisses). Vor dem ersten produktiven Einsatz:
# einmal wie in AP3.1 dokumentiert mit einer Testinstanz nachvollziehen.
#
# Aufruf (im Verzeichnis mit docker-compose.yml/.env):
#   ./ops/rotate-app-secret.sh [--dry-run]
#
# --dry-run: erzeugt kein neues Secret, veraendert .env nicht, startet
#            nichts neu -- prueft nur Voraussetzungen (Datei vorhanden,
#            Compose-Projekt erreichbar) und zeigt den geplanten Ablauf.
# ============================================================================
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi

ENV_FILE="${ENV_FILE:-.env}"
BACKUP_DIR="${BACKUP_DIR:-.env-backups}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-30}"     # Sekunden, die auf "healthy" gewartet wird
VAR_NAME="WOCHENPLAN_APP_PASSWORD"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FEHLER: $ENV_FILE nicht gefunden. Im Verzeichnis mit docker-compose.yml ausfuehren." >&2
  exit 1
fi
if ! grep -q "^${VAR_NAME}=" "$ENV_FILE"; then
  echo "FEHLER: ${VAR_NAME} nicht in $ENV_FILE gefunden." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "FEHLER: docker nicht gefunden." >&2
  exit 1
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${BACKUP_DIR}/${ENV_FILE}.${TS}.bak"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "--dry-run: wuerde folgendes tun:"
  echo "  1. Neues Secret erzeugen (openssl rand -hex 32)"
  echo "  2. $ENV_FILE nach $BACKUP_FILE sichern"
  echo "  3. ${VAR_NAME} in $ENV_FILE ersetzen"
  echo "  4. docker compose up -d --no-deps app"
  echo "  5. bis zu ${WAIT_TIMEOUT}s auf 'healthy' warten"
  echo "  6. bei Fehlschlag automatischer Rollback auf $BACKUP_FILE"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
cp "$ENV_FILE" "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE" 2>/dev/null || true
echo "Sicherung angelegt: $BACKUP_FILE"

NEW_SECRET="$(openssl rand -hex 32)"

# Portable sed-Ersetzung (macOS/BSD-sed erfordert -i '' statt -i) -- hier ueber
# ein temporaeres Zwischendokument geloest, funktioniert auf GNU- und BSD-sed
# sowie unter Git-Bash (Windows) identisch.
TMP_ENV="$(mktemp)"
awk -v var="$VAR_NAME" -v val="$NEW_SECRET" -F= '
  BEGIN { OFS="=" }
  $1 == var { print var, val; next }
  { print }
' "$ENV_FILE" > "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true
echo "${VAR_NAME} in $ENV_FILE rotiert (neues Secret, 64 Hex-Zeichen)."

rollback() {
  echo "ROLLBACK: stelle vorherige $ENV_FILE aus $BACKUP_FILE wieder her." >&2
  cp "$BACKUP_FILE" "$ENV_FILE"
  docker compose up -d --no-deps app >/dev/null 2>&1 || true
}

echo "Starte app-Container neu (--no-deps, db bleibt unveraendert durchgehend erreichbar)..."
if ! docker compose up -d --no-deps app; then
  echo "FEHLER: docker compose up fehlgeschlagen." >&2
  rollback
  exit 1
fi

echo -n "Warte auf 'healthy' (bis zu ${WAIT_TIMEOUT}s)..."
elapsed=0
status=""
while [[ "$elapsed" -lt "$WAIT_TIMEOUT" ]]; do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null || echo "unknown")"
  if [[ "$status" == "healthy" ]]; then
    echo " OK ($status nach ${elapsed}s)"
    echo "Rotation erfolgreich abgeschlossen. Alte Sicherung bleibt unter $BACKUP_FILE (Audit-Spur)."
    exit 0
  fi
  sleep 2
  elapsed=$((elapsed + 2))
  echo -n "."
done

echo " FEHLGESCHLAGEN (Status nach ${WAIT_TIMEOUT}s: $status)" >&2
rollback
echo "FEHLER: App wurde nach Rotation nicht 'healthy' -- automatischer Rollback durchgefuehrt und app erneut gestartet." >&2
echo "Bitte 'docker compose logs app' pruefen, bevor ein erneuter Rotationsversuch gestartet wird." >&2
exit 1
