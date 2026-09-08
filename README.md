# Wochentafel

Der Wochenplan für die ganze Familie: am Rechner ausfüllen, auf **A4 quer** ausdrucken,
vom Handy nachschauen. Mit Piktogrammen für Schule, Ganztagsschule, Arzt, Sport,
Einkauf und zwei Dutzend weitere wiederkehrende Termine.

Läuft als Docker-Container mit PostgreSQL. Mehrere Haushalte sind sauber getrennt,
jeder Haushalt hat eigene Mitglieder, eigene Wochen und eine eigene Standardwoche.
Termine und Essenspläne lassen sich Ende-zu-Ende-verschlüsselt ablegen, siehe
[Technik](#technik) und [Sicherheit](#sicherheit).

---

## Technik

* **Backend**: Node.js (≥ 20) mit [Express](https://expressjs.com/), siehe [`app/server.js`](app/server.js).
* **Datenbank**: PostgreSQL, Schema und Migrationen unter [`app/migrations/`](app/migrations/),
  werden beim Start automatisch angewendet.
* **Oberfläche**: serverseitig gerenderte HTML-Seiten unter [`app/public/`](app/public/), ohne
  Frontend-Framework.
* **Ende-zu-Ende-Verschlüsselung**: Termine und Essenspläne (Wochen- und Vorlagendaten)
  lassen sich clientseitig mit [libsodium](app/public/vendor/libsodium/) (Argon2id-Schlüsselableitung,
  XChaCha20-Poly1305-AEAD) verschlüsseln, siehe [`app/public/crypto.js`](app/public/crypto.js).
  Der Haushalts-Schlüssel verlässt dabei nie den Browser und liegt dem Server zu keinem
  Zeitpunkt vor — Details siehe Abschnitt [Sicherheit](#sicherheit).
* **Betrieb**: Docker Compose (App-, DB- und optionaler Caddy-Proxy-Container), siehe
  [`docker-compose.yml`](docker-compose.yml) und [`.env.example`](.env.example) für die
  Konfiguration.

---

## Schnellstart

```bash
cp .env.example .env
# Passwörter erzeugen und in .env eintragen:
openssl rand -base64 32     # POSTGRES_PASSWORD
openssl rand -base64 32     # SESSION_SECRET

docker compose up -d --build
```

Standardmäßig lauscht die Anwendung nur auf `127.0.0.1` (sicherer Default für den
Betrieb hinter einem Reverse Proxy, siehe unten). Für den direkten Zugriff im
**Heimnetz ohne Proxy** vorher in der `.env` `APP_BIND=0.0.0.0` setzen, dann ist
`http://<server-ip>:3000` von anderen Geräten im Netz erreichbar. Dort auf **Neu hier**
klicken und den ersten Haushalt anlegen. Weitere Familienmitglieder kommen über
**Konto → Familienmitglied einladen**: der erzeugte Code ist 14 Tage gültig und lässt
sich genau einmal verwenden.

Wenn alle Konten stehen, in der `.env` `ALLOW_REGISTRATION=false` setzen und
`docker compose up -d` erneut ausführen. Dann kommt niemand mehr ohne Einladung hinein.

---

## Bedienung

| Was | Wie |
|---|---|
| Eintragen | In ein Feld klicken, tippen. Piktogramm oben in der Palette anklicken, es landet an der Cursorposition. |
| Symbol löschen | Doppelklick auf das Symbol. |
| Speichern | Passiert automatisch eine Sekunde nach der letzten Eingabe. Der Status rechts oben zeigt es an. |
| Wochen wechseln | Pfeiltasten in der Leiste, Datumsfeld oder das Archiv-Auswahlfeld. |
| Standardwoche | Eine typische Woche anlegen, dann **Als Vorlage sichern**. Jede noch nicht angelegte Woche startet damit vorausgefüllt. In eine bestehende Woche fügt **Vorlage einfügen** nur dort etwas ein, wo noch nichts steht. |
| Drucken | **Drucken** → A4 quer, alles passt auf genau eine Seite. Bedienleiste und Handy-Ansicht werden nicht mitgedruckt. |
| Handy | Unter 900 Pixel Fensterbreite startet die Tagesansicht: ein Tag pro Bildschirm, Symbolpalette über den Knopf **Symbole**. Umschalten geht jederzeit über **Tagesansicht** / **Wochenansicht**. |
| Zeilen | **+ Person** und **+ Zeile** ergänzen Zeilen, das kleine × in der Namensspalte entfernt eine. |

Gleichzeitiges Bearbeiten: Speichert jemand eine Woche, die auf einem anderen Gerät
zwischenzeitlich geändert wurde, lädt die Oberfläche den Serverstand nach und weist
darauf hin, statt die fremden Einträge stillschweigend zu überschreiben.

---

## Von unterwegs erreichbar machen

`APP_BIND=127.0.0.1` ist bereits der Default, sodass die Anwendung nicht direkt aus dem
Netz erreichbar ist. In der `.env` zusätzlich setzen:

```ini
TRUST_PROXY=true            # sichere Cookies, korrekte Client-IPs
DOMAIN=wochenplan.deine-domain.de
LETSENCRYPT_MAIL=du@deine-domain.de
```

Die Domain per DNS auf den Server zeigen lassen, Port 80 und 443 freigeben, dann:

```bash
docker compose --profile proxy up -d
```

Caddy holt und erneuert das Let's-Encrypt-Zertifikat selbstständig. Ohne eigene Domain
ist ein VPN ins Heimnetz (WireGuard, Tailscale) die einfachere und sicherere Variante —
dann bleibt `APP_BIND=0.0.0.0` und der Proxy wird nicht gebraucht.

---

## Sicherung und Wiederherstellung

Der reguläre Voll-Datenbank-Dump läuft **GPG-verschlüsselt**, per Cron über
[`ops/backup-db-encrypted.sh`](ops/backup-db-encrypted.sh) (löst den früheren,
unverschlüsselten `pg_dump | gzip`-Cronjob ohne Prüfsumme ab). Dump,
Komprimierung und Verschlüsselung laufen in einer einzigen Pipeline — der
unverschlüsselte Inhalt landet zu keinem Zeitpunkt als Datei auf der Platte.

Verschlüsselt wird **asymmetrisch**: Auf dem Server liegt nur der
*öffentliche* Schlüssel (`secrets/db-backup-pubkey.asc`), der *private*
Schlüssel bleibt auf einer separaten Maschine — ein kompromittierter Server
kann damit kein einziges Backup entschlüsseln, weder alte noch neue. Details
zur einmaligen Schlüsselerzeugung, zum Cron-Eintrag und zur Wiederherstellung
stehen im Kopfkommentar des Skripts.

Einmalig einrichten:

```bash
# auf einer separaten/offline Maschine, NICHT auf dem VPS:
gpg --batch --quick-generate-key "Wochenplaner DB-Backup <ops@deine-domain.de>" rsa4096 encr never
gpg --armor --export "Wochenplaner DB-Backup" > db-backup-pubkey.asc
# nur die .asc-Datei (kein Geheimnis) auf den Server kopieren nach:
#   secrets/db-backup-pubkey.asc
```

Sichern (täglich per Cron, siehe Skript-Kopfkommentar für die Crontab-Zeile):

```bash
./ops/backup-db-encrypted.sh
```

Zurückspielen (auf der Maschine mit dem *privaten* Schlüssel, nicht auf dem
Server):

```bash
sha256sum -c wochenplan-db-2026-09-06T092058Z.sql.gz.gpg.sha256
gpg --batch --yes --decrypt wochenplan-db-2026-09-06T092058Z.sql.gz.gpg \
  | gunzip \
  | docker compose exec -T db psql -U wochenplan wochenplan
```

Das per Mandant getrennte Backup/Restore (`ops/backup-tenant-offsite.sh` /
`ops/restore-tenant-from-offsite.sh`) verwendet bewusst ein anderes,
*symmetrisches* GPG-Verfahren (siehe Kopfkommentare dort) und bleibt davon
unberührt.

Offen: Die verschlüsselten Dateien unter `ops/db-backups/` liegen weiterhin
auf demselben Server wie die Datenbank selbst (kein Offsite-Ziel). Für volle
Ausfallsicherheit sollten sie zusätzlich regelmäßig auf einen zweiten,
unabhängigen Host übertragen werden (z. B. `rclone`/`rsync`, analog zum
Hinweis "OFFSITE-TRANSFER" in `ops/backup-tenant-offsite.sh`).

Zusätzlich lässt sich jede einzelne Woche über **Konto → Diese Woche als Datei sichern**
als JSON ablegen und später wieder einlesen. Dieses Format liest auch die Dateien der
Einzeldatei-Version des Planers ein.

---

## Aufbau

```
docker-compose.yml     Anwendung, PostgreSQL, optionaler Caddy-Proxy
.env.example           Konfiguration
deploy/Caddyfile       HTTPS für den Zugriff von unterwegs
app/
  server.js            Express-Anwendung, Migrationen, API
  migrations/          SQL, wird beim Start automatisch angewendet
  public/              Oberfläche (A4-Ansicht, Tagesansicht, Anmeldung)
    icons.js           Piktogramm-Bibliothek als SVG
```

### Datenmodell

| Tabelle | Zweck |
|---|---|
| `households` | ein Haushalt je Familie, dazu die Standardwoche als `template_data` |
| `users` | Mitglieder eines Haushalts, Passwort als bcrypt-Hash |
| `weeks` | eine Zeile je Haushalt und Kalenderwoche, Plan als `jsonb` |
| `invites` | Einladungscodes, einmal verwendbar, 14 Tage gültig |
| `session` | Sitzungen, damit ein Neustart niemanden abmeldet |

Die Wocheninhalte stehen **nicht** als HTML in der Datenbank, sondern als Tokens:

```json
[{"t":"icon","v":"i-schule-ganz","l":"Ganztagsschule"},{"t":"text","v":" bis 16 Uhr"}]
```

Damit kann über die Oberfläche kein Markup eingeschleust werden, und es bleibt
auswertbar — etwa wie oft ein Piktogramm in einem Halbjahr vorkommt:

```sql
SELECT tok->>'l' AS piktogramm, count(*)
  FROM weeks w,
       jsonb_array_elements(w.data->'rows')  AS row,
       jsonb_array_elements(row->'cells')    AS cell,
       jsonb_array_elements(cell)            AS tok
 WHERE w.household_id = 1 AND tok->>'t' = 'icon'
 GROUP BY 1 ORDER BY 2 DESC;
```

### API

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/auth/register` | Konto anlegen (neuer Haushalt oder Einladungscode) |
| POST | `/api/auth/login` / `/api/auth/logout` | An- und Abmelden |
| GET | `/api/me` | angemeldetes Konto |
| GET | `/api/weeks` | Liste der gespeicherten Wochen |
| GET/PUT/DELETE | `/api/weeks/:montag` | Woche lesen, speichern, löschen |
| GET/PUT/DELETE | `/api/template` | Standardwoche |
| POST | `/api/invites` | Einladungscode erzeugen |
| GET | `/api/health` | Healthcheck für Docker |

---

## Sicherheit

* Passwörter als bcrypt-Hash (Kostenfaktor 12), nie im Klartext.
* Sitzungscookie `httpOnly`, `sameSite=lax`, mit `TRUST_PROXY=true` zusätzlich `secure`.
* Nach fünf Fehlversuchen ist eine E-Mail-Adresse fünf Minuten für Anmeldungen gesperrt.
* Zusätzliche IP-basierte Rate-Limits auf `/api` (120/Min.), Anmeldung und Registrierung
  (30/15 Min.) sowie Einladungscodes (20/Std.) — schützen gegen automatisierte
  Massenanfragen unabhängig vom verwendeten Konto.
* Jede Abfrage filtert auf den Haushalt der Sitzung — fremde Wochen sind nicht erreichbar,
  auch nicht durch Raten von Datumsangaben.
* Eingehende Wochendaten werden serverseitig auf das erlaubte Token-Format zurechtgestutzt.
* Strikte `Content-Security-Policy` (kein `unsafe-inline`, keine Fremd-Ressourcen) sowie
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` und `Permissions-Policy`.
* `APP_BIND` ist standardmäßig `127.0.0.1` — die Anwendung ist ohne Reverse Proxy nicht
  aus dem Netz erreichbar, sofern nicht ausdrücklich `0.0.0.0` gesetzt wird.
* Der `app`-Container läuft als Benutzer `node` (nicht root), mit read-only Dateisystem
  und ohne Linux-Capabilities; alle drei Container mit `no-new-privileges`.

---

## Ausblick

Bewusst nicht enthalten, aber ohne Umbau ergänzbar:

* **Live-Aktualisierung** über Server-Sent-Events, damit Änderungen sofort auf allen
  offenen Geräten erscheinen statt beim nächsten Laden.
* **Feldweises Speichern**, sodass zwei Personen gleichzeitig in derselben Woche
  arbeiten können, ohne dass eine Meldung erscheint.
* **Kalender-Anbindung** (ICS-Export der Woche oder Import bestehender Termine).
* **Erinnerungen** per Push oder E-Mail, etwa Sonntagabend die Vorschau auf die Woche.

---

## Lizenz

Dieses Projekt ist **source-available** unter der
[PolyForm Noncommercial License 1.0.0](LICENSE) — der Quellcode ist frei einsehbar
und für **private und nicht-kommerzielle Zwecke frei nutzbar**. Kommerzielle Nutzung
erfordert eine **separate Vereinbarung** mit dem Rechteinhaber.

Wichtig zur Einordnung: Das ist rechtlich **kein „Open Source"** im Sinne der
[Open Source Definition der OSI](https://opensource.org/osd) — diese verlangt zwingend
auch die kommerzielle Nutzung ohne Einschränkung. „Source-available" trifft es korrekt:
der Code ist offen einsehbar, aber die Nutzung ist über die Lizenz eingeschränkt.

Für kommerzielle Anfragen: **9ru16du4@anonaddy.me**
