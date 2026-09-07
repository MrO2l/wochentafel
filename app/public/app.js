/* Familien-Wochenplan – Oberflaeche.
   Die Wochendaten liegen als Tokens vor (Text / Piktogramm / Zeilenumbruch),
   nicht als HTML. Das haelt Server und Datenbank frei von Markup und macht
   die A4-Ansicht und die Tagesansicht zu zwei Darstellungen derselben Daten. */

const DAYS  = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];
const DAYS_S = ['Mo','Di','Mi','Do','Fr','Sa','So'];
// Matte Vierfarb-Palette, reihum den Personenzeilen zugeordnet (siehe :root-Variablen in style.css).
const FAM_CLASSES = ['fam-a', 'fam-b', 'fam-c', 'fam-d'];

const state = {
  user: null,
  weekStart: null,
  data: null,
  updatedAt: null,
  dirty: false,
  saving: false,
  view: 'sheet',
  day: 0,
  // AP1.1 (projects/wochenplaner-design-nacharbeiten/plan.md): eigener, von "day" unabhaengiger
  // Mobile-Tag fuer die jetzt permanente "Essen & Kochen"-Tabelle (siehe renderMealDayNav()) --
  // eine gemeinsame Variable mit "day" wuerde die Tagesnavigation der Hauptraster-Tagesansicht
  // ungewollt an die des Essensplans koppeln, obwohl beides unabhaengige Ansichten sind. Default
  // wie beim analogen Hauptraster-Boot-Verhalten (siehe boot()) der heutige Wochentag.
  mealDay: (new Date().getDay() + 6) % 7,
  recipes: [], // AP2.2: haushaltsweite Rezeptkarten-Uebersicht, unabhaengig von der Wochenansicht
  // AP2.1 (projects/wochenplaner-termine-verschluesselung/plan.md): reine Metadaten aus /api/me
  // (encryptionStatus, keyVersion, Wrap-Felder) -- NIEMALS der Haushalts-Schluessel selbst. Der
  // Schluessel liegt ausschliesslich modul-lokal in crypto.js (WPCrypto.getHouseholdKey()), damit
  // er nicht versehentlich ueber state (z.B. in einer kuenftigen Debug-Ausgabe) exponiert wird.
  crypto: null,
  // true, sobald die aktuell geladene Woche beim naechsten Speichern verschluesselt werden muss
  // (siehe loadWeek()/buildWeekSaveBody()) -- unabhaengig davon, ob die Zeile GERADE als Ciphertext
  // geliefert wurde oder noch gar nicht existiert (mustEncryptOnSave-Flag der GET-Antwort).
  weekEncrypted: false
};

/* ---------------- Hilfsfunktionen ---------------- */
const $ = sel => document.querySelector(sel);
const pad = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = s => new Date(s + 'T00:00:00');
function toMonday(d) { const n = new Date(d); n.setDate(n.getDate() - ((n.getDay() + 6) % 7)); n.setHours(0,0,0,0); return n; }
function addDays(iso, n) { const d = parseISO(iso); d.setDate(d.getDate() + n); return isoOf(d); }
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y) / 86400000 + 1) / 7);
}
const fmtShort = d => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
// Spaltenindex (0=Mo…6=So) des heutigen Tages, aber nur wenn die aktuell angezeigte Woche das
// echte heutige Datum ueberhaupt enthaelt — sonst -1 (keine Hervorhebung in fremden Wochen).
function todayColumnIndex() {
  const t = new Date();
  return isoOf(toMonday(t)) === state.weekStart ? (t.getDay() + 6) % 7 : -1;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  if (res.status === 401) { location.href = 'login.html'; throw new Error('Nicht angemeldet'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error || 'Fehler'); e.status = res.status; e.payload = json; throw e; }
  return json;
}
// AP2.2: eigene Variante fuer multipart/form-data (Rezeptkarten-Bild-Upload) -- bewusst KEIN
// 'Content-Type'-Header selbst gesetzt, der Browser erzeugt ihn inkl. Boundary automatisch aus
// dem FormData-Objekt; ein manuell gesetzter Header ohne Boundary wuerde der Server (multer)
// nicht mehr parsen koennen.
async function apiForm(method, url, formData) {
  const res = await fetch(url, { method, body: formData, credentials: 'same-origin' });
  if (res.status === 401) { location.href = 'login.html'; throw new Error('Nicht angemeldet'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error || 'Fehler'); e.status = res.status; e.payload = json; throw e; }
  return json;
}

/* ---------------- AP2.1: Ende-zu-Ende-Verschluesselung ----------------
 * Leitet aus dem (erneut abgefragten, siehe promptUnlock()) Passwort denselben Wrap-Schluessel wie
 * beim Setup ab und entpackt damit den Haushalts-Schluessel -- wirft bei falschem Passwort
 * automatisch (AEAD-Authentifizierung schlaegt fehl, siehe crypto.js/unwrapKey()). Der entpackte
 * Schluessel wird NUR in WPCrypto (modul-lokale Variable in crypto.js) gehalten, nie in `state`
 * und nie in einer Web-Storage-API (Risikotabelle des Plans).
 */
async function unlockHousehold(password) {
  const c = state.crypto;
  const kdfParams = { algo: c.kdfAlgo, opslimit: c.kdfTimeCost, memlimit: c.kdfMemoryCost, parallelism: c.kdfParallelism };
  const wrapKeyBytes = await WPCrypto.deriveWrapKey(password, WPCrypto.fromB64(c.kdfSalt), kdfParams);
  const householdKey = await WPCrypto.unwrapKey(
    WPCrypto.fromB64(c.wrappedKey), WPCrypto.fromB64(c.wrapNonce), wrapKeyBytes);
  WPCrypto.setHouseholdKey(householdKey);
}

// Zeigt den "Entsperren"-Dialog (index.html) und loest das zurueckgegebene Promise erst auf,
// nachdem unlockHousehold() tatsaechlich erfolgreich war -- boot() wartet darauf, bevor irgendeine
// Woche geladen wird (siehe dort). ESC/Backdrop-Abbruch bewusst blockiert (siehe Kommentar bei
// showRecoveryCodeOnce() in login.js, identisches Muster): ohne Schluessel liesse sich keine
// Woche sinnvoll darstellen, ein abgebrochener Dialog wuerde die App in einem toten Zustand lassen.
function promptUnlock() {
  return new Promise(resolve => {
    const dlg = $('#unlockDialog');
    const form = $('#unlockForm');
    const pwInput = $('#unlockPassword');
    const errEl = $('#unlockError');
    errEl.hidden = true;
    const onCancel = ev => ev.preventDefault();
    dlg.addEventListener('cancel', onCancel);
    form.onsubmit = async ev => {
      ev.preventDefault();
      try {
        await unlockHousehold(pwInput.value);
        dlg.removeEventListener('cancel', onCancel);
        dlg.close();
        resolve();
      } catch {
        errEl.textContent = 'Falsches Passwort – bitte erneut versuchen.';
        errEl.hidden = false;
        pwInput.value = '';
        pwInput.focus();
      }
    };
    dlg.showModal();
    pwInput.focus();
  });
}

/* ---------------- AP2.3: Bootstrap-/Aktivierungs-UX fuer Bestandshaushalte ----------------
 * Zwei Faelle, siehe boot()-Verzweigung weiter unten:
 *  - promptBootstrapExisting(): der Haushalt ist noch komplett 'plaintext' -- das gerade
 *    einloggende Mitglied erzeugt den Haushalts-Schluessel neu (identisches Vorgehen wie bei
 *    einer Neuregistrierung, AP2.1, nur eben nachtraeglich fuer einen Bestandshaushalt).
 *  - promptActivatePending(): der Haushalt wurde bereits von einem ANDEREN Mitglied aktiviert
 *    (encryption_status 'activating'/'active'), dieses Konto hat aber noch keinen eigenen
 *    password-Wrap, sondern nur einen 'pending'-Wrap (siehe /api/me, crypto.pendingWrap).
 */

// Baut ein Wrap-Objekt in der vom Server erwarteten Form (server.js, parseWrapPayload()) --
// gemeinsamer Baustein fuer den eigenen password-Wrap, den haushaltsweiten recovery_code-Wrap
// und beliebig viele pending-Wraps fuer andere Mitglieder.
function buildWrapPayload(wrappedKey, nonce, salt, kdfParams) {
  return {
    wrappedKey: WPCrypto.toB64(wrappedKey), wrapNonce: WPCrypto.toB64(nonce),
    kdfSalt: WPCrypto.toB64(salt), kdfAlgo: kdfParams.algo,
    kdfTimeCost: kdfParams.opslimit, kdfMemoryCost: kdfParams.memlimit, kdfParallelism: kdfParams.parallelism
  };
}

// Bootstrap-Fluss fuer einen Bestandshaushalt (encryption_status noch 'plaintext', siehe
// state.crypto in boot()). Erzeugt den Haushalts-Schluessel + eigenen password-Wrap + haushalts-
// weiten recovery_code-Wrap sowie fuer JEDES ANDERE Mitglied einen 'pending'-Wrap mit einem
// frischen, NUR hier im Browser existierenden Aktivierungsgeheimnis (nie an den Server
// uebertragen, ap1.2-datenmodell.md Abschnitt 2.3/4.2) -- danach werden Wiederherstellungscode
// UND die Aktivierungscodes fuer die anderen Mitglieder einmalig angezeigt. Loest erst auf, wenn
// die Bestaetigungs-Checkbox tatsaechlich abgehakt wurde (siehe showRecoveryCodeOnce()-Kommentar
// in login.js, identisches Prinzip); der Haushalts-Schluessel liegt danach bereits im Speicher.
function promptBootstrapExisting() {
  return new Promise(resolve => {
    const dlg = $('#bootstrapDialog');
    const stepPassword = $('#bootstrapStepPassword');
    const stepResult = $('#bootstrapStepResult');
    const form = $('#bootstrapPasswordForm');
    const pwInput = $('#bootstrapPassword');
    const errEl = $('#bootstrapPasswordError');
    errEl.hidden = true;
    stepPassword.hidden = false;
    stepResult.hidden = true;
    const onCancel = ev => ev.preventDefault();
    dlg.addEventListener('cancel', onCancel);

    form.onsubmit = async ev => {
      ev.preventDefault();
      errEl.hidden = true;
      const password = pwInput.value;
      try {
        const { members } = await api('GET', '/api/household/members');
        const otherMembers = members.filter(m => m.id !== state.user.id);

        const householdKey = await WPCrypto.generateHouseholdKey();
        const kdfParams = WPCrypto.defaultKdfParams();

        const pwSalt = await WPCrypto.generateSalt();
        const pwWrapKey = await WPCrypto.deriveWrapKey(password, pwSalt, kdfParams);
        const pwWrap = await WPCrypto.wrapKey(householdKey, pwWrapKey);

        const rcSalt = await WPCrypto.generateSalt();
        const recoveryCode = await WPCrypto.generateRecoveryCode();
        const normalizedCode = WPCrypto.normalizeRecoveryCode(recoveryCode);
        const rcWrapKey = await WPCrypto.deriveWrapKey(normalizedCode, rcSalt, kdfParams);
        const rcWrap = await WPCrypto.wrapKey(householdKey, rcWrapKey);

        // AP2.6 (ap1.2-datenmodell.md Abschnitt 2.2a): zweiter, unabhaengiger Argon2id-Output
        // desselben Codes mit eigenem Salt -- der "verifier", siehe Kommentar in
        // login.js/buildCryptoBootstrap() fuer die identische Herleitung beim Neu-Haushalt-Fall.
        const verifierSalt = await WPCrypto.generateSalt();
        const verifier = await WPCrypto.deriveWrapKey(normalizedCode, verifierSalt, kdfParams);

        // Fuer jedes andere Mitglied: frisches, ausschliesslich hier im Browser existierendes
        // Aktivierungsgeheimnis -- dieselbe Code-Form wie der Wiederherstellungscode (gute
        // Entropie, gut abzutippen). Wird NIE an den Server gesendet, nur der daraus abgeleitete
        // Wrap.
        const activationEntries = [];
        const pendingWraps = [];
        for (const member of otherMembers) {
          const secret = await WPCrypto.generateRecoveryCode();
          const salt = await WPCrypto.generateSalt();
          const wrapKey = await WPCrypto.deriveWrapKey(WPCrypto.normalizeRecoveryCode(secret), salt, kdfParams);
          const wrapped = await WPCrypto.wrapKey(householdKey, wrapKey);
          pendingWraps.push({ userId: member.id, ...buildWrapPayload(wrapped.wrappedKey, wrapped.nonce, salt, kdfParams) });
          activationEntries.push({ member, secret });
        }

        const res = await api('POST', '/api/crypto/bootstrap-existing', {
          crypto: {
            passwordWrap: buildWrapPayload(pwWrap.wrappedKey, pwWrap.nonce, pwSalt, kdfParams),
            recoveryWrap: buildWrapPayload(rcWrap.wrappedKey, rcWrap.nonce, rcSalt, kdfParams),
            recoveryVerifier: { verifierSalt: WPCrypto.toB64(verifierSalt), verifier: WPCrypto.toB64(verifier) }
          },
          pendingWraps
        });

        WPCrypto.setHouseholdKey(householdKey);
        state.crypto = { ...state.crypto, encryptionStatus: res.encryptionStatus };

        $('#bootstrapRecoveryCodeOut').textContent = recoveryCode;
        const listEl = $('#bootstrapActivationList');
        listEl.textContent = '';
        if (activationEntries.length) {
          activationEntries.forEach(({ member, secret }) => {
            const li = document.createElement('li');
            li.className = 'list-group-item';
            const label = document.createElement('strong');
            label.textContent = `${member.name} (${member.email}):`;
            const code = document.createElement('span');
            code.style.fontFamily = 'monospace';
            code.style.marginLeft = '0.4em';
            code.textContent = secret;
            li.append(label, code);
            listEl.appendChild(li);
          });
          $('#bootstrapActivationCodes').hidden = false;
        } else {
          $('#bootstrapActivationCodes').hidden = true;
        }

        stepPassword.hidden = true;
        stepResult.hidden = false;
        const checkbox = $('#bootstrapConfirm');
        const continueBtn = $('#bootstrapContinue');
        checkbox.checked = false;
        continueBtn.disabled = true;
        checkbox.onchange = () => { continueBtn.disabled = !checkbox.checked; };
        continueBtn.onclick = () => {
          dlg.removeEventListener('cancel', onCancel);
          dlg.close();
          resolve();
        };
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    };
    dlg.showModal();
    pwInput.focus();
  });
}

// Aktivierungs-Fluss fuer ein NACHZUEGLER-Mitglied: dieses Konto hat bereits einen 'pending'-Wrap
// (state.crypto.pendingWrap, siehe /api/me), aber noch keinen eigenen password-Wrap. Entpackt den
// Haushalts-Schluessel mit dem offline erhaltenen Aktivierungscode, wrappt ihn sofort neu mit dem
// (bereits bekannten, unveraenderten) eigenen Login-Passwort und meldet den neuen Wrap an den
// Server -- danach liegt der Schluessel im Speicher, boot() faehrt normal fort.
function promptActivatePending() {
  return new Promise(resolve => {
    const dlg = $('#activateDialog');
    const form = $('#activateForm');
    const codeInput = $('#activateCode');
    const errEl = $('#activateError');
    errEl.hidden = true;
    const onCancel = ev => ev.preventDefault();
    dlg.addEventListener('cancel', onCancel);

    form.onsubmit = async ev => {
      ev.preventDefault();
      errEl.hidden = true;
      try {
        const pending = state.crypto.pendingWrap;
        const code = WPCrypto.normalizeRecoveryCode(codeInput.value);
        const kdfParams = { algo: pending.kdfAlgo, opslimit: pending.kdfTimeCost, memlimit: pending.kdfMemoryCost, parallelism: pending.kdfParallelism };
        const wrapKeyBytes = await WPCrypto.deriveWrapKey(code, WPCrypto.fromB64(pending.kdfSalt), kdfParams);
        let householdKey;
        try {
          householdKey = await WPCrypto.unwrapKey(
            WPCrypto.fromB64(pending.wrappedKey), WPCrypto.fromB64(pending.wrapNonce), wrapKeyBytes);
        } catch {
          errEl.textContent = 'Aktivierungscode ist falsch – bitte erneut versuchen.';
          errEl.hidden = false;
          codeInput.value = '';
          codeInput.focus();
          return;
        }

        // Sofortiger Re-Wrap mit dem eigenen, bereits bekannten Login-Passwort -- das
        // Aktivierungsgeheimnis selbst wird nach diesem Schritt nicht mehr gebraucht (der
        // pending-Wrap wird serverseitig auf revoked_at gesetzt, siehe /api/crypto/activate).
        // Das Passwort liegt hier bereits vor: der Login-Vorgang selbst (login.html) hat es
        // bereits per bcrypt server-authentifiziert, wird aber -- wie beim urspruenglichen
        // Registrierungs-Bootstrap (AP2.1) -- ein zweites Mal fuer die KDF gebraucht. Da
        // login.html/index.html getrennte JS-Kontexte sind (siehe Kommentar bei unlockHousehold()),
        // fragen wir es hier ein zweites Mal ab -- ueber dasselbe Formularfeld wie beim normalen
        // Entsperren-Dialog waere ein Bruch der Aktivierungs-UX; stattdessen nutzen wir den bereits
        // eingegebenen Aktivierungscode NICHT als Passwort-Ersatz, sondern fragen explizit nach.
        const newKdfParams = WPCrypto.defaultKdfParams();
        const salt = await WPCrypto.generateSalt();
        const password = await promptPasswordForRewrap();
        const wrapKey = await WPCrypto.deriveWrapKey(password, salt, newKdfParams);
        const wrapped = await WPCrypto.wrapKey(householdKey, wrapKey);
        const res = await api('POST', '/api/crypto/activate', {
          passwordWrap: buildWrapPayload(wrapped.wrappedKey, wrapped.nonce, salt, newKdfParams)
        });

        WPCrypto.setHouseholdKey(householdKey);
        state.crypto = { ...state.crypto, encryptionStatus: res.encryptionStatus, pendingWrap: null };
        dlg.removeEventListener('cancel', onCancel);
        dlg.close();
        resolve();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    };
    dlg.showModal();
    codeInput.focus();
  });
}

// Kleiner Zwischenschritt innerhalb von promptActivatePending(): fragt das Login-Passwort ein
// zweites Mal ab (fuer die KDF, siehe dortiger Kommentar) -- wiederverwendet #unlockDialog/
// #unlockForm (identisches Markup/Fehlerverhalten wie der normale Entsperren-Fall), nur dass hier
// NICHT unlockHousehold() (Unwrap gegen einen bestehenden Wrap) aufgerufen wird, sondern das
// Passwort unveraendert zurueckgegeben wird -- der Aufrufer (promptActivatePending()) leitet
// daraus selbst den NEUEN Wrap ab.
function promptPasswordForRewrap() {
  return new Promise(resolve => {
    const dlg = $('#unlockDialog');
    const form = $('#unlockForm');
    const pwInput = $('#unlockPassword');
    const errEl = $('#unlockError');
    $('#unlockTitle').textContent = 'Passwort bestätigen';
    dlg.querySelector('.sub').textContent = 'Bitte dein Passwort erneut eingeben, um die Aktivierung abzuschließen.';
    errEl.hidden = true;
    const onCancel = ev => ev.preventDefault();
    dlg.addEventListener('cancel', onCancel);
    form.onsubmit = ev => {
      ev.preventDefault();
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
      resolve(pwInput.value);
    };
    dlg.showModal();
    pwInput.focus();
  });
}

/* ---------------- AP2.5: clientseitiges Sweep-Feature ----------------
 * Laeuft NICHT-BLOCKIEREND im Hintergrund, nachdem der Haushalts-Schluessel entsperrt ist und
 * encryption_status==='active' (boot()) -- verschluesselt alle noch im Klartext liegenden
 * Altwochen des eigenen Haushalts lokal nach.
 *
 * ZANDORs bindende Vorgabe (Uebergangsfristen-Review): KEIN Karenzzeitraum mit parallelem
 * Klartext. Jede einzelne Woche wird ueber denselben PUT /api/weeks/:monday-Zyklus wie in AP2.1
 * atomar getauscht -- data=NULL und data_ciphertext werden in EINEM einzigen UPDATE gesetzt, der
 * XOR-CHECK (weeks_plaintext_xor_ciphertext, Migration 009) erzwingt serverseitig, dass niemals
 * ein Zwischenzustand mit gleichzeitig gueltigem Klartext UND Ciphertext entsteht.
 *
 * Wiederaufnahmefaehigkeit OHNE eigenen Fortschrittsspeicher: jeder Sweep-Lauf fragt
 * GET /api/weeks/sweep-status frisch ab. Eine vorzeitig abgebrochene vorherige Sitzung (Tab
 * geschlossen, Netzwerkfehler, ...) hinterlaesst dank der zeilen-atomaren Swaps IMMER einen
 * gueltigen Zustand -- ein Mix aus bereits verschluesselten und noch unverschluesselten Wochen,
 * nie eine halb geschriebene Zeile. Der naechste Sweep-Lauf (naechster Login) verschluesselt
 * einfach die verbleibenden Wochen weiter, ohne Duplikate oder Datenverlust.
 */
async function runEncryptionSweep() {
  const { plaintextWeeks } = await api('GET', '/api/weeks/sweep-status');
  if (!plaintextWeeks.length) return; // haeufigster Fall: nichts zu tun

  const panel = $('#sweepPanel');
  const total = plaintextWeeks.length;
  let done = 0;
  const renderProgress = () => {
    panel.hidden = false;
    panel.className = 'alert alert-info';
    panel.textContent = `Verschlüssle Altdaten: ${done} von ${total} Wochen …`;
  };
  renderProgress();

  for (const iso of plaintextWeeks) {
    try {
      const res = await api('GET', `/api/weeks/${iso}`);
      if (res.encrypted) { done++; renderProgress(); continue; } // zwischenzeitlich anderswo verschluesselt (z. B. zweiter Tab)
      const { nonce, ciphertext } = await WPCrypto.encryptJSON(WPCrypto.getHouseholdKey(), res.data);
      await api('PUT', `/api/weeks/${iso}`,
        { encrypted: true, keyVersion: state.crypto?.keyVersion || 1, nonce, ciphertext, baseUpdatedAt: res.updatedAt });
      done++;
      renderProgress();
    } catch (err) {
      // AP4.2 (ZANDOR-Review, Fund 3): ein 409 bedeutet "ein anderes Geraet/Tab hat diese Woche
      // zwischen unserem GET und PUT bereits geaendert" (z. B. dort selbst verschluesselt oder ein
      // regulaerer Bearbeitungs-Konflikt) -- ein haeufig erwartbarer, harmloser Fall beim Sweep,
      // kein echter Fehler. Einfach mit der naechsten Woche weitermachen, statt den gesamten Sweep
      // abzubrechen; taucht diese Woche noch als Klartext auf, greift sie der naechste Sweep-Lauf
      // (bzw. der lazy Fallback beim naechsten Speichern) ohnehin wieder auf.
      if (err.status === 409) {
        console.warn('AP2.5-Sweep: Woche', iso, 'wurde zwischenzeitlich anderswo geaendert (409) -- weiter mit der naechsten Woche.');
        continue;
      }
      // Echter Fehler: Abbruch mitten im Sweep. Die bereits verschluesselten Wochen bleiben es
      // (atomarer Swap je Woche, siehe Dateikopf-Kommentar) -- kein Rollback noetig oder gewuenscht.
      // Der naechste Login setzt den Sweep automatisch dort fort, wo dieser Lauf aufgehoert hat.
      panel.hidden = false;
      panel.className = 'alert alert-warning';
      panel.textContent = `Verschlüsselung der Altdaten unterbrochen (${done} von ${total} erledigt) – wird beim nächsten Anmelden fortgesetzt.`;
      console.error('AP2.5-Sweep: Fehler bei Woche', iso, err);
      return;
    }
  }

  panel.hidden = false;
  panel.className = 'alert alert-success';
  panel.textContent = 'Alle Termine sind jetzt vollständig verschlüsselt.';
  setTimeout(() => { panel.hidden = true; }, 6000);
}

// Wandelt eine GET-/409-Konflikt-Antwort von /api/weeks(/:monday) einheitlich in Klartext um --
// entschluesselt bei encrypted:true lokal mit dem bereits entsperrten Haushalts-Schluessel.
// mustEncryptOnSave sagt, ob diese Woche beim naechsten Speichern verschluesselt werden muss
// (entweder weil sie es schon ist, oder weil der Haushalt seit dem Laden aktiv verschluesselt --
// siehe server.js GET-Handler, Abschnitt "mustEncryptOnSave").
async function decodeWeekResponse(res) {
  if (res.encrypted) {
    const data = await WPCrypto.decryptJSON(WPCrypto.getHouseholdKey(), res.nonce, res.ciphertext);
    return { data, mustEncryptOnSave: true };
  }
  return { data: res.data, mustEncryptOnSave: !!res.mustEncryptOnSave };
}

// Baut den PUT-Body fuer /api/weeks/:monday -- verschluesselt lokal, wenn state.weekEncrypted
// gesetzt ist (siehe loadWeek()), sonst unveraendertes Klartext-Verhalten wie vor AP2.1.
async function buildWeekSaveBody(data, baseUpdatedAt) {
  if (state.weekEncrypted) {
    const { nonce, ciphertext } = await WPCrypto.encryptJSON(WPCrypto.getHouseholdKey(), data);
    return { encrypted: true, keyVersion: state.crypto?.keyVersion || 1, nonce, ciphertext, baseUpdatedAt };
  }
  return { data, baseUpdatedAt };
}

/* ---------------- AP2.2: beliebige Woche laden/speichern -----------------
 * loadWeekDataFor()/saveWeekDataFor() sind die verallgemeinerten Geschwister von loadWeek()/save()
 * fuer eine NICHT die aktuell geladene Woche (Next-Woche-Vorschau, Rezeptkarten-Zuweisung in eine
 * zweite/dritte Woche via Einkaufstag-Auswahl) -- ohne den vollen state.data/dirty/saving-Zyklus,
 * siehe Kommentar bei nextWeekStart/nextWeekData weiter unten. */

// JS-Port von mergeTemplate() (server.js) -- fuer AP2.2 noetig, weil der Server einer
// verschluesselten Vorlage nicht mehr ansehen kann, wie sie mit einer neuen Woche zu mergen ist
// (GET /api/weeks/:monday liefert fuer eine noch nicht existierende Woche eines aktiven Haushalts
// nur noch einen unbestueckten Standardaufbau + templateEncrypted:true, siehe server.js). Identische
// Argumentreihenfolge wie im Server-Original: "week" (hier: die entschluesselte Vorlage) ist die
// Basis und gewinnt bei Namenskonflikten, "template" (hier: der vom Server gelieferte
// Standardaufbau) ergaenzt nur fehlende Zeilen/leere Zellen.
function mergeTemplateClient(week, template) {
  if (!template) return week;
  const out = structuredClone(week);
  const rowKey = r => (r.kind || '') + '|' + String(r.label || '').trim().toLowerCase();
  const existing = new Set(out.rows.map(rowKey));
  template.rows.forEach((trow, i) => {
    const row = out.rows[i];
    if (!row) {
      const key = rowKey(trow);
      if (trow.label && existing.has(key)) return;
      out.rows[i] = structuredClone(trow);
      existing.add(key);
      return;
    }
    if (!row.label) row.label = trow.label;
    if (!row.role) row.role = trow.role;
    if (Array.isArray(trow.cells) && Array.isArray(row.cells)) {
      trow.cells.forEach((cell, d) => {
        if (cell.length && row.cells[d] && row.cells[d].length === 0) row.cells[d] = structuredClone(cell);
      });
    } else if (Array.isArray(trow.meals) && Array.isArray(row.meals)) {
      trow.meals.forEach((tmeal, mi) => {
        const meal = row.meals[mi];
        if (!meal) return;
        tmeal.cells.forEach((cell, d) => {
          if (cell.length && meal.cells[d] && meal.cells[d].length === 0) meal.cells[d] = structuredClone(cell);
        });
      });
    }
  });
  out.rows = out.rows.filter(Boolean);
  return out;
}

// Laedt+entschluesselt eine BELIEBIGE Woche per ISO-Montag (nicht zwingend die aktuell geladene).
// Uebernimmt fuer eine noch nicht existierende Woche eines aktiven Haushalts zusaetzlich das
// Vorlagen-Merge, das der Server fuer diesen Fall nicht mehr selbst leisten kann (templateEncrypted).
async function loadWeekDataFor(iso) {
  const res = await api('GET', `/api/weeks/${iso}`);
  const decoded = await decodeWeekResponse(res);
  let data = decoded.data;
  if (!res.exists && res.templateEncrypted) {
    const tRes = await api('GET', '/api/template');
    if (tRes.encrypted) {
      const template = await WPCrypto.decryptJSON(WPCrypto.getHouseholdKey(), tRes.nonce, tRes.ciphertext);
      data = mergeTemplateClient(structuredClone(template), data);
    }
  }
  return { data, updatedAt: res.updatedAt, exists: res.exists, mustEncryptOnSave: decoded.mustEncryptOnSave };
}

// Speichert eine BELIEBIGE Woche per ISO-Montag zurueck. "mustEncrypt" kommt vom vorherigen
// loadWeekDataFor()-Aufruf (siehe dort) -- bewusst NICHT state.weekEncrypted, das gilt nur fuer die
// aktuell geladene Hauptwoche.
async function saveWeekDataFor(iso, data, baseUpdatedAt, mustEncrypt) {
  let body;
  if (mustEncrypt) {
    const { nonce, ciphertext } = await WPCrypto.encryptJSON(WPCrypto.getHouseholdKey(), data);
    body = { encrypted: true, keyVersion: state.crypto?.keyVersion || 1, nonce, ciphertext, baseUpdatedAt };
  } else {
    body = { data, baseUpdatedAt };
  }
  return api('PUT', `/api/weeks/${iso}`, body);
}

/* ---------------- Tokens <-> DOM ---------------- */
function tokensToFragment(tokens) {
  const frag = document.createDocumentFragment();
  (tokens || []).forEach(tok => {
    if (tok.t === 'text') frag.appendChild(document.createTextNode(tok.v));
    else if (tok.t === 'br') frag.appendChild(document.createElement('br'));
    else if (tok.t === 'icon') frag.appendChild(iconSpan(tok.v, tok.l));
  });
  return frag;
}
function iconSpan(id, label) {
  const span = document.createElement('span');
  span.className = 'ic';
  span.contentEditable = 'false';
  span.dataset.icon = id;
  span.dataset.label = label || ICON_LABEL[id] || '';
  span.title = (span.dataset.label || id) + ' – Doppelklick löscht';
  span.appendChild(iconSvg(id));
  return span;
}
function cellToTokens(el) {
  const out = [];
  (function walk(node) {
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) {
        const v = n.nodeValue.replace(/ /g, ' ');
        if (v) out.push({ t: 'text', v });
      } else if (n.nodeType === 1) {
        if (n.tagName === 'BR') out.push({ t: 'br' });
        else if (n.classList.contains('ic')) out.push({ t: 'icon', v: n.dataset.icon, l: n.dataset.label || '' });
        else { if (/^(DIV|P|LI)$/.test(n.tagName) && out.length) out.push({ t: 'br' }); walk(n); }
      }
    });
  })(el);
  const merged = [];
  for (const tok of out) {
    const last = merged[merged.length - 1];
    if (tok.t === 'text' && last && last.t === 'text') last.v += tok.v;
    else merged.push({ ...tok });
  }
  while (merged.length && merged.at(-1).t === 'text' && !merged.at(-1).v.trim()) merged.pop();
  if (merged.length === 1 && merged[0].t === 'text' && !merged[0].v.trim()) return [];
  return merged;
}
const tokensText = tokens => (tokens || []).map(t => t.t === 'text' ? t.v : t.t === 'icon' ? (t.l || '') : ' ').join('');
const isEmpty = tokens => !tokens || tokens.length === 0;

/* ---------------- Palette und Legende ---------------- */
function buildPalette() {
  const pal = $('#palette');
  ICONS.forEach(grp => {
    const box = document.createElement('div');
    box.className = 'pgroup';
    const b = document.createElement('b'); b.textContent = grp.g; box.appendChild(b);
    grp.items.forEach(([id, label, long]) => {
      const text = long || label;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'pbtn'; btn.title = text + ' einfügen';
      btn.appendChild(iconSvg(id));
      const cap = document.createElement('span'); cap.textContent = label; btn.appendChild(cap);
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => insertIcon(id, text));
      box.appendChild(btn);
    });
    pal.appendChild(box);
  });
}
function buildLegend() {
  const leg = $('#legend');
  ICONS.flatMap(g => g.items).forEach(([id, label, long]) => {
    const d = document.createElement('div'); d.className = 'it';
    d.appendChild(iconSvg(id));
    const s = document.createElement('span'); s.textContent = long || label;
    d.appendChild(s); leg.appendChild(d);
  });
}

let lastRange = null, lastCell = null;
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (!sel.rangeCount) return;
  const node = sel.getRangeAt(0).startContainer;
  const cell = (node.nodeType === 1 ? node : node.parentElement)?.closest('.cell[contenteditable]');
  if (cell) { lastRange = sel.getRangeAt(0).cloneRange(); lastCell = cell; }
});
function insertIcon(id, label) {
  if (!lastCell || !document.body.contains(lastCell)) { flash('Bitte zuerst in ein Feld tippen.'); return; }
  if (document.activeElement !== lastCell) lastCell.focus();
  const frag = document.createDocumentFragment();
  frag.appendChild(iconSpan(id, label));
  // geschuetztes Leerzeichen, damit der Browser es am Zeilenende nicht verwirft;
  // beim Speichern wird daraus wieder ein normales Leerzeichen
  const tail = document.createTextNode(label + String.fromCharCode(160));
  frag.appendChild(tail);
  let endNode = tail;
  if (lastCell.classList.contains('autobreak')) {
    // Neue Listen-/Essensplan-Editierfelder (Tagesliste, Essensplan): nach dem Piktogramm
    // automatisch eine neue Zeile beginnen, damit der folgende Text nicht am Icon "klebt"
    // (Design-Feedback). Bewusst nur fuer diese neuen Elemente (Klasse "autobreak") — das
    // bestehende Verhalten der Personen-/Haushalt-Zeilen im Hauptraster bleibt unveraendert.
    const br = document.createElement('br');
    frag.appendChild(br);
    endNode = br;
  }
  let r = lastRange;
  if (!r || !lastCell.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(lastCell); r.collapse(false); }
  r.deleteContents(); r.insertNode(frag);
  const after = document.createRange(); after.setStartAfter(endNode); after.collapse(true);
  const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(after);
  lastRange = after.cloneRange();
  markDirty();
}
document.addEventListener('dblclick', e => {
  const ic = e.target.closest('.ic');
  if (ic && ic.closest('.cell[contenteditable]')) { ic.remove(); markDirty(); }
});

/* ---------------- Darstellung: A4-Blatt ---------------- */
function renderHead() {
  const mon = parseISO(state.weekStart);
  const headRow = $('#headRow');
  headRow.querySelectorAll('th:not(.corner)').forEach(th => th.remove());
  const todayIdx = todayColumnIndex();
  DAYS.forEach((name, i) => {
    const d = parseISO(state.weekStart); d.setDate(d.getDate() + i);
    const th = document.createElement('th');
    const classes = [];
    if (i > 4) classes.push('we');
    if (i === todayIdx) classes.push('today');
    if (classes.length) th.className = classes.join(' ');
    th.innerHTML = `<span class="dw"></span><span class="dt"></span>`;
    th.querySelector('.dw').textContent = name;
    th.querySelector('.dt').textContent = fmtShort(d);
    if (i === todayIdx) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Heute';
      th.appendChild(badge);
    }
    headRow.appendChild(th);
  });
  const sun = parseISO(state.weekStart); sun.setDate(sun.getDate() + 6);
  $('#kwLabel').textContent = 'KW ' + isoWeek(mon);
  $('#rangeLabel').textContent =
    mon.toLocaleDateString('de-DE', { day: '2-digit', month: 'long' }) + ' – ' +
    sun.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  $('#monday').value = state.weekStart;
}

function editableCell(tokens, attrs, cls) {
  const div = document.createElement('div');
  div.className = 'cell' + (cls ? ' ' + cls : '');
  div.contentEditable = 'true';
  Object.entries(attrs).forEach(([k, v]) => div.setAttribute(k, v));
  div.appendChild(tokensToFragment(tokens));
  return div;
}

/* Liste-Link-Button fuer Zeilen mit listMode:true ("Einkauf & Besorgungen"): ersetzt die
   frei editierbare Zelle durch einen Link/Button, der die Tagesliste fuer genau diesen Tag
   oeffnet. Zeigt bewusst nur Zustand (leer/befuellt) und Anzahl als Badge — kein Vorschautext
   der Eintraege mehr in der Zelle. */
function renderListLink(row, ri, d) {
  const items = row.cells[d] || [];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'listlink' + (items.length ? ' filled' : '');
  btn.appendChild(iconSvg('i-liste'));
  const lbl = document.createElement('span');
  lbl.className = 'll-label';
  lbl.textContent = items.length ? 'Liste öffnen' : 'Liste anlegen';
  btn.appendChild(lbl);
  if (items.length) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(items.length);
    btn.appendChild(badge);
  }
  btn.addEventListener('click', () => openDayList(ri, d));
  return btn;
}
// AP1.1: renderWeekLink() (Button "Essensplan öffnen" fuer die alte Einstiegskarte) ist mit dem
// #mealplan-Overlay-Wegfall entfallen -- "Essen & Kochen" ist jetzt permanent sichtbar, kein
// Link/Button noetig, der sie erst oeffnet.

/* AP3.1/AP3.3 (Konzept-Hauptraster-Option-B.md Abschnitt 3/5): gemeinsamer Avatar-Chip-Baustein
   (Kreis mit Initiale aus row.label, bei gemeinsamen Zeilen Haus-Icon statt Initiale) -- von
   renderSheet() (Hauptraster) UND renderDay() (mobile Tagesansicht) genutzt, damit beide
   Ansichten dieselbe Personen-Kennzeichnung zeigen statt zweier unterschiedlicher Muster
   (Hauptraster: Avatar-Chip / Tagesansicht bislang: Randlinie). */
function buildAvatarChip(row) {
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  if (row.kind === 'shared') {
    avatar.innerHTML = '<i class="bi bi-house-heart" aria-hidden="true"></i>';
  } else {
    avatar.textContent = (row.label || '').trim().charAt(0).toUpperCase() || '?';
  }
  return avatar;
}

function renderSheet() {
  renderHead();
  const body = $('#gridBody');
  body.textContent = '';
  let firstShared = true;
  let personIndex = 0;
  const todayIdx = todayColumnIndex();
  state.data.rows.forEach((row, ri) => {
    // Funktions-Dopplung-Fix (Nutzer-Feedback 2026-08-19): Zeilen mit einer eigenen dedizierten
    // Ansicht im Linksmenue ("Essen & Kochen" = mode:'week', "Einkauf & Besorgungen" =
    // listMode:true) werden im Hauptraster nicht mehr dargestellt -- sie sind ausschliesslich
    // ueber die Ansichten "Essen & Kochen"/"Einkaufen" erreichbar (renderShoppingView()/
    // renderMealPlanEntry() weiter unten, die dieselben Datenzeilen anzeigen). Die Zeilen bleiben
    // vollstaendig in state.data.rows erhalten (samt Index ri) -- nur diese eine Darstellung
    // entfaellt, damit "ri" fuer Klick-Handler (Zeile-loeschen, data-cell/-label) unveraendert
    // mit dem Datenmodell und mit syncFromDOM()/openDayList() synchron bleibt.
    if (row.mode === 'week' || row.listMode) return;

    const tr = document.createElement('tr');
    tr.className = row.kind;
    if (row.kind === 'shared' && firstShared) { tr.classList.add('first-shared'); firstShared = false; }
    if (row.kind === 'person') { tr.classList.add(FAM_CLASSES[personIndex % FAM_CLASSES.length]); personIndex++; }

    const td = document.createElement('td');
    td.className = 'lbl';

    // AP3.1 (Konzept-Hauptraster-Option-B.md Abschnitt 3/6): Avatar-Chip vor Name/Rolle, als
    // Geschwister-Element eines Wrappers um Name/Rolle -- NICHT als deren Vorfahre, damit
    // syncFromDOM() (liest [data-label]/[data-role] weiterhin per querySelectorAll) unveraendert
    // funktioniert. Die Initiale wird bei jedem Re-Render frisch aus row.label abgeleitet, kein
    // eigenes Datenfeld noetig.
    const head = document.createElement('div');
    head.className = 'lbl-head';
    head.appendChild(buildAvatarChip(row));

    const text = document.createElement('div');
    text.className = 'lbl-text';
    const label = document.createElement('span');
    label.className = 'cell'; label.contentEditable = 'true';
    label.setAttribute('data-label', ri); label.textContent = row.label;
    text.appendChild(label);
    if (row.kind === 'person') {
      const role = document.createElement('span');
      role.className = 'cell role'; role.contentEditable = 'true';
      role.setAttribute('data-role', ri); role.setAttribute('data-ph', 'Rolle / Notiz');
      role.textContent = row.role || '';
      text.appendChild(role);
    }
    head.appendChild(text);
    td.appendChild(head);

    const del = document.createElement('span');
    del.className = 'rowtool'; del.title = 'Zeile entfernen'; del.textContent = '×';
    del.onclick = () => { if (confirm('Diese Zeile entfernen?')) { syncFromDOM(); state.data.rows.splice(ri, 1); renderAll(); markDirty(); } };
    td.appendChild(del);
    tr.appendChild(td);

    // "mode:'week'"/"listMode"-Zeilen erreichen diese Stelle nicht mehr (siehe frueher
    // Rueckgabe oben) -- hier bleiben nur noch normale, frei editierbare Zeilen (Personen,
    // "Haushalt & Sonstiges").
    for (let d = 0; d < 7; d++) {
      const cell = document.createElement('td');
      const classes = [];
      if (d > 4) classes.push('we');
      if (d === todayIdx) classes.push('today');
      if (classes.length) cell.className = classes.join(' ');
      cell.appendChild(editableCell(row.cells[d], { 'data-cell': `${ri},${d}` }));
      tr.appendChild(cell);
    }
    body.appendChild(tr);
  });

  const motto = $('[data-bind="motto"]');
  motto.textContent = ''; motto.appendChild(tokensToFragment(state.data.motto));
  const notes = $('.notes [data-bind="notes"]');
  notes.textContent = ''; notes.appendChild(tokensToFragment(state.data.notes));
}

/* ---------------- Darstellung: Tagesansicht ---------------- */
function renderDay() {
  const nav = $('#daynav');
  nav.textContent = '';
  const todayIdx = todayColumnIndex();
  DAYS.forEach((name, i) => {
    const d = parseISO(state.weekStart); d.setDate(d.getDate() + i);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-current', String(i === state.day));
    if (i === todayIdx) b.classList.add('today');
    b.innerHTML = '<span></span><small></small>';
    b.querySelector('span').textContent = DAYS_S[i];
    b.querySelector('small').textContent = fmtShort(d);
    b.onclick = () => { syncFromDOM(); state.day = i; renderDay(); };
    nav.appendChild(b);
  });
  nav.children[state.day]?.scrollIntoView({ inline: 'center', block: 'nearest' });

  const wrap = $('#dayCards');
  wrap.textContent = '';
  const d = parseISO(state.weekStart); d.setDate(d.getDate() + state.day);

  const card = document.createElement('div');
  card.className = 'daycard';
  const h = document.createElement('h3');
  h.textContent = DAYS[state.day];
  const sub = document.createElement('span');
  sub.textContent = d.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  h.appendChild(sub);
  card.appendChild(h);

  let personIndex = 0;
  state.data.rows.forEach((row, ri) => {
    // Funktions-Dopplung-Fix (Nutzer-Feedback 2026-08-19): analog zu renderSheet() oben --
    // "Essen & Kochen"/"Einkauf & Besorgungen" haben eigene dedizierte Ansichten im
    // Linksmenue (bzw. der unteren Tab-Leiste auf schmalen Bildschirmen, wo diese
    // Tagesansicht ueberhaupt zum Einsatz kommt) und werden deshalb auch hier nicht mehr
    // dargestellt, statt sie an zwei Stellen gleichzeitig anzuzeigen.
    if (row.mode === 'week' || row.listMode) return;
    const line = document.createElement('div');
    line.className = 'dayrow';
    if (row.kind === 'person') { line.classList.add(FAM_CLASSES[personIndex % FAM_CLASSES.length]); personIndex++; }
    // AP3.3 (Konzept-Hauptraster-Option-B.md Abschnitt 5): derselbe Avatar-Chip wie im
    // Hauptraster statt der bisherigen farbigen Randlinie -- Name/Rolle stehen dafuer in einem
    // eigenen Textwrapper neben dem Chip statt direkt im "who"-Container.
    const who = document.createElement('div');
    who.className = 'who';
    who.appendChild(buildAvatarChip(row));
    const whoText = document.createElement('span');
    whoText.className = 'who-text';
    whoText.textContent = row.label || (row.kind === 'person' ? 'Person' : 'Zeile');
    if (row.role) { const s = document.createElement('small'); s.textContent = row.role; whoText.appendChild(s); }
    who.appendChild(whoText);
    line.appendChild(who);
    line.appendChild(editableCell(row.cells[state.day], { 'data-cell': `${ri},${state.day}` }));
    card.appendChild(line);
  });
  wrap.appendChild(card);

  const notesCard = document.createElement('div');
  notesCard.className = 'daycard notes-card';
  const nh = document.createElement('h3'); nh.textContent = 'Notizen der Woche';
  notesCard.appendChild(nh);
  const nrow = document.createElement('div'); nrow.className = 'dayrow';
  nrow.appendChild(editableCell(state.data.notes, { 'data-bind': 'notes' }));
  notesCard.appendChild(nrow);
  wrap.appendChild(notesCard);
}

function activeContainer() { return state.view === 'sheet' ? $('.stage') : $('#dayview'); }
function renderAll() { renderSheet(); renderDay(); renderShoppingView(); renderMealPlanEntry(); renderFocusBlocks(); }

/* ---------------- AP3.3: Fokusbloecke "Wochenziele" / "Besonders diese Woche" /
   "Anrufen/Kontaktieren" (Datenmodell-Fokusbloecke-v2.md). Anders als die Tokenzellen im
   Hauptraster/der Tagesliste sind Eintraege hier einfache Strings (siehe server.js,
   cleanGoals()/cleanHighlights()/cleanCalls()) -- kein Icon-Mechanismus vorgesehen. Bewusst
   EINMAL im DOM (nicht wie .stage/#dayview dupliziert pro Ansicht), deshalb kein
   data-cell-Tracking in syncFromDOM() noetig: state.data.goals/.calls/.highlights werden direkt
   per push()/splice() bzw. Index-Zuweisung veraendert, renderFocusBlocks() zeichnet danach neu. */
const FOCUS_LIMITS = { goals: 12, highlights: 8, calls: 20 }; // siehe LIMITS in server.js
// AP2.2 (projects/wochenplaner-rezeptkarten/plan.md): spiegelt LIMITS.recipeIngredients bzw.
// RECIPE_IMAGE_MAX_BYTES in server.js -- rein clientseitige Vorabpruefung, damit ein zu grosses
// Bild/eine zu lange Zutatenliste nicht erst nach einem Roundtrip zum Server auffaellt. Die
// eigentliche, verbindliche Pruefung bleibt serverseitig (cleanIngredients()/multer-Limit).
const RECIPE_LIMITS = { ingredients: 60, imageMaxBytes: 5 * 1024 * 1024 };
// AP1.4: RECIPE_DRAG_MIME (eigener MIME-Typ fuer die frühere Drag&Drop-Zuweisung) ist mit dem
// D&D-Rueckbau entfallen -- die Zuweisung laeuft seit AP1.2 ausschliesslich ueber den
// Zell-Klick-Dialog (openMealSlotDialog()/submitMealSlotRecipe()).

/* "Wochenziele" (nummeriert, Checkbox links) und "Anrufen/Kontaktieren" (Checkbox rechts):
   Text wird wie bei der Tagesliste (renderItemsList() oben) nur beim Hinzufuegen erfasst und
   danach nur noch abgehakt oder entfernt, nicht nachtraeglich umgeschrieben -- gleiches,
   bereits etabliertes Interaktionsmuster. */
function renderCheckItems(listEl, items, ordered) {
  listEl.textContent = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'focus-empty';
    empty.textContent = ordered ? 'Noch keine Wochenziele eingetragen.' : 'Noch keine Einträge.';
    listEl.appendChild(empty);
  }
  items.forEach((it, i) => {
    const row = document.createElement(ordered ? 'li' : 'div');
    if (ordered) {
      const num = document.createElement('span');
      num.className = 'goal-num';
      num.textContent = String(i + 1);
      row.appendChild(num);
    } else {
      row.className = 'focus-call-row';
    }
    const check = document.createElement('div');
    check.className = 'form-check' + (ordered ? ' flex-grow-1' : '');
    const cbId = (ordered ? 'goal' : 'call') + i;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'form-check-input'; cb.id = cbId;
    cb.checked = !!it.done;
    cb.addEventListener('change', () => { it.done = cb.checked; markDirty(); });
    const label = document.createElement('label');
    label.className = 'form-check-label'; label.htmlFor = cbId;
    label.textContent = it.text;
    check.append(cb, label);
    row.appendChild(check);
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'focus-remove'; rm.textContent = '×';
    rm.title = 'Eintrag entfernen'; rm.setAttribute('aria-label', 'Eintrag entfernen');
    rm.addEventListener('click', () => { items.splice(i, 1); markDirty(); renderFocusBlocks(); });
    row.appendChild(rm);
    listEl.appendChild(row);
  });
}

/* "Besonders diese Woche": anders als Ziele/Anrufe reine, direkt editierbare Notizzeilen ohne
   Checkbox (Mockup zeigt hier linierte <input>-Felder, keine Haken) -- deshalb bewusst NICHT das
   Add-once-Muster von renderCheckItems(), sondern durchgehend editierbare Felder plus stets EINE
   zusaetzliche leere Zeile am Ende zum Anlegen eines neuen Eintrags (klassisches
   "linierte Notizzeilen"-Verhalten). Wird die letzte Zeile beim Verlassen befuellt, erscheint
   automatisch eine neue leere Zeile darunter; wird eine bestehende Zeile leer gemacht und
   verlassen, verschwindet sie wieder. */
function renderHighlights() {
  const listEl = $('#highlightsList');
  listEl.textContent = '';
  const items = state.data.highlights;
  const showNewSlot = items.length < FOCUS_LIMITS.highlights;
  const total = items.length + (showNewSlot ? 1 : 0);
  for (let i = 0; i < total; i++) {
    const isNewSlot = i === items.length;
    const row = document.createElement('div');
    row.className = 'highlight-row';
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'form-control'; input.maxLength = 200; // siehe LIMITS.highlightText in server.js
    input.placeholder = 'Freie Notiz …';
    input.value = isNewSlot ? '' : items[i];
    input.addEventListener('input', () => {
      if (isNewSlot) return; // neue Zeile wird erst beim Verlassen des Feldes uebernommen (siehe blur)
      items[i] = input.value.slice(0, 200);
      markDirty();
    });
    input.addEventListener('blur', () => {
      if (isNewSlot) {
        const text = input.value.trim();
        if (text) { items.push(text); markDirty(); renderFocusBlocks(); }
      } else if (!input.value.trim()) {
        items.splice(i, 1); markDirty(); renderFocusBlocks();
      }
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    row.appendChild(input);
    if (!isNewSlot) {
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'focus-remove'; rm.textContent = '×';
      rm.title = 'Eintrag entfernen'; rm.setAttribute('aria-label', 'Eintrag entfernen');
      rm.addEventListener('click', () => { items.splice(i, 1); markDirty(); renderFocusBlocks(); });
      row.appendChild(rm);
    }
    listEl.appendChild(row);
  }
}

function renderFocusBlocks() {
  renderCheckItems($('#goalsList'), state.data.goals, true);
  renderCheckItems($('#callsList'), state.data.calls, false);
  renderHighlights();
}

function addGoal() {
  const input = $('#goalsInput');
  const text = input.value.trim();
  if (!text) return;
  if (state.data.goals.length >= FOCUS_LIMITS.goals) { flash(`Maximal ${FOCUS_LIMITS.goals} Wochenziele möglich.`); return; }
  state.data.goals.push({ done: false, text });
  input.value = '';
  markDirty();
  renderFocusBlocks();
  $('#goalsInput').focus();
}
function addCall() {
  const input = $('#callsInput');
  const text = input.value.trim();
  if (!text) return;
  if (state.data.calls.length >= FOCUS_LIMITS.calls) { flash(`Maximal ${FOCUS_LIMITS.calls} Einträge möglich.`); return; }
  state.data.calls.push({ done: false, text });
  input.value = '';
  markDirty();
  renderFocusBlocks();
  $('#callsInput').focus();
}
function initFocusBlocks() {
  $('#goalsAdd').addEventListener('click', addGoal);
  $('#goalsInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addGoal(); } });
  $('#callsAdd').addEventListener('click', addCall);
  $('#callsInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCall(); } });
}

/* ---------------- AP3.2: Inhalt der Linksmenue-Ansicht "Einkaufen & Besorgungen". Fachlogik/
   Datenhaltung bleibt vollstaendig unveraendert (dieselben Zeilen, dasselbe openDayList()) --
   hier wird der bereits vorhandene renderListLink()-Baustein in einem eigenen Kartenraster
   wiederverwendet. Funktions-Dopplung-Fix (Nutzer-Feedback 2026-08-19): urspruenglich ein
   ZWEITER, zusaetzlicher Einstieg neben einem gleichwertigen Link im Hauptraster -- renderSheet()
   zeigt diese Zeile inzwischen nicht mehr an (siehe dort), diese Ansicht ist daher jetzt der
   EINZIGE Einstiegspunkt. Wird wie renderSheet()/renderDay() bei jeder Datenaenderung ueber
   renderAll() neu gezeichnet, auch waehrend die Ansicht gerade nicht sichtbar ist (reines
   display:none/-block, siehe .app-view in style-v2.css — kein erneutes Rendern beim
   Ansichtswechsel selbst noetig).
   AP1.1-Update: "Essen & Kochen" folgte urspruenglich demselben Karten-Link-Muster
   (renderWeekLink()/openMealPlan(), siehe Git-Historie) -- ist mit dem #mealplan-Overlay-Wegfall
   entfallen, diese Ansicht ist jetzt permanent die Tabelle selbst statt eines Links dorthin (siehe
   renderMealPlanEntry() weiter unten). */
function renderShoppingView() {
  const wrap = $('#shoppingLists');
  if (!wrap) return;
  wrap.textContent = '';
  const listRows = state.data.rows
    .map((row, ri) => ({ row, ri }))
    .filter(({ row }) => row.listMode === true);
  if (!listRows.length) {
    const p = document.createElement('p');
    p.className = 'view-empty';
    p.textContent = 'Für diese Woche ist aktuell keine Einkaufs-/Besorgungs-Zeile angelegt.';
    wrap.appendChild(p);
    return;
  }
  const todayIdx = todayColumnIndex();
  listRows.forEach(({ row, ri }) => {
    const section = document.createElement('div');
    section.className = 'shopping-row';
    const h = document.createElement('h2');
    h.textContent = row.label;
    section.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'shopping-days';
    DAYS.forEach((_, d) => {
      const dt = parseISO(state.weekStart); dt.setDate(dt.getDate() + d);
      const cell = document.createElement('div');
      cell.className = 'shopping-day' + (d === todayIdx ? ' today' : '');
      const label = document.createElement('div');
      label.className = 'shopping-day-label';
      label.innerHTML = '<span class="dw"></span><span class="dt"></span>';
      label.querySelector('.dw').textContent = DAYS_S[d];
      label.querySelector('.dt').textContent = fmtShort(dt);
      cell.appendChild(label);
      cell.appendChild(renderListLink(row, ri, d)); // dieselbe Schaltflaeche/Zaehlung wie im Hauptraster
      grid.appendChild(cell);
    });
    section.appendChild(grid);
    wrap.appendChild(section);
  });
}
// AP1.1: renderMealPlanEntry() (die eigentliche Renderfunktion fuer die jetzt permanente
// "Essen & Kochen"-Tabelle) steht weiter unten, direkt bei renderMealPlanHead()/
// renderMealPlanBody()/renderMealDayNav() -- diese Stelle hatte zuvor nur die kleine
// Einstiegskarte mit "Essensplan öffnen"-Button gebaut (renderWeekLink()), die mit dem
// Overlay-Wegfall entfallen ist.

/* ---------------- AP2.2 (projects/wochenplaner-rezeptkarten/plan.md): Rezeptkarten-Ansicht.
   Anders als die Wochendaten oben (state.data) sind Rezepte KEIN Bestandteil einer einzelnen
   Woche, sondern haushaltsweite Stammdaten -- eigener Zustand (state.recipes), einmal beim Start
   geladen (boot()) und nach jeder Aenderung (Anlegen/Bearbeiten/Loeschen) per loadRecipes() neu
   vom Server geholt statt lokal fortgeschrieben, da der Server ohnehin die kanonische Quelle ist
   und die Liste ueberschaubar bleibt (kein Bedarf fuer optimistisches Update). */
async function loadRecipes() {
  try {
    const { recipes } = await api('GET', '/api/recipes');
    state.recipes = recipes;
    renderRecipesView();
  } catch (err) { flash(err.message); }
}

function renderRecipesView() {
  const wrap = $('#recipeCards');
  if (!wrap) return;
  wrap.textContent = '';
  if (!state.recipes.length) {
    const p = document.createElement('p');
    p.className = 'view-empty';
    p.textContent = 'Noch keine Rezeptkarten angelegt.';
    wrap.appendChild(p);
    return;
  }
  state.recipes.forEach(r => {
    const col = document.createElement('div');
    col.className = 'col';
    const card = document.createElement('div');
    card.className = 'card recipe-card h-100';

    if (r.imagePath) {
      const img = document.createElement('img');
      img.className = 'recipe-card-img';
      img.alt = '';
      // Cache-Buster ueber updatedAt statt Date.now(): dieselbe URL (nach Rezept-ID, nicht nach
      // Dateiname) koennte sonst nach einem Bild-Austausch (PUT) eine veraltete, gecachte Antwort
      // liefern, obwohl sich der zugrunde liegende image_path geaendert hat.
      img.src = `/api/recipes/${r.id}/image?v=${encodeURIComponent(r.updatedAt)}`;
      card.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'recipe-card-img recipe-card-img-placeholder';
      ph.setAttribute('aria-hidden', 'true');
      ph.innerHTML = '<i class="bi bi-journal-richtext"></i>';
      card.appendChild(ph);
    }

    const body = document.createElement('div');
    body.className = 'card-body';
    const h3 = document.createElement('h3');
    h3.className = 'recipe-card-title';
    h3.textContent = r.title;
    const servings = document.createElement('p');
    servings.className = 'recipe-card-servings';
    servings.textContent = `Für ${r.baseServings} ${r.baseServings === 1 ? 'Person' : 'Personen'}`;
    const actions = document.createElement('div');
    actions.className = 'recipe-card-actions';
    // AP2.1 (projects/wochenplaner-rezeptkarten-drucken/plan.md): neuer Druck-Trigger je Karte --
    // laedt bei Klick die Volldaten nach (openRecipePrint(), analog openRecipeForm() darunter, da
    // die Karten-Summary bewusst keine instructions/ingredients enthaelt, siehe dortiger Kommentar).
    const printBtn = document.createElement('button');
    printBtn.type = 'button'; printBtn.className = 'btn btn-outline-secondary btn-sm';
    printBtn.textContent = 'Drucken';
    printBtn.addEventListener('click', () => openRecipePrint(r));
    const editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'btn btn-outline-secondary btn-sm';
    editBtn.textContent = 'Bearbeiten';
    editBtn.addEventListener('click', () => openRecipeForm(r));
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'btn btn-outline-secondary btn-sm text-danger';
    delBtn.textContent = 'Löschen';
    delBtn.addEventListener('click', () => deleteRecipe(r.id, r.title));
    actions.append(printBtn, editBtn, delBtn);
    body.append(h3, servings, actions);
    card.appendChild(body);
    col.appendChild(card);
    wrap.appendChild(col);
  });
}

async function deleteRecipe(id, title) {
  // window.confirm() ist das app-weite Muster fuer destruktive Bestaetigungen (siehe z. B.
  // Zeile-entfernen im Hauptraster oben) -- kein eigenes Bestaetigungs-Dialog-Markup noetig.
  if (!confirm(`Rezept „${title}“ wirklich löschen? Bereits im Essensplan zugewiesene Mahlzeiten behalten ihre eigene Kopie der Zutatenliste (Snapshot) und sind davon nicht betroffen.`)) return;
  try {
    await api('DELETE', `/api/recipes/${id}`);
    await loadRecipes();
  } catch (err) { flash(err.message); }
}

/* ---------------- Rezeptkarten-Formular (#recipeForm) ---------------- */
function addIngredientRow(ingredient) {
  const wrap = $('#rfIngredients');
  const row = document.createElement('div');
  row.className = 'recipe-ingredient-row';
  row.setAttribute('data-ingredient-row', '');
  row.innerHTML = `
    <input type="number" class="form-control recipe-ing-amount" placeholder="Menge" step="any" aria-label="Menge">
    <input type="text" class="form-control recipe-ing-unit" placeholder="Einheit" maxlength="20" aria-label="Einheit">
    <input type="text" class="form-control recipe-ing-name" placeholder="Zutat" maxlength="100" aria-label="Zutat">
    <button type="button" class="focus-remove" title="Zutat entfernen" aria-label="Zutat entfernen">×</button>`;
  if (ingredient) {
    row.querySelector('.recipe-ing-amount').value = ingredient.amount ?? '';
    row.querySelector('.recipe-ing-unit').value = ingredient.unit || '';
    row.querySelector('.recipe-ing-name').value = ingredient.name || '';
  }
  row.querySelector('.focus-remove').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}

function collectIngredientsFromForm() {
  const out = [];
  document.querySelectorAll('#rfIngredients [data-ingredient-row]').forEach(row => {
    const name = row.querySelector('.recipe-ing-name').value.trim();
    if (!name) return; // Name ist die einzige Pflichtangabe, siehe cleanIngredients() in server.js
    const amountRaw = row.querySelector('.recipe-ing-amount').value;
    const amount = amountRaw === '' ? null : Number(amountRaw);
    const unit = row.querySelector('.recipe-ing-unit').value.trim();
    out.push({ amount: Number.isFinite(amount) ? amount : null, unit, name });
  });
  return out;
}

function showRecipeFormError(text) {
  const el = $('#rfError');
  el.textContent = text;
  el.hidden = !text;
}

// recipeSummary: null fuer ein neues Rezept, sonst ein Eintrag aus state.recipes (nur die
// Uebersichtsfelder) -- Details (instructions/ingredients) fehlen dort bewusst (GET /api/recipes
// haelt die Antwort klein, siehe server.js-Kommentar) und werden hier bei Bedarf einzeln
// nachgeladen.
async function openRecipeForm(recipeSummary) {
  showRecipeFormError('');
  $('#rfImage').value = '';
  $('#rfIngredients').textContent = '';

  let recipe = null;
  if (recipeSummary) {
    try { recipe = (await api('GET', `/api/recipes/${recipeSummary.id}`)).recipe; }
    catch (err) { flash(err.message); return; }
  }

  $('#rfId').value = recipe ? recipe.id : '';
  $('#rfTitleInput').value = recipe ? recipe.title : '';
  $('#rfServings').value = recipe ? recipe.baseServings : '';
  $('#rfInstructions').value = recipe ? recipe.instructions : '';
  $('#rfTitle').textContent = recipe ? 'Rezept bearbeiten' : 'Neues Rezept';

  const ingredients = recipe ? recipe.ingredients : [];
  if (ingredients.length) ingredients.forEach(addIngredientRow);
  else addIngredientRow(); // eine leere Startzeile, statt einer komplett leeren Liste ohne Eingabefeld

  const preview = $('#rfImagePreview');
  preview.textContent = '';
  const removeWrap = $('#rfRemoveImageWrap');
  $('#rfRemoveImage').checked = false;
  if (recipe && recipe.imagePath) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = `/api/recipes/${recipe.id}/image?v=${encodeURIComponent(recipe.updatedAt)}`;
    preview.appendChild(img);
    removeWrap.hidden = false;
  } else {
    removeWrap.hidden = true;
  }

  $('#recipeForm').showModal();
}

/* ---------------- AP2.1 (projects/wochenplaner-rezeptkarten-drucken/plan.md): Druck-Dialog
   (#recipePrint) fuer eine einzelne Rezeptkarte -- eigenes, aus den Daten neu aufgebautes
   Anzeige-Fragment, siehe Designentscheidung D2 im Plan (kein Wiederverwenden von #recipeForm). */
function formatIngredientAmount(ing) {
  if (typeof ing.amount !== 'number' || !Number.isFinite(ing.amount)) return ing.unit || '';
  return ing.unit ? `${ing.amount} ${ing.unit}` : String(ing.amount);
}

// Baut den druckbaren Inhalt komplett neu aus den Rezeptdaten auf. Permanent als
// <table><thead>/<tbody> strukturiert (nicht nur waehrend des Drucks umgeschaltet): der
// <thead>-Titelzeilen-Kniff (D3 im Plan) ist der einzige HTML-Mechanismus, der sich beim
// Drucken browseruebergreifend zuverlaessig auf jeder Folgeseite wiederholt, wenn die Tabelle
// ueber eine Seitengrenze umbricht -- isoliert per Prototyp getestet (AP1.1, visuelle
// Verifikation durch ANORAK steht noch aus), hier direkt auf das reale Markup angewendet (AP2.2).
// Da dieselbe Tabelle auch
// die Bildschirm-Vorschau im Dialog traegt, gibt es keine zwei separat zu pflegenden
// Markup-Varianten.
function buildRecipePrintContent(recipe) {
  const body = $('#rpBody');
  body.textContent = '';

  const table = document.createElement('table');
  table.className = 'recipe-print-table';

  const thead = document.createElement('thead');
  const titleRow = document.createElement('tr');
  titleRow.className = 'recipe-print-title-row';
  const titleCell = document.createElement('th');
  const title = document.createElement('div');
  title.className = 'recipe-print-title';
  title.textContent = recipe.title;
  const servings = document.createElement('div');
  servings.className = 'recipe-print-servings';
  servings.textContent = `Für ${recipe.baseServings} ${recipe.baseServings === 1 ? 'Person' : 'Personen'}`;
  titleCell.append(title, servings);
  titleRow.appendChild(titleCell);
  thead.appendChild(titleRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const row = document.createElement('tr');
  const cell = document.createElement('td');

  if (recipe.imagePath) {
    // max-height/max-width in mm kommen aus .recipe-print-image (style.css, Risiko "grosses Bild
    // sprengt Seitenumbruch-Berechnung" im Plan) -- hier nur die Bildquelle gesetzt.
    const img = document.createElement('img');
    img.className = 'recipe-print-image';
    img.alt = '';
    img.src = `/api/recipes/${recipe.id}/image?v=${encodeURIComponent(recipe.updatedAt)}`;
    cell.appendChild(img);
  }

  const ingHeading = document.createElement('h3');
  ingHeading.className = 'recipe-print-heading';
  ingHeading.textContent = 'Zutaten';
  cell.appendChild(ingHeading);

  const list = document.createElement('ul');
  list.className = 'recipe-print-ingredients';
  if (recipe.ingredients.length) {
    recipe.ingredients.forEach(ing => {
      const li = document.createElement('li');
      const amount = document.createElement('span');
      amount.className = 'recipe-print-ing-amount';
      amount.textContent = formatIngredientAmount(ing);
      const name = document.createElement('span');
      name.className = 'recipe-print-ing-name';
      name.textContent = ing.name;
      li.append(amount, name);
      list.appendChild(li);
    });
  } else {
    const li = document.createElement('li');
    li.className = 'recipe-print-empty';
    li.textContent = 'Keine Zutaten hinterlegt.';
    list.appendChild(li);
  }
  cell.appendChild(list);

  const instrHeading = document.createElement('h3');
  instrHeading.className = 'recipe-print-heading';
  instrHeading.textContent = 'Zubereitung';
  cell.appendChild(instrHeading);

  const instrWrap = document.createElement('div');
  instrWrap.className = 'recipe-print-instructions';
  // Ein Absatz pro (Gruppe von) Zeilenumbruch(en) -- gleiche Grundannahme wie die Freitext-
  // Darstellung anderswo in der App (z. B. .msd-instructions{white-space:pre-line}), hier aber
  // als echte <p>-Elemente, weil genau DAS die Voraussetzung fuer break-inside:avoid pro Absatz
  // ist (D3 im Plan) -- ein einzelner vorformatierter Textblock liesse sich nicht absatzweise vor
  // dem Durchschneiden schuetzen.
  const paragraphs = (recipe.instructions || '').split(/\n+/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length) {
    paragraphs.forEach(text => {
      const p = document.createElement('p');
      p.textContent = text;
      instrWrap.appendChild(p);
    });
  } else {
    const p = document.createElement('p');
    p.className = 'recipe-print-empty';
    p.textContent = 'Keine Zubereitung hinterlegt.';
    instrWrap.appendChild(p);
  }
  cell.appendChild(instrWrap);

  row.appendChild(cell);
  tbody.appendChild(row);
  table.appendChild(tbody);
  body.appendChild(table);
}

// recipeSummary: Eintrag aus state.recipes (nur Uebersichtsfelder) -- Volldaten
// (instructions/ingredients) fehlen dort bewusst (siehe Kommentar bei openRecipeForm()) und
// werden hier ueber denselben bestehenden Endpunkt (GET /api/recipes/:id) nachgeladen, mit
// demselben Fehlerbehandlungsmuster (flash() statt stillem Fehlschlag bei Netzwerkfehlern).
//
// NACHTRAG (Nutzer-Test mit langem Testrezept, ID 8): #recipePrint war urspruenglich ein
// natives <dialog> (showModal()/close()) -- die Druckvorschau zeigte dabei aber zuverlaessig nur
// EINE Seite, der Rest des langen Rezepts fehlte komplett. Ursache (Nachtest bestaetigt, siehe
// scratchpad/ap2.2-dialog-vs-flow-print-pagination-test.html): <dialog> rendert im Browser-
// "Top Layer" (eigene Ebene ausserhalb des Dokumentflusses) -- solche Elemente werden beim
// Drucken auf eine Seite begrenzt behandelt, unabhaengig von CSS wie max-height/overflow. Jetzt
// stattdessen ein normales <div> im Dokumentfluss (Designentscheidung D2 im Plan nennt diese
// Alternative explizit), nur ueber die Klasse "open" sichtbar geschaltet -- deshalb hier
// classList.add() statt showModal(), und ein manuelles closeRecipePrint() statt des nativen
// dialog.close() (ein <div> hat keine close()-Methode).
async function openRecipePrint(recipeSummary) {
  let recipe = null;
  try { recipe = (await api('GET', `/api/recipes/${recipeSummary.id}`)).recipe; }
  catch (err) { flash(err.message); return; }

  buildRecipePrintContent(recipe);
  $('#recipePrint').classList.add('open');
}

function closeRecipePrint() {
  $('#recipePrint').classList.remove('open');
}

async function submitRecipeForm(e) {
  e.preventDefault();
  showRecipeFormError('');

  // Clientseitige Validierung zusaetzlich zur serverseitigen (validateRecipeInput() in
  // server.js) -- gleiche Regeln (F3: Pflichtfeld, ganzzahlig, 1-20), damit ein Tippfehler
  // sofort auffaellt statt erst nach einem Roundtrip.
  const title = $('#rfTitleInput').value.trim();
  if (!title) { showRecipeFormError('Titel darf nicht leer sein.'); return; }
  const servings = Number($('#rfServings').value);
  if (!Number.isInteger(servings) || servings < 1 || servings > 20) {
    showRecipeFormError('Personenzahl muss eine ganze Zahl zwischen 1 und 20 sein.');
    return;
  }
  const file = $('#rfImage').files[0];
  if (file && file.size > RECIPE_LIMITS.imageMaxBytes) {
    showRecipeFormError(`Bild ist zu groß (maximal ${RECIPE_LIMITS.imageMaxBytes / (1024 * 1024)} MB).`);
    return;
  }

  const id = $('#rfId').value;
  const fd = new FormData();
  fd.append('title', title);
  fd.append('baseServings', String(servings));
  fd.append('instructions', $('#rfInstructions').value);
  fd.append('ingredients', JSON.stringify(collectIngredientsFromForm()));
  if (file) fd.append('image', file);
  else if (id && $('#rfRemoveImage').checked) fd.append('removeImage', 'true');

  $('#rfSubmit').disabled = true;
  try {
    if (id) await apiForm('PUT', `/api/recipes/${id}`, fd);
    else await apiForm('POST', '/api/recipes', fd);
    $('#recipeForm').close();
    await loadRecipes();
  } catch (err) {
    showRecipeFormError(err.message);
  } finally {
    $('#rfSubmit').disabled = false;
  }
}

/* ---------------- AP3.2 (erweitert um AP2.2: vierter Menuepunkt "Rezeptkarten"): Umschalten
   zwischen den Ansichten im neuen Linksmenue (bzw. der daraus umgeklappten unteren Tab-Leiste auf
   schmalen Bildschirmen). Reiner Sichtbarkeits-umschalter (wie im freigegebenen Klick-Mockup) --
   keine eigene Datenhaltung, kein Routing;
   .app-view/.nav-btn.active kommen aus style-v2.css. Bewusst getrennt von setView() (das
   schaltet innerhalb der Wochenuebersicht zwischen Wochen-/Tagesansicht um und bleibt als
   eigener Modus erhalten, siehe Datei-Kopfkommentar/Rueckmeldung). */
function setSection(section) {
  document.querySelectorAll('.app-nav .nav-btn').forEach(btn => {
    const active = btn.dataset.view === section;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  document.querySelectorAll('.app-view').forEach(view => {
    view.classList.toggle('active', view.id === 'view-' + section);
  });
  // Piktogramm-Palette (Werkzeugleiste + mobiler "Symbole"-Button) bezieht sich ausschliesslich
  // auf den Hauptraster; ausserhalb der Wochenuebersicht blenden wir sie ueber diese body-Klasse
  // aus (Sichtbarkeitsregeln siehe style.css, nahe .palette-wrap/.only-day).
  document.body.classList.toggle('section-wochenuebersicht', section === 'wochenuebersicht');
  // AP7.1: haelt die jeweils aktive Seite zusaetzlich als data-Attribut fest (statt nur als
  // Boolean fuer "wochenuebersicht ja/nein") -- ermoeglicht body[data-section="rezepte"]-Selektoren
  // in style.css fuer Kopfzeilen-Elemente, die auf MEHREREN, aber nicht allen vier Seiten sichtbar
  // sein sollen (".week-only", siehe dort), ohne fuer jede Seite eine eigene boolesche Klasse
  // einfuehren zu muessen.
  document.body.dataset.section = section;
}

/* ---------------- Daten aus dem DOM zurueckschreiben ---------------- */
function syncFromDOM() {
  const root = activeContainer();
  root.querySelectorAll('[data-cell]').forEach(el => {
    const [ri, di] = el.getAttribute('data-cell').split(',').map(Number);
    if (state.data.rows[ri]) state.data.rows[ri].cells[di] = cellToTokens(el);
  });
  root.querySelectorAll('[data-label]').forEach(el => {
    const ri = Number(el.getAttribute('data-label'));
    if (state.data.rows[ri]) state.data.rows[ri].label = el.textContent.trim().slice(0, 80);
  });
  root.querySelectorAll('[data-role]').forEach(el => {
    const ri = Number(el.getAttribute('data-role'));
    if (state.data.rows[ri]) state.data.rows[ri].role = el.textContent.trim().slice(0, 80);
  });
  const motto = root.querySelector('[data-bind="motto"]');
  if (motto) state.data.motto = cellToTokens(motto);
  const notes = root.querySelector('[data-bind="notes"]');
  if (notes) state.data.notes = cellToTokens(notes);
  // AP1.2: Essensplan-Zellen sind seit dem Zell-Klick-Dialog nicht mehr contentEditable (siehe
  // buildMealCellDisplay()) -- es gibt daher kein "[data-mealcell]" mehr, ueber das hier aus dem
  // DOM zurueckgeschrieben werden muesste. Schreibzugriffe laufen jetzt ausschliesslich direkt auf
  // state.data (Wizard-Funktionen unten, seit der AP1-Korrektur auch fuer Rezept-Zuweisungen),
  // jeweils gefolgt von markDirty() -- dieselbe Debounce-/Speicherkette wie ueberall sonst, nur
  // ohne den Umweg ueber DOM-Scraping. Frueher stand hier eine eigene ".mp-cell[data-mealcell]"-
  // Sync-Schleife (siehe Git-Historie vor AP1.2), die mit dem Wegfall der contentEditable-Zellen
  // gegenstandslos geworden ist.
}

/* ---------------- Speichern ---------------- */
let saveTimer = null;
function setStatus(text, cls) { const el = $('#status'); el.textContent = text; el.className = 'status ' + (cls || ''); }
function markDirty() { state.dirty = true; setStatus('Nicht gespeichert', 'saving'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 1000); }
function flash(text) { const b = $('#banner'); b.textContent = text; b.classList.add('show'); setTimeout(() => b.classList.remove('show'), 5000); }

async function save() {
  clearTimeout(saveTimer);
  if (state.saving || !state.data) return;
  syncFromDOM();
  state.saving = true;
  setStatus('Speichert …', 'saving');
  try {
    const body = await buildWeekSaveBody(state.data, state.updatedAt);
    const res = await api('PUT', `/api/weeks/${state.weekStart}`, body);
    state.updatedAt = res.updatedAt;
    state.dirty = false;
    setStatus('Gespeichert ' + new Date(res.updatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), 'saved');
    refreshArchive();
  } catch (err) {
    if (err.status === 409) {
      const decoded = await decodeWeekResponse(err.payload);
      state.data = decoded.data;
      state.weekEncrypted = decoded.mustEncryptOnSave;
      // Fokusbloecke (Datenmodell-Fokusbloecke-v2.md): siehe Kommentar in loadWeek() -- derselbe
      // Fallback fuer den Fall, dass die zwischenzeitlich vom anderen Geraet gespeicherte Woche
      // (noch) keine dieser Felder kennt.
      state.data.goals = state.data.goals || [];
      state.data.highlights = state.data.highlights || [];
      state.data.calls = state.data.calls || [];
      state.updatedAt = err.payload.updatedAt;
      state.dirty = false;
      renderAll();
      setStatus('Neu geladen', 'saved');
      flash('Diese Woche wurde zwischenzeitlich auf einem anderen Gerät geändert. Der aktuelle Stand vom Server ist jetzt zu sehen.');
    } else {
      setStatus('Nicht gespeichert', 'error');
      flash('Speichern fehlgeschlagen: ' + err.message);
    }
  } finally { state.saving = false; }
}

/* ---------------- Woche laden ---------------- */
async function loadWeek(iso) {
  if (state.dirty) await save();
  const res = await api('GET', `/api/weeks/${iso}`);
  state.weekStart = res.weekStart;
  // AP2.1: entschluesselt bei Bedarf lokal (res.encrypted) und merkt sich, ob diese Woche beim
  // naechsten Speichern verschluesselt werden muss (siehe decodeWeekResponse()/save()).
  const decoded = await decodeWeekResponse(res);
  state.data = decoded.data;
  state.weekEncrypted = decoded.mustEncryptOnSave;
  // Fokusbloecke (Datenmodell-Fokusbloecke-v2.md): sehr alte, vor diesem Feature gespeicherte
  // Wochen kennen diese drei Felder eventuell noch nicht -- analog zum bestehenden Fallback in
  // importJSON() ("d.goals || []" etc.) hier ebenfalls robust gegen fehlende Schluessel
  // absichern, damit renderFocusBlocks() nicht auf "undefined" trifft.
  state.data.goals = state.data.goals || [];
  state.data.highlights = state.data.highlights || [];
  state.data.calls = state.data.calls || [];
  state.updatedAt = res.updatedAt;
  state.dirty = false;
  renderAll();
  setStatus(res.exists
    ? 'Gespeichert ' + new Date(res.updatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : (res.fromTemplate ? 'Neue Woche aus Vorlage' : 'Neue Woche'), res.exists ? 'saved' : '');
  $('#archive').value = '';
  // AP2 (projects/wochenplaner-design-nacharbeiten/plan.md): Read-only-Vorschau der FOLGENDEN
  // Woche neu laden, sobald sich die geladene Woche aendert (Navigation/Archiv/heute-Button) --
  // bewusst NACH renderAll() oben, damit die primaere Wochenansicht nicht auf den zusaetzlichen
  // Request wartet.
  await loadNextWeekPreview();
}

async function refreshArchive() {
  try {
    const { weeks } = await api('GET', '/api/weeks');
    const sel = $('#archive');
    sel.textContent = '';
    const opt0 = document.createElement('option');
    opt0.value = ''; opt0.textContent = `Archiv (${weeks.length}) …`;
    sel.appendChild(opt0);
    weeks.forEach(w => {
      const d = parseISO(w.weekStart);
      const o = document.createElement('option');
      o.value = w.weekStart;
      o.textContent = `KW ${isoWeek(d)} · ab ${d.toLocaleDateString('de-DE')}`;
      sel.appendChild(o);
    });
  } catch { /* Archiv ist nicht kritisch */ }
}

/* ---------------- Vorlage ---------------- */
async function applyTemplate() {
  const tRes = await api('GET', '/api/template');
  // AP2.1: households.template_data traegt bei einem verschluesselten Haushalt denselben
  // Ciphertext-Envelope wie eine verschluesselte Woche (server.js, isEncryptedTemplateEnvelope())
  // -- lokal entschluesseln, statt (wie bislang) direkt "template" aus der Antwort zu lesen.
  const template = tRes.encrypted
    ? await WPCrypto.decryptJSON(WPCrypto.getHouseholdKey(), tRes.nonce, tRes.ciphertext)
    : tRes.template;
  if (!template) { flash('Es ist noch keine Vorlage hinterlegt. Lege eine typische Woche an und sichere sie über „Als Vorlage sichern“.'); return; }
  syncFromDOM();
  // Namen (kind+label) bereits vorhandener Zeilen merken: eine Vorlage mit weniger oder
  // anders sortierten Zeilen als die aktuelle Woche (z. B. weil vor "Als Vorlage sichern"
  // eine Zeile geloescht wurde) darf beim Auffuellen fehlender Positionen keine Zeile
  // duplizieren, die unter einem anderen Index schon existiert.
  const rowKey = r => (r.kind || '') + '|' + String(r.label || '').trim().toLowerCase();
  const existingKeys = new Set(state.data.rows.map(rowKey));
  template.rows.forEach((trow, i) => {
    const row = state.data.rows[i];
    if (!row) {
      const key = rowKey(trow);
      if (trow.label && existingKeys.has(key)) return; // schon vorhanden, nicht doppelt einfuegen
      state.data.rows[i] = structuredClone(trow);
      existingKeys.add(key);
      return;
    }
    if (!row.label) row.label = trow.label;
    if (!row.role) row.role = trow.role;
    // "cells" deckt sowohl normale Zeilen (Token[] je Tag) als auch Listen-Zeilen mit
    // listMode (ListItem[] je Tag) ab — beide sind Arrays, die Zusammenfuehrung ist fuer
    // beide Formen gleich. Zeilen mit mode:'week' haben stattdessen "meals" statt "cells".
    if (Array.isArray(trow.cells) && Array.isArray(row.cells)) {
      trow.cells.forEach((cell, d) => { if (cell.length && isEmpty(row.cells[d])) row.cells[d] = structuredClone(cell); });
    } else if (Array.isArray(trow.meals) && Array.isArray(row.meals)) {
      trow.meals.forEach((tmeal, mi) => {
        const meal = row.meals[mi];
        if (!meal) return;
        tmeal.cells.forEach((cell, d) => { if (cell.length && isEmpty(meal.cells[d])) meal.cells[d] = structuredClone(cell); });
      });
    }
  });
  // Etwaige Luecken im Array (siehe mergeTemplate()-Kommentar in server.js fuer denselben
  // Mechanismus) sauber entfernen, bevor gerendert/gespeichert wird.
  state.data.rows = state.data.rows.filter(Boolean);
  renderAll();
  markDirty();
  flash('Vorlage eingefügt – vorhandene Einträge wurden nicht überschrieben.');
}
async function saveTemplate() {
  syncFromDOM();
  // AP2.1: dieselbe Verschluesselungsentscheidung wie fuer die gerade geladene Woche
  // (state.weekEncrypted, siehe loadWeek()/buildWeekSaveBody()) -- eine Vorlage ist inhaltlich
  // nichts anderes als eine Wochen-Schablone und unterliegt denselben Regeln.
  if (state.weekEncrypted) {
    const { nonce, ciphertext } = await WPCrypto.encryptJSON(WPCrypto.getHouseholdKey(), state.data);
    await api('PUT', '/api/template', { encrypted: true, keyVersion: state.crypto?.keyVersion || 1, nonce, ciphertext });
  } else {
    await api('PUT', '/api/template', { data: state.data });
  }
  flash('Diese Woche ist jetzt die Vorlage für neue Wochen.');
}

/* ---------------- Import / Export ---------------- */
function exportJSON() {
  syncFromDOM();
  const blob = new Blob([JSON.stringify({ version: 2, weekStart: state.weekStart, ...state.data }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wochenplan_${state.weekStart}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// Muss exakt zum serverseitigen ICON_RE in server.js passen (zweite Absicherung
// zusaetzlich zur inerten Parsing-Strategie unten).
const ICON_ID_RE = /^i-[a-z0-9-]{2,30}$/;

function htmlToTokens(html) {
  // Sicherheitsrelevant: HTML aus importierten Dateien (Legacy-Einzeldatei-Format)
  // ist nicht vertrauenswuerdig. Statt es per innerHTML in ein (wenn auch nicht
  // angehaengtes) Live-Element einzufuegen, wird es hier ueber DOMParser geparst.
  // Ein per DOMParser erzeugtes Document hat keinen Browsing-Context: Bilder/
  // Ressourcen werden nicht geladen und Event-Handler (onerror, onload etc.)
  // werden nicht ausgefuehrt. Damit haengt die Sicherheit nicht mehr implizit
  // von der CSP ab, sondern ist strukturell ausgeschlossen.
  const root = new DOMParser().parseFromString(String(html || ''), 'text/html').body;
  root.querySelectorAll('span.ic').forEach(sp => {
    const use = sp.querySelector('use');
    const id = (use?.getAttribute('href') || '').replace('#', '');
    // Nur bekannte, dem serverseitigen Muster entsprechende Icon-IDs uebernehmen.
    if (id && ICON_ID_RE.test(id)) { sp.dataset.icon = id; sp.dataset.label = ICON_LABEL[id] || ''; }
    else sp.remove();
  });
  return cellToTokens(root);
}
function importJSON(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (d.version === 2 && Array.isArray(d.rows)) {
        state.data = {
          version: 2, motto: d.motto || [], notes: d.notes || [],
          // Fokusbloecke (Datenmodell-Fokusbloecke-v2.md): in aelteren Export-Dateien noch
          // nicht vorhanden, daher wie motto/notes mit leerem Array abgesichert.
          goals: d.goals || [], highlights: d.highlights || [], calls: d.calls || [],
          rows: d.rows
        };
      } else if (Array.isArray(d.rows)) {                       // Format der Einzeldatei-Version
        state.data = {
          version: 2,
          motto: htmlToTokens(d.motto),
          notes: htmlToTokens(d.notes),
          // Fokusbloecke existierten im alten Einzeldatei-Format noch nicht.
          goals: [], highlights: [], calls: [],
          rows: d.rows.map(row => {
            const person = String(row.kind || '').includes('person');
            const html = row.html || [];
            const offset = person ? 2 : 1;
            return {
              kind: person ? 'person' : 'shared',
              label: htmlToTokens(html[0]).map(t => t.t === 'text' ? t.v : '').join('').trim(),
              role: person ? htmlToTokens(html[1]).map(t => t.t === 'text' ? t.v : '').join('').trim() : '',
              cells: Array.from({ length: 7 }, (_, i) => htmlToTokens(html[offset + i]))
            };
          })
        };
      } else throw new Error('unbekannt');
      renderAll();
      markDirty();
      flash('Datei übernommen – die Woche wird gespeichert.');
    } catch { flash('Diese Datei konnte nicht gelesen werden.'); }
  };
  r.readAsText(file);
}

/* ---------------- Mini-Piktogramm-Palette (Tagesliste/Essensplan) ----------------
   Nutzt dieselbe Einfuegefunktion wie die grosse Palette im Werkzeugkasten (insertIcon(),
   ueber die global verfolgte lastCell/lastRange), nur mit einer auf den Kontext begrenzten
   Icon-Auswahl statt aller 27 Piktogramme. */
function buildMiniPalette(iconIds) {
  const pal = document.createElement('div');
  pal.className = 'mini-pal';
  iconIds.forEach(id => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mini-pal-btn'; b.title = (ICON_LABEL[id] || id) + ' einfügen';
    b.appendChild(iconSvg(id));
    b.addEventListener('mousedown', e => e.preventDefault()); // Fokus im Editierfeld behalten, wie bei der grossen Palette
    b.addEventListener('click', () => insertIcon(id, ICON_LABEL[id] || id));
    pal.appendChild(b);
  });
  return pal;
}
/* Editierfeld mit Mini-Palette zum Hinzufuegen eines neuen Listeneintrags. Nutzt dieselbe
   .cell-Logik (contentEditable, Tokens) wie das Hauptraster; Klasse "autobreak" sorgt dafuer,
   dass ein eingefuegtes Piktogramm automatisch einen Zeilenumbruch danach ausloest. */
function buildComposer(iconIds, onAdd) {
  const wrap = document.createElement('div');
  wrap.className = 'composer';
  wrap.appendChild(buildMiniPalette(iconIds));
  const editable = editableCell([], { 'data-ph': 'Neuer Eintrag … (Piktogramm einfügen, dann tippen)' }, 'autobreak');
  wrap.appendChild(editable);
  const actions = document.createElement('div');
  actions.className = 'composer-actions';
  const addBtn = document.createElement('button');
  addBtn.type = 'button'; addBtn.className = 'add-btn'; addBtn.textContent = '+ Hinzufügen';
  const doAdd = () => {
    const tokens = cellToTokens(editable);
    if (!tokens.length) return;
    onAdd(tokens);
    editable.textContent = '';
  };
  addBtn.addEventListener('click', doAdd);
  editable.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAdd(); } });
  actions.appendChild(addBtn);
  wrap.appendChild(actions);
  return wrap;
}
function renderItemsList(items, onRemove) {
  const ul = document.createElement('ul');
  ul.className = 'dl-items';
  if (!items.length) {
    const p = document.createElement('div');
    p.className = 'dl-empty';
    p.textContent = 'Noch keine Einträge.';
    ul.appendChild(p);
  }
  items.forEach((it, ii) => {
    const li = document.createElement('li');
    li.className = 'dl-item' + (it.done ? ' done' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!it.done;
    cb.addEventListener('change', () => { it.done = cb.checked; li.classList.toggle('done', it.done); markDirty(); });
    const span = document.createElement('span');
    span.className = 'txt';
    span.appendChild(tokensToFragment(it.tokens));
    const rm = document.createElement('button');
    rm.className = 'rm'; rm.type = 'button'; rm.title = 'Eintrag entfernen'; rm.textContent = '×';
    rm.addEventListener('click', () => onRemove(ii));
    li.append(cb, span, rm);
    ul.appendChild(li);
  });
  return ul;
}

/* ---------------- Tagesliste: eigenstaendige, druckbare Ansicht fuer GENAU EINE Zeile
   (aktuell "Einkauf & Besorgungen") an GENAU EINEM Tag. Eintraege sind Checklisten-Zeilen
   (ListItem: {done, tokens}), nicht in der Zelle selbst editierbar — nur Abhaken, Entfernen
   und Hinzufuegen ueber den Composer, analog zum freigegebenen Mockup. ---------------- */
let openListRow = null;
let openListDay = null;

function openDayList(rowIndex, dayIndex) {
  syncFromDOM();
  openListRow = rowIndex;
  openListDay = dayIndex;
  const row = state.data.rows[rowIndex];
  const d = parseISO(state.weekStart); d.setDate(d.getDate() + dayIndex);
  $('#dlTitle').textContent = row.label;
  $('#dlSub').textContent =
    DAYS[dayIndex] + ', ' + d.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' }) +
    (dayIndex === todayColumnIndex() ? ' · heute' : '');
  renderDayListBody();
  document.getElementById('daylist').showModal();
}
// AP2.1: schliesst ueber die native dialog.close() -- das "close"-Ereignis (siehe boot(),
// dort einmalig registriert) uebernimmt das Neuzeichnen fuer ALLE Schliesswege gleichermassen
// (Schliessen-Button, ESC-Taste, Klick auf den Backdrop), nicht nur den Button-Klick.
function closeDayList() {
  document.getElementById('daylist').close();
}
function renderDayListBody() {
  const wrap = $('#dlBody');
  wrap.textContent = '';
  const row = state.data.rows[openListRow];
  const section = document.createElement('div');
  section.className = 'dl-section';
  const items = row.cells[openListDay] || [];
  section.appendChild(renderItemsList(items, ii => { items.splice(ii, 1); markDirty(); renderDayListBody(); }));
  section.appendChild(buildComposer(['i-einkauf', 'i-wichtig'], tokens => {
    items.push({ done: false, tokens });
    row.cells[openListDay] = items;
    markDirty();
    renderDayListBody();
  }));
  wrap.appendChild(section);
}

/* ---------------- Essensplan: eigenstaendige, druckbare Ansicht fuer die GANZE WOCHE
   ("Essen & Kochen") als Tabelle Mahlzeiten x Tage — eine Zeile im Hauptraster, ein Link,
   eine Tabelle statt sieben getrennter Tageslinks. Zellen sind direkt beschreibbare
   Token-Felder wie im Hauptraster (kein Checkbox-Konzept, Mahlzeiten werden nicht
   abgehakt). ---------------- */
// AP1.1 (projects/wochenplaner-design-nacharbeiten/plan.md): "Essen & Kochen" ist jetzt eine
// PERMANENTE Ansicht -- ersetzt das vorherige openMealPlan()/closeMealPlan()-Paar (kein Button/
// #mealplan-<dialog>-Umweg mehr). renderMealPlanEntry() ist der Einstiegspunkt, den renderAll()
// bereits vorher kannte (frueher fuer die kleine Einstiegskarte, jetzt fuer die vollstaendige
// Tabelle inkl. KW-Unterzeile) -- kein neuer Aufruf-/Renderpfad noetig, nur ein neuer Inhalt.
function renderMealPlanEntry() {
  const sub = $('#mpSub');
  if (sub) {
    const mon = parseISO(state.weekStart);
    const sun = parseISO(state.weekStart); sun.setDate(sun.getDate() + 6);
    sub.textContent =
      'KW ' + isoWeek(mon) + ' · ' +
      mon.toLocaleDateString('de-DE', { day: '2-digit', month: 'long' }) + ' – ' +
      sun.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  }
  renderMealPlanHead();
  renderMealPlanBody();
  renderMealDayNav();
}
function renderMealPlanHead() {
  const headRow = $('#mpHeadRow');
  headRow.querySelectorAll('th:not(.corner)').forEach(th => th.remove());
  const todayIdx = todayColumnIndex();
  DAYS.forEach((name, i) => {
    const d = parseISO(state.weekStart); d.setDate(d.getDate() + i);
    const th = document.createElement('th');
    th.dataset.day = String(i); // AP1.1: Mobile-Tagesumschalter blendet darueber alle Spalten bis auf state.mealDay aus (siehe style.css)
    if (i === todayIdx) th.classList.add('today');
    th.innerHTML = `<span class="dw"></span><span class="dt"></span>`;
    th.querySelector('.dw').textContent = name;
    th.querySelector('.dt').textContent = fmtShort(d);
    if (i === todayIdx) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Heute';
      th.appendChild(badge);
    }
    headRow.appendChild(th);
  });
}
// AP1.1: Mobile-Tagesumschalter fuer die jetzt permanente Essensplan-Tabelle, im Erscheinungsbild
// bewusst analog #daynav/renderDay() (Hauptraster) -- baut denselben Tages-Pillenstreifen (gleiche
// .daynav-Klasse), steuert aber (anders als dort) KEINE zweite Ansicht/DOM-Kopie, sondern nur eine
// CSS-Spaltenausblendung auf DERSELBEN Tabelle (#mpTable[data-active-day], siehe style.css) -- eine
// echte zweite DOM-Kopie der Zellen wuerde syncFromDOM() dieselbe [mi,di]-Zelle doppelt vorfinden
// (Kollisionsrisiko, siehe Rueckmeldung an ANORAK/JOHNSON zur Konzept-Diskussion). Kein
// syncFromDOM()-Aufruf vor dem Tageswechsel noetig (anders als renderDay()): die Zellen selbst
// werden beim Wechsel nicht neu aufgebaut, nur ein-/ausgeblendet -- ein gerade in Bearbeitung
// befindlicher Zelleninhalt eines anderen Tages geht dabei nicht verloren.
function renderMealDayNav() {
  const nav = $('#mpDayNav');
  if (!nav) return;
  nav.textContent = '';
  const todayIdx = todayColumnIndex();
  DAYS.forEach((name, i) => {
    const d = parseISO(state.weekStart); d.setDate(d.getDate() + i);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-current', String(i === state.mealDay));
    if (i === todayIdx) b.classList.add('today');
    b.innerHTML = '<span></span><small></small>';
    b.querySelector('span').textContent = DAYS_S[i];
    b.querySelector('small').textContent = fmtShort(d);
    b.onclick = () => { state.mealDay = i; renderMealDayNav(); };
    nav.appendChild(b);
  });
  nav.children[state.mealDay]?.scrollIntoView({ inline: 'center', block: 'nearest' });
  const table = $('#mpTable');
  if (table) table.dataset.activeDay = String(state.mealDay);
}
// AP1-Korrektur (Nutzer-Feedback nach dem ersten AP1-Browsertest, projects/wochenplaner-design-
// nacharbeiten/plan.md): buildRecipeAssignToken() (die vormals volle Inline-Anzeige einer
// Rezept-Zuweisung mit Mengen-/Einheit-Eingabefeldern und Einkaufslisten-Checkboxen DIREKT in der
// Zelle) ist ersatzlos entfernt -- genau das widersprach dem eigentlichen Plan-Ziel "Essensplan-
// Zellen sind grundsaetzlich kompakt/druckbar" (siehe AP1.4-Kommentar unten, Git-Historie fuer den
// vollstaendigen alten Code). Zugewiesene Rezepte zeigen jetzt nur noch Name+Personenzahl
// (buildMealSlotRecipeDisplay() weiter unten) -- Mengen-Nachbearbeitung und Einkaufslisten-
// Uebernahme laufen seither ausschliesslich ueber den Zell-Klick-Dialog (openMealSlotRecipeCell()),
// konsistent mit allen anderen Zelltypen. Das damit ebenfalls obsolet gewordene Einzel-Zutat-
// Tag-Auswahl-Dialog-Paar (openIngredientToListDialog()/submitIngredientToList()/
// #ingredientToListDialog, AP4.2) ist aus demselben Grund mit entfernt -- der Wizard-eigene
// Einkaufstag-Schritt (submitMealSlotShopDate(), AP1.2/AP0) deckt denselben Bedarf bereits ab,
// batch-faehig und mit Wochenwechsel-Unterstuetzung.

// AP1.2 (projects/wochenplaner-design-nacharbeiten/plan.md): Anzeige einer Essensplan-Zelle OHNE
// Rezept-Zuweisung -- ersetzt die bisherige contentEditable-Zelle (editableCell()) durch eine rein
// lesende Anzeige (Text/Piktogramm werden weiterhin ueber tokensToFragment() dargestellt, exakt
// dasselbe Rendering wie ueberall sonst) + Klick-/Tastatur-Handler, der den Zell-Klick-Dialog
// oeffnet. Wiederverwendet dieselbe ".cell"/"data-ph"-Platzhalter-Mechanik wie editableCell()
// (siehe CSS-Regel ".cell:empty::before" in style.css) -- eine leere Zelle bleibt technisch leer
// (kein Kindknoten), der Platzhalter "–" kommt weiterhin rein aus CSS, kein neuer Mechanismus
// noetig. tabIndex/role=button/Enter-Space-Handler: eine contentEditable-Zelle war von sich aus
// per Tastatur erreichbar, ein reiner Klick-Handler auf einem <div> waere das ohne diese Ergaenzung
// NICHT (Barrierefreiheits-Regression, die dieser Umbau sonst einfuehren wuerde).
function buildMealCellDisplay(meal, mi, d) {
  const div = document.createElement('div');
  div.className = 'cell mp-cell mp-cell-slot';
  div.tabIndex = 0;
  div.setAttribute('role', 'button');
  div.dataset.ph = '–';
  const tokens = meal.cells[d] || [];
  div.appendChild(tokensToFragment(tokens));
  const summary = tokensText(tokens).trim();
  div.setAttribute('aria-label', summary
    ? `${meal.label}, ${DAYS[d]}: ${summary} — antippen zum Ändern`
    : `${meal.label}, ${DAYS[d]}: nicht geplant — antippen zum Eintragen`);
  div.addEventListener('click', () => openMealSlotDialog(meal, mi, d));
  div.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMealSlotDialog(meal, mi, d); }
  });
  return div;
}

// AP1-Korrektur (siehe Kommentar oben): kompakte Anzeige einer Rezept-Zuweisung -- nur Name +
// Personenzahl, druckfreundlich, gleiches Klick-/Tastatur-/Hover-Verhalten wie buildMealCellDisplay()
// (dieselbe .mp-cell-slot-Klasse, dieselbe CSS-Hover-/Fokus-Regel). Mengen-Nachbearbeitung/
// Einkaufslisten-Uebernahme laufen ueber openMealSlotRecipeCell() (Zell-Klick-Dialog, direkt im
// Rezept-Bearbeitungsschritt vorbefuellt).
function buildMealSlotRecipeDisplay(meal, mi, d, recipeTok) {
  const div = document.createElement('div');
  div.className = 'cell mp-cell mp-cell-slot mp-cell-recipe-compact';
  div.tabIndex = 0;
  div.setAttribute('role', 'button');
  const title = document.createElement('span');
  title.className = 'mp-recipe-compact-title';
  title.textContent = recipeTok.recipeTitle;
  const servingsLabel = `${recipeTok.servings} ${recipeTok.servings === 1 ? 'Person' : 'Personen'}`;
  const servings = document.createElement('span');
  servings.className = 'mp-recipe-compact-servings';
  servings.textContent = servingsLabel;
  div.append(title, servings);
  div.setAttribute('aria-label', `${meal.label}, ${DAYS[d]}: ${recipeTok.recipeTitle}, ${servingsLabel} — antippen zum Bearbeiten`);
  div.addEventListener('click', () => openMealSlotRecipeCell(meal, mi, d, recipeTok));
  div.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMealSlotRecipeCell(meal, mi, d, recipeTok); }
  });
  return div;
}

function renderMealPlanBody() {
  const row = state.data.rows.find(r => r.mode === 'week');
  const tbody = $('#mpTableBody');
  tbody.textContent = '';
  if (!row) return;
  const todayIdx = todayColumnIndex();
  row.meals.forEach((meal, mi) => {
    const tr = document.createElement('tr');
    tr.className = 'mealrow';
    const tdLbl = document.createElement('td');
    tdLbl.className = 'lbl';
    tdLbl.textContent = meal.label;
    tr.appendChild(tdLbl);
    for (let d = 0; d < 7; d++) {
      const td = document.createElement('td');
      td.dataset.day = String(d); // AP1.1: siehe renderMealPlanHead() -- Mobile-Tagesumschalter
      if (d === todayIdx) td.classList.add('today');
      // Alle Zellen sind seit dem Zell-Klick-Dialog (AP1.2) sowie der AP1-Korrektur fuer
      // Rezept-Zellen (siehe buildMealSlotRecipeDisplay()) rein lesende, kompakte Anzeigen --
      // Bearbeitung laeuft ausschliesslich ueber den Dialog (openMealSlotDialog()/
      // openMealSlotRecipeCell()), nie mehr direkt per Tippen in der Zelle.
      const recipeTok = (meal.cells[d] || []).find(t => t && t.t === 'recipe');
      if (recipeTok) {
        td.classList.add('mp-cell-recipe');
        td.appendChild(buildMealSlotRecipeDisplay(meal, mi, d, recipeTok));
      } else {
        td.appendChild(buildMealCellDisplay(meal, mi, d));
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
}
function initMealPlanToolbar() {
  $('#mealplanToolbar').appendChild(buildMiniPalette(['i-kochen', 'i-essen']));
}

/* ================= AP2 (projects/wochenplaner-design-nacharbeiten/plan.md, Stufe 1+2): Read-only-
   Vorschau + gezielt editierbare "Essen & Kochen"-Zeile der auf state.weekStart FOLGENDEN Woche
   (#nextWeekPanel). Bewusst KEIN VOLLER state.data/dirty/saving/view-Zyklus fuer diese zweite Woche
   (MORROWs Kernempfehlung) -- nur die "mode:'week'"-Zeile wird lokal gehalten (nextWeekMeal).
   Schreibzugriffe laufen fuer PLAINTEXT-Haushalte weiterhin ueber die gezielten Endpunkte assign-
   recipe/set-meal-cell (beide mit targetWeekStart, server.js), siehe applyMealSlotTokens()/
   submitMealSlotRecipe() weiter unten.
   AP2.2-Ergaenzung: diese Endpunkte lehnen fuer AKTIVE (verschluesselte) Haushalte serverseitig ab
   (der Server kann weeks.data nicht mehr lesen/aendern) -- fuer diesen Fall haelt
   loadNextWeekPreview() zusaetzlich die VOLLE entschluesselte Vorschau-Woche (nextWeekData) plus
   deren updatedAt (nextWeekUpdatedAt), damit ein "Zelle aendern"-Vorgang die komplette Woche lokal
   neu verschluesseln und per PUT /api/weeks/:monday zurueckschreiben kann (siehe
   assignRecipeClientSide()/loadWeekDataFor()/saveWeekDataFor() weiter unten) -- exakt das von
   MORROW beschriebene "Client liest die ganze Woche, aendert lokal die eine Zelle, schickt die
   komplette neu verschluesselte Woche zurueck"-Muster (ap1.2-datenmodell.md Abschnitt 6.3).
   Eigener Mobile-Tagesumschalter (nextWeekDay/#nextWeekDayNav) komplett unabhaengig von
   state.mealDay/#mpDayNav, damit ein Wechsel des Vorschau-Tages die aktuelle Wochenansicht nicht
   beeinflusst (und umgekehrt) -- dieselbe CSS-Spaltenausblendung wie bei #mpTable, jetzt ueber die
   geteilte Klasse ".mobile-day-table" (siehe style.css). ================= */
let nextWeekStart = null; // ISO-Datum (Montag) der Vorschau-Woche, == addDays(state.weekStart, 7)
let nextWeekMeal = null; // die "mode:'week'"-Zeile der Vorschau-Woche (row.meals[...]) oder null
// AP2.2: volle entschluesselte Vorschau-Woche + ihr updatedAt, NUR fuer den verschluesselten
// Schreib-Rueckweg gebraucht (siehe Kommentar oben) -- nextWeekMeal bleibt eine Referenz IN
// nextWeekData.rows, Mutationen an nextWeekMeal wirken sich also automatisch auch hier aus.
let nextWeekData = null;
let nextWeekUpdatedAt = null;
let nextWeekMustEncrypt = false;
let nextWeekDay = 0; // Mobile-Tagesumschalter der Vorschau, unabhaengig von state.mealDay

// Laedt die Vorschau neu, sobald sich die geladene Woche aendert (siehe loadWeek()). Ein
// Fehlschlag (z. B. Netzwerkproblem) blendet die Vorschau lediglich leer aus, statt das Laden der
// eigentlich geladenen Woche zu gefaehrden -- die Vorschau ist bewusst ein rein ergaenzendes,
// nicht-kritisches Feature (Stufe 1+2, kein AP0/AP1-Aequivalent an Wichtigkeit).
async function loadNextWeekPreview() {
  nextWeekStart = addDays(state.weekStart, 7);
  try {
    // AP2.2: loadWeekDataFor() statt eines direkten api('GET', ...) -- entschluesselt lokal UND
    // holt/mergt bei Bedarf die (ggf. ebenfalls verschluesselte) Vorlage, siehe dort.
    const loaded = await loadWeekDataFor(nextWeekStart);
    nextWeekData = loaded.data;
    nextWeekUpdatedAt = loaded.updatedAt;
    nextWeekMustEncrypt = loaded.mustEncryptOnSave;
    nextWeekMeal = nextWeekData.rows.find(r => r && r.kind === 'shared' && r.mode === 'week') || null;
  } catch (err) {
    nextWeekData = null;
    nextWeekMeal = null;
    flash('Vorschau der nächsten Woche konnte nicht geladen werden: ' + err.message);
  }
  renderNextWeekPanel();
}

function renderNextWeekPanel() {
  const sub = $('#nextWeekSub');
  if (sub) {
    if (nextWeekStart) {
      const mon = parseISO(nextWeekStart);
      const sun = parseISO(nextWeekStart); sun.setDate(sun.getDate() + 6);
      sub.textContent = 'KW ' + isoWeek(mon) + ' · ' +
        mon.toLocaleDateString('de-DE', { day: '2-digit', month: 'long' }) + ' – ' +
        sun.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
    } else {
      sub.textContent = '';
    }
  }
  renderNextWeekHead();
  renderNextWeekBody();
  renderNextWeekDayNav();
}
function renderNextWeekHead() {
  const headRow = $('#nextWeekHeadRow');
  if (!headRow) return;
  headRow.querySelectorAll('th:not(.corner)').forEach(th => th.remove());
  if (!nextWeekStart) return;
  DAYS.forEach((name, i) => {
    const d = parseISO(nextWeekStart); d.setDate(d.getDate() + i);
    const th = document.createElement('th');
    th.dataset.day = String(i); // Mobile-Tagesumschalter, siehe renderNextWeekDayNav()
    th.innerHTML = `<span class="dw"></span><span class="dt"></span>`;
    th.querySelector('.dw').textContent = name;
    th.querySelector('.dt').textContent = fmtShort(d);
    headRow.appendChild(th);
  });
}
function renderNextWeekBody() {
  const tbody = $('#nextWeekTableBody');
  if (!tbody) return;
  tbody.textContent = '';
  if (!nextWeekMeal) return;
  nextWeekMeal.meals.forEach((meal, mi) => {
    const tr = document.createElement('tr');
    tr.className = 'mealrow';
    const tdLbl = document.createElement('td');
    tdLbl.className = 'lbl';
    tdLbl.textContent = meal.label;
    tr.appendChild(tdLbl);
    for (let d = 0; d < 7; d++) {
      const td = document.createElement('td');
      td.dataset.day = String(d);
      const recipeTok = (meal.cells[d] || []).find(t => t && t.t === 'recipe');
      if (recipeTok) {
        td.classList.add('mp-cell-recipe');
        td.appendChild(buildNextWeekRecipeDisplay(meal, mi, d, recipeTok));
      } else {
        td.appendChild(buildNextWeekCellDisplay(meal, mi, d));
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
}
// Analog renderMealDayNav() (Hauptwoche), aber unabhaengiger Zustand (nextWeekDay/#nextWeekDayNav)
// -- siehe Kommentar am Dateianfang dieses Abschnitts.
function renderNextWeekDayNav() {
  const nav = $('#nextWeekDayNav');
  if (!nav) return;
  nav.textContent = '';
  if (!nextWeekStart) return;
  DAYS.forEach((name, i) => {
    const d = parseISO(nextWeekStart); d.setDate(d.getDate() + i);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-current', String(i === nextWeekDay));
    b.innerHTML = '<span></span><small></small>';
    b.querySelector('span').textContent = DAYS_S[i];
    b.querySelector('small').textContent = fmtShort(d);
    b.onclick = () => { nextWeekDay = i; renderNextWeekDayNav(); };
    nav.appendChild(b);
  });
  nav.children[nextWeekDay]?.scrollIntoView({ inline: 'center', block: 'nearest' });
  const table = $('#nextWeekTable');
  if (table) table.dataset.activeDay = String(nextWeekDay);
}
// Analog buildMealCellDisplay()/buildMealSlotRecipeDisplay() (Hauptwoche) -- Klick oeffnet
// DENSELBEN #mealSlotDialog, aber mit weekCtx {weekStart: nextWeekStart, isNextWeek: true}, siehe
// openMealSlotDialog()/openMealSlotRecipeCell() weiter unten.
function buildNextWeekCellDisplay(meal, mi, d) {
  const div = document.createElement('div');
  div.className = 'cell mp-cell mp-cell-slot';
  div.tabIndex = 0;
  div.setAttribute('role', 'button');
  div.dataset.ph = '–';
  const tokens = meal.cells[d] || [];
  div.appendChild(tokensToFragment(tokens));
  const summary = tokensText(tokens).trim();
  div.setAttribute('aria-label', summary
    ? `Nächste Woche, ${meal.label}, ${DAYS[d]}: ${summary} — antippen zum Ändern`
    : `Nächste Woche, ${meal.label}, ${DAYS[d]}: nicht geplant — antippen zum Eintragen`);
  const open = () => openMealSlotDialog(meal, mi, d, { weekStart: nextWeekStart, isNextWeek: true });
  div.addEventListener('click', open);
  div.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return div;
}
function buildNextWeekRecipeDisplay(meal, mi, d, recipeTok) {
  const div = document.createElement('div');
  div.className = 'cell mp-cell mp-cell-slot mp-cell-recipe-compact';
  div.tabIndex = 0;
  div.setAttribute('role', 'button');
  const title = document.createElement('span');
  title.className = 'mp-recipe-compact-title';
  title.textContent = recipeTok.recipeTitle;
  const servingsLabel = `${recipeTok.servings} ${recipeTok.servings === 1 ? 'Person' : 'Personen'}`;
  const servings = document.createElement('span');
  servings.className = 'mp-recipe-compact-servings';
  servings.textContent = servingsLabel;
  div.append(title, servings);
  div.setAttribute('aria-label', `Nächste Woche, ${meal.label}, ${DAYS[d]}: ${recipeTok.recipeTitle}, ${servingsLabel} — antippen zum Bearbeiten`);
  const open = () => openMealSlotRecipeCell(meal, mi, d, recipeTok, { weekStart: nextWeekStart, isNextWeek: true });
  div.addEventListener('click', open);
  div.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return div;
}

/* ================= AP1.2 (projects/wochenplaner-design-nacharbeiten/plan.md): Zell-Klick-Dialog
   (#mealSlotDialog) -- EIN <dialog> mit mehreren intern umgeschalteten Schritten (".msd-step",
   ein/ausgeblendet ueber das native "hidden"-Attribut, siehe mealSlotShowStep()), kein zweiter
   Dialogtyp. 4 der 5 Optionen (Freitext/Außerhalb/Reste/Nicht geplant) schreiben direkt in
   state.data + markDirty() und schliessen sofort -- dieselbe Debounce-/Speicherkette wie jede
   andere Zellenaenderung, kein eigener API-Aufruf noetig. Nur "Rezeptkarte" braucht Serverkontakt
   (POST .../assign-recipe -- dieselbe Route/Skalierungslogik, die bis AP1.4 auch vom inzwischen
   zurueckgebauten Drag&Drop-Pfad genutzt wurde, Backend-Logik unveraendert) sowie optional POST
   .../add-ingredient-to-list (AP4.1, um AP0s targetWeekStart erweitert).

   AP2-Update: derselbe Dialog wird jetzt AUCH fuer Zellen der NAECHSTEN Woche (#nextWeekPanel)
   verwendet -- mealSlotContext traegt dafuer zusaetzlich "weekStart"/"isNextWeek". Fuer die
   aktuell geladene Woche (isNextWeek:false) bleibt ALLES exakt wie bisher (lokale state.data-
   Mutation + Autosave). Fuer die naechste Woche (isNextWeek:true) schreiben die 4 einfachen
   Optionen ueber den neuen, gezielten set-meal-cell-Endpunkt (applyMealSlotTokens()) und
   "Rezeptkarte" ueber denselben assign-recipe-Endpunkt wie sonst, nur mit targetWeekStart
   (submitMealSlotRecipe()) -- in BEIDEN Faellen OHNE state.data/dirty/save-Zyklus fuer diese
   zweite Woche zu halten (MORROWs Kernempfehlung, siehe Ruecklauf an ANORAK). Stattdessen wird
   direkt das lokale Vorschau-Objekt (nextWeekMeal, siehe loadNextWeekPreview()) aktualisiert und
   nur das Vorschau-Panel neu gezeichnet (renderNextWeekPanel()) -- state.weekStart/state.data/
   state.dirty/state.saving bleiben davon vollstaendig unberuehrt. ================= */

// Kontext, welche Zelle der Dialog gerade bearbeitet -- gesetzt beim Oeffnen, zurueckgesetzt im
// "close"-Handler (siehe boot()). "weekStart" ist die tatsaechlich betroffene Woche (== state.
// weekStart fuer die aktuelle, == nextWeekStart fuer die AP2-Vorschau); "isNextWeek" steuert, ob
// ueber lokale Mutation+Autosave oder ueber die gezielten Endpunkte geschrieben wird.
let mealSlotContext = null; // {meal, mi, d, weekStart, isNextWeek} oder null
// Waehrend Schritt "Rezeptdetails": das per GET /api/recipes/:id geladene Volldetail-Rezept plus
// die aktuell angezeigte (automatisch skalierte, ggf. manuell ueberschriebene) Zutatenliste.
let mealSlotRecipe = null; // {recipe, ingredients:[{amount,unit,name,addToList}]} oder null
// Waehrend Schritt "Einkaufstag": welche Zutaten (Index im Snapshot-Token) nach der Zuweisung
// tatsaechlich auf die Einkaufsliste sollen. "sourceWeekStart" ist die Woche, in die das Rezept
// GERADE zugewiesen wurde (== mealSlotContext.weekStart zum Zeitpunkt der Zuweisung) -- add-
// ingredient-to-list liest den Zutaten-Snapshot von DORT, nicht zwingend von state.weekStart
// (AP2: eine Zuweisung in die naechste Woche liegt eben dort, nicht in der geladenen Woche).
let mealSlotShoppingQueue = null; // {sourceWeekStart, dayIndex, slotIndex, indexes:[...]} oder null
// AP1-Korrektur: true, wenn der Rezeptdetails-Schritt gerade eine BEREITS zugewiesene Zelle
// bearbeitet (Einstieg ueber openMealSlotRecipeCell(), direkt aus der kompakten Zellenanzeige) --
// steuert, ob "Zuweisung entfernen" sichtbar ist und wohin "Zurueck" fuehrt (zu den 5 Optionen
// statt zur Rezeptauswahl, siehe dortige Kommentare).
let mealSlotEditingRecipeCell = false;

const MEAL_SLOT_STEPS = ['msdStepOptions', 'msdStepText', 'msdStepRecipePick', 'msdStepRecipeDetail', 'msdStepShopDate'];
function mealSlotShowStep(id) {
  MEAL_SLOT_STEPS.forEach(s => { $('#' + s).hidden = s !== id; });
}
function setStepError(id, text) {
  const el = $('#' + id);
  el.textContent = text;
  el.hidden = !text;
}
// AP1-Korrektur: einheitliche "Aktuell: ..."-Zusammenfassung fuer JEDEN Zelleninhalt -- inkl.
// Rezept-Token, den das generische tokensText() (nur text/icon-Tokens) nicht sinnvoll abbildet.
// Gebraucht sowohl von primeMealSlotOptionsStep() (Schritt 1) als auch indirekt beim Zurueck-Weg
// aus dem Rezeptdetails-Schritt einer bereits zugewiesenen Zelle.
function mealCellSummaryText(tokens) {
  const recipeTok = (tokens || []).find(t => t && t.t === 'recipe');
  if (recipeTok) return `${recipeTok.recipeTitle} (${recipeTok.servings} ${recipeTok.servings === 1 ? 'Person' : 'Personen'})`;
  return tokensText(tokens || []).trim();
}

// Baut Schritt 1 (5 Optionen) fuer eine Zelle auf, OHNE den Dialog zu oeffnen (showModal() auf
// einem bereits offenen <dialog> wirft) -- getrennt von openMealSlotDialog(), damit "Zurueck" aus
// dem Rezeptdetails-Schritt einer bereits offenen Sitzung ebenfalls dorthin zurueckspringen kann
// (siehe $('#msdRecipeDetailBack') in boot()). "weekCtx" (optional): {weekStart, isNextWeek} --
// ohne Angabe (Aufruf aus der aktuellen Woche) gilt state.weekStart/isNextWeek:false.
function primeMealSlotOptionsStep(meal, mi, d, weekCtx) {
  const weekStart = weekCtx?.weekStart ?? state.weekStart;
  const isNextWeek = weekCtx?.isNextWeek ?? false;
  mealSlotContext = { meal, mi, d, weekStart, isNextWeek };
  mealSlotRecipe = null;
  mealSlotShoppingQueue = null;
  mealSlotEditingRecipeCell = false;
  const tokens = meal.cells[d] || [];
  const summary = mealCellSummaryText(tokens);
  $('#msdTitle').textContent = isNextWeek ? `Nächste Woche, ${meal.label}, ${DAYS[d]}` : `${meal.label}, ${DAYS[d]}`;
  const cur = $('#msdCurrent');
  if (summary) { cur.hidden = false; cur.textContent = `Aktuell: ${summary} — eine neue Auswahl ersetzt diesen Eintrag.`; }
  else { cur.hidden = true; cur.textContent = ''; }
  // Freitext-Feld vorbelegen, wenn die Zelle bereits reiner Text ist (kein Icon-/Rezept-Vermerk)
  // -- passt zum in der Rueckmeldung an ANORAK festgelegten Standardverhalten fuer bereits belegte
  // Zellen (derselbe Dialog oeffnet sich, Auswahl ersetzt den bisherigen Inhalt).
  $('#msdTextInput').value = tokens.length === 1 && tokens[0].t === 'text' ? tokens[0].v : '';
  mealSlotShowStep('msdStepOptions');
}
function openMealSlotDialog(meal, mi, d, weekCtx) {
  primeMealSlotOptionsStep(meal, mi, d, weekCtx);
  $('#mealSlotDialog').showModal();
}
function closeMealSlotDialog() {
  $('#mealSlotDialog').close();
}

// AP2: schreibt "tokens" in die aktuell im Dialog bearbeitete Zelle (die 4 einfachen Optionen,
// siehe handleMealSlotOption()/submitMealSlotText()) -- fuer die AKTUELL GELADENE Woche
// unveraendert lokal (state.data-Mutation + markDirty(), derselbe Autosave-Weg wie jede andere
// Zellenaenderung, funktioniert dank AP2.1 bereits transparent verschluesselt). Fuer die AP2-
// Vorschau der naechsten Woche: bei einem PLAINTEXT-Haushalt weiterhin ueber den gezielten
// set-meal-cell-Endpunkt (server.js); bei einem AKTIVEN (verschluesselten) Haushalt lehnt dieser
// Endpunkt serverseitig ab (der Server kann weeks.data nicht mehr lesen/aendern, siehe dortiger
// Kommentar) -- AP2.2 schreibt fuer diesen Fall stattdessen die komplette, bereits lokal
// gehaltene Vorschau-Woche (nextWeekData) neu verschluesselt zurueck (saveWeekDataFor()). Kein
// "close"-Aufruf bei einem Fehler im Naechste-Woche-Fall: der Dialog bleibt offen (Schritt
// unveraendert), Fehlermeldung per flash() (die betroffenen Schritte -- Optionen/Freitext --
// haben keine eigene Inline-Fehleranzeige, anders als die Rezeptdetails-/Einkaufstag-Schritte).
async function applyMealSlotTokens(tokens) {
  if (!mealSlotContext) return;
  const { meal, mi, d, weekStart, isNextWeek } = mealSlotContext;
  // Alte "bereits auf Liste uebernommen"-Markierungen dieser Zelle sind mit JEDER Aenderung
  // (auch einer Entfernung, siehe #msdRecipeRemove in boot()) obsolet -- unabhaengig davon, ob
  // vorher ueberhaupt ein Rezept dort lag (harmloser No-Op, falls nicht).
  clearIngredientListMarksFor(weekStart, d, mi);
  if (!isNextWeek) {
    meal.cells[d] = tokens;
    markDirty();
    closeMealSlotDialog();
    return;
  }
  try {
    if (state.crypto?.encryptionStatus === 'active') {
      // AP2.2: "meal" ist bereits eine Referenz IN nextWeekData (ueber nextWeekMeal) -- die
      // Mutation unten wirkt sich automatisch dort aus, bevor die gesamte Woche verschluesselt
      // zurueckgeschrieben wird.
      meal.cells[d] = tokens;
      const saved = await saveWeekDataFor(weekStart, nextWeekData, nextWeekUpdatedAt, nextWeekMustEncrypt);
      nextWeekUpdatedAt = saved.updatedAt;
    } else {
      await api('POST', `/api/weeks/${state.weekStart}/set-meal-cell`,
        { targetWeekStart: weekStart, dayIndex: d, slotIndex: mi, tokens });
      meal.cells[d] = tokens; // "meal" ist eine Referenz IN nextWeekMeal (siehe renderNextWeekBody()) -- Mutation wirkt sich direkt dort aus.
    }
    renderNextWeekPanel();
    closeMealSlotDialog();
  } catch (err) {
    flash('Speichern für die nächste Woche fehlgeschlagen: ' + err.message);
  }
}

function handleMealSlotOption(option) {
  if (!mealSlotContext) return;
  if (option === 'none') { closeMealSlotDialog(); return; }
  if (option === 'text') { mealSlotShowStep('msdStepText'); $('#msdTextInput').focus(); return; }
  if (option === 'recipe') { openMealSlotRecipePick(); return; }
  if (option === 'out' || option === 'leftover') {
    // AP1.3 (vorgezogen): "i-auswaerts"/"i-reste", siehe icons.js. Gleiche Token-Form wie ein
    // manuell per Palette eingefuegtes Piktogramm (insertIcon() oben: Icon-Token + Text-Token mit
    // demselben Label) -- eine so gebaute Zelle ist von einer manuell befuellten nicht zu
    // unterscheiden und nutzt exakt dieselbe Rendering-Pipeline (tokensToFragment()/iconSpan()).
    const iconId = option === 'out' ? 'i-auswaerts' : 'i-reste';
    const label = option === 'out' ? 'Essen außerhalb' : 'Reste vom Vortag';
    applyMealSlotTokens([{ t: 'icon', v: iconId, l: label }, { t: 'text', v: ' ' + label }]);
  }
}

/* ---------------- Schritt "Freitext" ---------------- */
function submitMealSlotText(e) {
  e.preventDefault();
  if (!mealSlotContext) return;
  const text = $('#msdTextInput').value.trim();
  applyMealSlotTokens(text ? [{ t: 'text', v: text }] : []);
}

/* ---------------- Schritt "Rezeptauswahl" ---------------- */
function openMealSlotRecipePick() {
  const list = $('#msdRecipeList');
  list.textContent = '';
  $('#msdRecipeEmpty').hidden = state.recipes.length > 0;
  state.recipes.forEach(r => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'list-group-item list-group-item-action';
    btn.textContent = `${r.title} (Referenz: ${r.baseServings} ${r.baseServings === 1 ? 'Person' : 'Personen'})`;
    btn.addEventListener('click', () => openMealSlotRecipeDetail(r));
    list.appendChild(btn);
  });
  mealSlotShowStep('msdStepRecipePick');
}

/* ---------------- Schritt "Rezeptdetails": Personenzahl/Skalierung/Checkbox ---------------- */
// Mirror von scaleIngredients() in server.js (identische Formel/Rundung) -- rein fuer die
// Live-Vorschau im Dialog, der Server bleibt beim tatsaechlichen Zuweisen (assign-recipe) die
// alleinige, kanonische Quelle fuer die gespeicherten Werte.
function scaleIngredientsClient(ingredients, baseServings, targetServings) {
  const factor = targetServings / baseServings;
  return (ingredients || []).map(ing => {
    if (typeof ing.amount !== 'number' || !Number.isFinite(ing.amount)) return { amount: null, unit: ing.unit, name: ing.name };
    return { amount: Math.round(ing.amount * factor * 100) / 100, unit: ing.unit, name: ing.name };
  });
}
// AP1-Korrektur: aus renderMealSlotIngredients() herausgezogener, reiner DOM-Aufbau -- wird jetzt
// von ZWEI Quellen befuellt: einer frisch skalierten Liste (Personenzahl-Aenderung/Neuzuweisung,
// siehe renderMealSlotIngredients()) UND einem bestehenden Snapshot 1:1 ohne Neuskalierung
// (Bearbeiten einer bereits zugewiesenen Zelle, siehe openMealSlotRecipeCell()). "list" ist
// bereits die endgueltige {amount,unit,name,addToList}-Form.
function renderMealSlotIngredientRows(list) {
  const wrap = $('#msdIngredients');
  wrap.textContent = '';
  mealSlotRecipe.ingredients = list;
  const { mi, d, weekStart } = mealSlotContext || {};
  list.forEach((ing, ii) => {
    const row = document.createElement('div');
    row.className = 'wizard-ing-row';

    const amount = document.createElement('input');
    amount.type = 'number'; amount.step = 'any';
    amount.className = 'form-control form-control-sm wizard-ing-amount';
    amount.setAttribute('aria-label', `Menge für ${ing.name}`);
    amount.value = ing.amount ?? '';
    amount.addEventListener('input', () => {
      mealSlotRecipe.ingredients[ii].amount = amount.value === '' ? null : Number(amount.value);
    });

    const unit = document.createElement('input');
    unit.type = 'text'; unit.maxLength = 20; // LIMITS.ingredientUnit (server.js)
    unit.className = 'form-control form-control-sm wizard-ing-unit';
    unit.setAttribute('aria-label', `Einheit für ${ing.name}`);
    unit.value = ing.unit || '';
    unit.addEventListener('input', () => { mealSlotRecipe.ingredients[ii].unit = unit.value.slice(0, 20); });

    const name = document.createElement('span');
    name.className = 'wizard-ing-name';
    name.textContent = ing.name;

    // AP1-Korrektur: bereits auf eine Einkaufsliste uebernommene Zutaten (addedToListMarks, siehe
    // weiter unten) sind hier -- wie zuvor in der jetzt entfernten buildRecipeAssignToken() --
    // angehakt+deaktiviert, um versehentliche Duplikate durch erneutes Anhaken zu vermeiden
    // (kein serverseitiges Dedup, siehe add-ingredient-to-list in server.js).
    const alreadyAdded = mi != null && d != null && isIngredientMarkedAddedToList(weekStart, d, mi, ii);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'form-check-input wizard-ing-cb';
    cb.checked = ing.addToList || alreadyAdded;
    cb.disabled = alreadyAdded;
    cb.title = alreadyAdded ? 'Bereits auf eine Einkaufsliste übernommen' : 'Auf Einkaufsliste setzen';
    cb.setAttribute('aria-label', `${ing.name} auf Einkaufsliste setzen`);
    cb.addEventListener('change', () => { mealSlotRecipe.ingredients[ii].addToList = cb.checked; });
    mealSlotRecipe.ingredients[ii].addToList = cb.checked; // Anfangszustand (alreadyAdded) uebernehmen

    row.append(amount, unit, name, cb);
    wrap.appendChild(row);
  });
}
// Baut die editierbaren Zutatenzeilen NEU aus den frisch skalierten Werten -- ein bewusster,
// dokumentierter Nutzerkompromiss: ein Personenzahl-Wechsel verwirft etwaige manuelle
// Mengen-/Einheit-Korrekturen der vorherigen Personenzahl (Neuberechnung statt Verrechnung
// zweier unabhaengiger Aenderungen, die sich sonst unvorhersehbar ueberlagern wuerden).
function renderMealSlotIngredients(recipe, servings) {
  const scaled = scaleIngredientsClient(recipe.ingredients, recipe.baseServings, servings);
  renderMealSlotIngredientRows(scaled.map(i => ({ ...i, addToList: false })));
}
async function openMealSlotRecipeDetail(recipeOverview) {
  mealSlotEditingRecipeCell = false;
  $('#msdRecipeRemove').hidden = true;
  setStepError('msdRecipeError', '');
  mealSlotShowStep('msdStepRecipeDetail');
  $('#msdRecipeDetailTitle').textContent = recipeOverview.title;
  $('#msdIngredients').textContent = 'Lädt …';
  $('#msdInstructions').textContent = '';
  $('#msdServings').value = recipeOverview.baseServings;
  $('#msdRecipeSubmit').disabled = true;
  try {
    // Uebersichtsliste (state.recipes) enthaelt bewusst keine ingredients/instructions (siehe
    // GET /api/recipes in server.js) -- Detail wird bei Bedarf nachgeladen, exakt wie beim
    // Bearbeiten-Dialog der Rezeptkarten-Ansicht selbst (openRecipeForm()).
    const { recipe } = await api('GET', `/api/recipes/${recipeOverview.id}`);
    mealSlotRecipe = { recipe, ingredients: [] };
    renderMealSlotIngredients(recipe, recipe.baseServings);
    $('#msdInstructions').textContent = recipe.instructions || '(keine Zubereitungshinweise hinterlegt)';
    // Fokus auf die Personenzahl -- gleiches Prinzip wie beim (mit AP1.4 entfallenen) frueheren
    // Drag&Drop-Personenzahl-Dialog (siehe Git-Historie).
    $('#msdServings').focus();
    $('#msdServings').select();
  } catch (err) {
    setStepError('msdRecipeError', err.message);
  } finally {
    $('#msdRecipeSubmit').disabled = false;
  }
}
// AP1-Korrektur: Einstieg fuer eine BEREITS zugewiesene Zelle (Klick auf buildMealSlotRecipeDisplay())
// -- oeffnet den Dialog direkt im Rezeptdetails-Schritt (kein Umweg ueber die 5 Optionen/die
// Rezeptauswahl), vorbefuellt mit dem AKTUELLEN Snapshot (recipeTok.ingredients) statt einer
// frischen Skalierung vom Referenzrezept -- sonst gingen bereits vorhandene manuelle Mengen-/
// Einheit-Korrekturen (F6) beim blossen Oeffnen verloren. Erst ein tatsaechlicher Personenzahl-
// Wechsel im Dialog skaliert wieder frisch (renderMealSlotIngredients(), siehe deren Listener
// weiter unten). Das Referenzrezept wird trotzdem nachgeladen (fuer Zubereitungstext und als
// Skalierungs-Basis bei einem Personenzahl-Wechsel) -- schlaegt das fehl (Rezept zwischenzeitlich
// geloescht, F6 "recipeId zeigt ins Leere"), bleibt der Snapshot trotzdem vollstaendig anzeig-/
// entfernbar, nur eine erneute Skalierung ist dann nicht mehr sinnvoll moeglich.
// AP2: "weekCtx" (optional) analog primeMealSlotOptionsStep() -- {weekStart, isNextWeek}, ohne
// Angabe gilt state.weekStart/isNextWeek:false (Klick aus der aktuellen Woche).
async function openMealSlotRecipeCell(meal, mi, d, recipeTok, weekCtx) {
  const weekStart = weekCtx?.weekStart ?? state.weekStart;
  const isNextWeek = weekCtx?.isNextWeek ?? false;
  mealSlotContext = { meal, mi, d, weekStart, isNextWeek };
  mealSlotShoppingQueue = null;
  mealSlotEditingRecipeCell = true;
  $('#msdRecipeRemove').hidden = false;
  $('#msdTitle').textContent = isNextWeek ? `Nächste Woche, ${meal.label}, ${DAYS[d]}` : `${meal.label}, ${DAYS[d]}`;
  $('#msdCurrent').hidden = true; // kein Options-Schritt dazwischen, daher kein "Aktuell"-Hinweis noetig
  setStepError('msdRecipeError', '');
  // Bugfix (Nutzer-Feedback nach AP1+AP2-Test): anders als openMealSlotDialog() (Einstieg ueber
  // die 5 Optionen) fehlte hier der eigentliche showModal()-Aufruf -- der Dialoginhalt wurde zwar
  // korrekt fuer den Rezeptdetails-Schritt aufgebaut, aber nie sichtbar geoeffnet. Kein Schutz vor
  // einem bereits offenen Dialog noetig: diese Funktion wird ausschliesslich per Klick auf eine
  // Zelle AUSSERHALB des (modalen, den Rest der Seite waehrenddessen inerten) Dialogs ausgeloest,
  // der Dialog kann in diesem Moment also nie schon offen sein.
  $('#mealSlotDialog').showModal();
  mealSlotShowStep('msdStepRecipeDetail');
  $('#msdRecipeDetailTitle').textContent = recipeTok.recipeTitle;
  $('#msdInstructions').textContent = '';
  $('#msdServings').value = recipeTok.servings;
  $('#msdRecipeSubmit').disabled = true;
  const prefill = recipeTok.ingredients.map((ing, ii) => ({
    amount: ing.amount, unit: ing.unit, name: ing.name,
    addToList: isIngredientMarkedAddedToList(weekStart, d, mi, ii)
  }));
  try {
    const { recipe } = await api('GET', `/api/recipes/${recipeTok.recipeId}`);
    mealSlotRecipe = { recipe, ingredients: [] };
    renderMealSlotIngredientRows(prefill);
    $('#msdInstructions').textContent = recipe.instructions || '(keine Zubereitungshinweise hinterlegt)';
    $('#msdServings').focus();
    $('#msdServings').select();
  } catch (err) {
    // Referenzrezept nicht (mehr) verfuegbar -- Snapshot bleibt trotzdem nutzbar (siehe Kommentar
    // oben), nur eine Personenzahl-Aenderung wuerde beim Zuweisen serverseitig 404 liefern
    // (bestehende Fehlerbehandlung in submitMealSlotRecipe()), ein reines Entfernen bleibt moeglich.
    mealSlotRecipe = { recipe: { id: recipeTok.recipeId, baseServings: recipeTok.servings, ingredients: recipeTok.ingredients, instructions: '' }, ingredients: [] };
    renderMealSlotIngredientRows(prefill);
    $('#msdInstructions').textContent = '(Zubereitung nicht verfügbar — das zugrunde liegende Rezept wurde inzwischen gelöscht.)';
  } finally {
    $('#msdRecipeSubmit').disabled = false;
  }
}
// AP2.2: clientseitiges Aequivalent zu POST .../assign-recipe fuer AKTIVE (verschluesselte)
// Haushalte -- der Server kann weeks.data fuer diese Haushalte nicht mehr lesen/skalieren und lehnt
// den Endpunkt serverseitig mit 409 ab (siehe dortiger Kommentar in server.js). Baut denselben
// Rezept-Snapshot-Token wie der Server (identische Skalierungsformel/-rundung, siehe
// scaleIngredientsClient()-Kommentar), schreibt ihn in die bereits lokal gehaltene Zielwoche
// (state.data fuer die aktuelle Woche, nextWeekData fuer die Vorschau) und verschluesselt die
// KOMPLETTE Woche neu zurueck -- MORROWs "Lese-Aendern-Schreiben"-Muster (ap1.2-datenmodell.md
// Abschnitt 6.3). Liefert bewusst dieselbe Form wie die bisherige Server-Antwort
// ({token, data, updatedAt}), damit der Rest von submitMealSlotRecipe() unten unveraendert bleibt.
async function assignRecipeClientSide({ recipeId, dayIndex, slotIndex, servings, targetWeekStart, isNextWeek }) {
  const recipe = mealSlotRecipe.recipe;
  const scaledIngredients = scaleIngredientsClient(recipe.ingredients, recipe.baseServings, servings)
    .map(ing => ({ amount: ing.amount, unit: ing.unit, name: ing.name }));
  const recipeTitle = String(recipe.title || '').slice(0, 200).trim() || recipe.title;
  const token = { t: 'recipe', recipeId, recipeTitle, servings, ingredients: scaledIngredients };

  const targetData = isNextWeek ? nextWeekData : state.data;
  const mealRow = targetData?.rows.find(r => r && r.kind === 'shared' && r.mode === 'week');
  if (!mealRow) throw new Error('"Essen & Kochen"-Zeile in dieser Woche nicht gefunden');
  mealRow.meals[slotIndex].cells[dayIndex] = [token];

  let updatedAt;
  if (isNextWeek) {
    const saved = await saveWeekDataFor(targetWeekStart, targetData, nextWeekUpdatedAt, nextWeekMustEncrypt);
    nextWeekUpdatedAt = saved.updatedAt;
    updatedAt = saved.updatedAt;
  } else {
    // Aktuelle Woche: ueber den ganz normalen Speicherpfad, identisch zu jeder anderen
    // Zellenaenderung -- save() aktualisiert state.updatedAt bereits selbst.
    await save();
    updatedAt = state.updatedAt;
  }
  return { token, data: targetData, updatedAt };
}

async function submitMealSlotRecipe(e) {
  e.preventDefault();
  setStepError('msdRecipeError', '');
  if (!mealSlotContext || !mealSlotRecipe) return;
  const servings = Number($('#msdServings').value);
  if (!Number.isInteger(servings) || servings < 1 || servings > 20) {
    setStepError('msdRecipeError', 'Personenzahl muss eine ganze Zahl zwischen 1 und 20 sein.');
    return;
  }
  const { mi, d, weekStart, isNextWeek } = mealSlotContext;
  const recipeId = Number(mealSlotRecipe.recipe.id);
  const wantedInList = mealSlotRecipe.ingredients
    .map((ing, ii) => ({ ing, ii }))
    .filter(({ ing }) => ing.addToList);

  $('#msdRecipeSubmit').disabled = true;
  try {
    // Erst lokale, noch ungespeicherte Aenderungen der AKTUELL GELADENEN Woche sichern, bevor der
    // Server eine komplette Woche zurueckschreibt -- betrifft state.data unabhaengig davon, in
    // welche Woche gerade zugewiesen wird (der Dialog ist modal, eine gleichzeitige Bearbeitung
    // "nebenbei" ist strukturell ausgeschlossen).
    syncFromDOM();
    if (state.dirty) await save();

    // AP2: targetWeekStart (== state.weekStart im Normalfall, == weekStart der Vorschau bei einer
    // Zuweisung in die naechste Woche) analog AP0s Erweiterung von add-ingredient-to-list.
    // AP2.2: fuer aktive (verschluesselte) Haushalte laeuft die Zuweisung komplett clientseitig
    // (assignRecipeClientSide()) statt ueber den Server-Endpunkt, der fuer diese Haushalte mit 409
    // ablehnt (server.js).
    const res = (state.crypto?.encryptionStatus === 'active')
      ? await assignRecipeClientSide({ recipeId, dayIndex: d, slotIndex: mi, servings, targetWeekStart: weekStart, isNextWeek })
      : await api('POST', `/api/weeks/${state.weekStart}/assign-recipe`,
          { recipeId, dayIndex: d, slotIndex: mi, servings, targetWeekStart: weekStart });

    const placedRow = res.data.rows.find(r => r.mode === 'week');
    const placedToken = placedRow?.meals?.[mi]?.cells?.[d]?.find(t => t.t === 'recipe');
    let overridden = false;
    // AP1.2: manuelle Mengen-/Einheit-Korrekturen aus der Wizard-Vorschau auf den soeben vom
    // Server berechneten/gespeicherten Token uebertragen -- gleiches Prinzip wie die bereits
    // bestehende Nachbearbeitung (F6). placedToken ist eine Referenz IN res.data (kein Klon).
    // AP2-Einschraenkung (bewusst, siehe Ruecklauf an ANORAK): NUR fuer die aktuell geladene Woche,
    // wo die Korrektur ueber den normalen Autosave von state.data dauerhaft gespeichert wird (siehe
    // markDirty() unten). Fuer die naechste Woche gibt es bewusst KEINEN eigenen Persistenz-Pfad
    // fuer einen manuell korrigierten Rezept-Token (set-meal-cell lehnt 'recipe'-Tokens bewusst ab,
    // siehe server.js) -- eine manuelle Korrektur bleibt dort trotzdem jederzeit ueber erneutes
    // Oeffnen dieser Zelle (openMealSlotRecipeCell()) nachtraeglich moeglich, sobald sie zugewiesen
    // ist (dann greift derselbe Mechanismus wie bei der aktuellen Woche).
    if (!isNextWeek && placedToken && mealSlotRecipe.ingredients.length === placedToken.ingredients.length) {
      placedToken.ingredients.forEach((ing, ii) => {
        const edited = mealSlotRecipe.ingredients[ii];
        if (edited.amount !== ing.amount) { ing.amount = edited.amount; overridden = true; }
        if (edited.unit !== ing.unit) { ing.unit = edited.unit; overridden = true; }
      });
    }

    clearIngredientListMarksFor(weekStart, d, mi);
    if (isNextWeek) {
      // MORROWs Kernempfehlung: KEIN state.data/dirty/save-Zyklus fuer die naechste Woche --
      // stattdessen nur das lokale Vorschau-Objekt aktualisieren und das Panel neu zeichnen.
      nextWeekMeal = placedRow || null;
      renderNextWeekPanel();
    } else {
      state.data = res.data;
      state.data.goals = state.data.goals || [];
      state.data.highlights = state.data.highlights || [];
      state.data.calls = state.data.calls || [];
      state.updatedAt = res.updatedAt;
      state.dirty = false;
      // Die manuelle Korrektur oben (falls vorhanden) ist noch nicht auf dem Server -- naechster
      // Autosave (Debounce, wie jede andere Zellenaenderung) nimmt sie mit.
      if (overridden) markDirty();
    }

    if (wantedInList.length) {
      mealSlotShoppingQueue = { sourceWeekStart: weekStart, dayIndex: d, slotIndex: mi, indexes: wantedInList.map(w => w.ii) };
      setStepError('msdShopDateError', '');
      const todayIso = isoOf(new Date());
      const dateInput = $('#msdShopDate');
      dateInput.min = todayIso;
      dateInput.value = todayIso;
      mealSlotShowStep('msdStepShopDate');
    } else {
      closeMealSlotDialog();
    }
    flash(`„${res.token.recipeTitle}" wurde ${DAYS[d]} (${res.token.servings} ${res.token.servings === 1 ? 'Person' : 'Personen'}) zugewiesen${isNextWeek ? ' (nächste Woche)' : ''}.`);
  } catch (err) {
    setStepError('msdRecipeError', err.message);
  } finally {
    $('#msdRecipeSubmit').disabled = false;
  }
}

/* ---------------- Schritt "Einkaufstag" (nur falls mindestens eine Checkbox aktiv war) ----------------
   AP0 (projects/wochenplaner-design-nacharbeiten/plan.md): natives <input type="date"> statt
   eines eigenen Monats-/Kalender-Widgets -- der Browser liefert Monatsnavigation, Tastatur-
   bedienbarkeit und (ueber "min") automatisch ausgegraute/nicht waehlbare vergangene Tage, ohne
   eigenen JS-Kalender oder CSP-Sonderfall. Aus dem gewaehlten Datum werden targetWeekStart
   (Montag der Zielwoche) und targetDayIndex (0=Montag..6=Sonntag) abgeleitet und an
   add-ingredient-to-list durchgereicht (AP0-Erweiterung) -- fuer mehrere angehakte Zutaten
   bewusst EIN gemeinsamer Schritt/EIN gewaehltes Datum statt eines Dialogs pro Zutat (schnellere
   Batch-Uebernahme -- ersetzt seit der AP1-Korrektur auch den frueheren Einzel-Zutat-
   Tagesauswahl-Dialog, der ausschliesslich fuer die Checkbox in der jetzt entfernten
   buildRecipeAssignToken() existierte, siehe Kommentar bei addedToListMarks weiter unten).
   Sequentiell (nicht parallel) abgearbeitet, damit
   mehrere Zutaten in dieselbe (evtl. neu anzulegende) Zielwoche einander nicht per Race
   ueberschreiben (jeder Aufruf serialisiert ohnehin per FOR UPDATE serverseitig, sequentielle
   Aufrufe vermeiden zusaetzlich unnoetige 409/Retry-Faelle). */
// JS-Port von formatIngredientText() (server.js) -- baut aus einer Zutat einen einzelnen
// Anzeigetext fuer einen Tagesliste-Eintrag, identisch zum bisherigen Server-Format.
function formatIngredientTextClient(ingredient) {
  const amountUnit = [
    typeof ingredient.amount === 'number' && Number.isFinite(ingredient.amount) ? String(ingredient.amount) : null,
    ingredient.unit || null
  ].filter(Boolean).join(' ');
  return amountUnit ? `${amountUnit} ${ingredient.name}` : ingredient.name;
}

// AP2.2: clientseitiges Aequivalent zu POST .../add-ingredient-to-list fuer AKTIVE (verschluesselte)
// Haushalte -- der Server kann weeks.data fuer diese Haushalte nicht mehr lesen/aendern (409, siehe
// server.js). Die QUELL-Woche (Rezept-Snapshot) ist immer entweder die aktuelle (state.data) oder
// die Vorschau-Woche (nextWeekData) -- der Dialog kennt keine dritte Quelle. Die ZIEL-Woche
// (Einkaufsliste) kann dagegen eine voellig BELIEBIGE, noch nicht geladene Woche sein (frei per
// Datumsauswahl gewaehlt) -- dafuer wird sie bei Bedarf ueber loadWeekDataFor() extra geholt.
// Liefert dieselbe Form wie die bisherige Server-Antwort ({targetWeekStart, data, updatedAt}),
// damit submitMealSlotShopDate() unten unveraendert bleibt.
async function addIngredientToListClientSide({ sourceWeekStart, dayIndex, slotIndex, ingredientIndex, targetWeekStart, targetDayIndex }) {
  const sourceData = sourceWeekStart === state.weekStart ? state.data
    : sourceWeekStart === nextWeekStart ? nextWeekData
    : null;
  const sourceMealRow = sourceData?.rows.find(r => r && r.kind === 'shared' && r.mode === 'week');
  const recipeTok = sourceMealRow?.meals?.[slotIndex]?.cells?.[dayIndex]?.find(t => t && t.t === 'recipe');
  if (!recipeTok) throw new Error('In dieser Zelle ist aktuell kein Rezept zugewiesen');
  const ingredient = recipeTok.ingredients[ingredientIndex];
  if (!ingredient) throw new Error('Zutat mit diesem Index nicht gefunden');

  let targetData, targetBaseUpdatedAt, targetMustEncrypt;
  if (targetWeekStart === state.weekStart) {
    targetData = state.data; targetBaseUpdatedAt = state.updatedAt; targetMustEncrypt = state.weekEncrypted;
  } else if (targetWeekStart === nextWeekStart) {
    targetData = nextWeekData; targetBaseUpdatedAt = nextWeekUpdatedAt; targetMustEncrypt = nextWeekMustEncrypt;
  } else {
    // Dritte, noch nicht geladene Woche -- eigener Laden+Entschluesseln+Vorlagen-Merge-Zyklus.
    const loaded = await loadWeekDataFor(targetWeekStart);
    targetData = loaded.data; targetBaseUpdatedAt = loaded.updatedAt; targetMustEncrypt = loaded.mustEncryptOnSave;
  }
  const listRow = targetData.rows.find(r => r && r.kind === 'shared' && r.listMode === true);
  if (!listRow) throw new Error('"Einkauf & Besorgungen"-Zeile in der Zielwoche nicht gefunden');
  const targetList = listRow.cells[targetDayIndex];
  // 40 == LIMITS.listItems in server.js (cleanListItems()) -- identischer Wert, hier hart
  // hinterlegt, da LIMITS eine reine Server-Konstante ist.
  if (targetList.length >= 40) throw new Error('Tagesliste ist bereits voll (max. 40 Einträge)');
  targetList.push({ done: false, tokens: [{ t: 'text', v: formatIngredientTextClient(ingredient) }] });

  let updatedAt;
  if (targetWeekStart === state.weekStart) {
    await save();
    updatedAt = state.updatedAt;
  } else {
    const saved = await saveWeekDataFor(targetWeekStart, targetData, targetBaseUpdatedAt, targetMustEncrypt);
    updatedAt = saved.updatedAt;
    if (targetWeekStart === nextWeekStart) nextWeekUpdatedAt = updatedAt;
  }
  return { targetWeekStart, data: targetData, updatedAt };
}

async function submitMealSlotShopDate(e) {
  e.preventDefault();
  setStepError('msdShopDateError', '');
  if (!mealSlotShoppingQueue) return;
  const val = $('#msdShopDate').value;
  if (!val) { setStepError('msdShopDateError', 'Bitte ein Datum wählen.'); return; }
  const chosen = parseISO(val);
  const targetWeekStart = isoOf(toMonday(chosen));
  const targetDayIndex = (chosen.getDay() + 6) % 7;
  const { sourceWeekStart, dayIndex, slotIndex, indexes } = mealSlotShoppingQueue;

  $('#msdShopDateSubmit').disabled = true;
  try {
    // AP2: die Zutat-QUELLE (Rezept-Snapshot) liegt in "sourceWeekStart" -- das ist state.weekStart
    // fuer eine ganz normale Zuweisung, kann aber auch die naechste (Vorschau-)Woche sein, wenn die
    // Zuweisung gerade dort erfolgt ist (siehe submitMealSlotRecipe()). Nicht zu verwechseln mit
    // "targetWeekStart" (Ziel der Einkaufsliste, aus dem gewaehlten Datum oben).
    for (const ingredientIndex of indexes) {
      // AP2.2: fuer aktive (verschluesselte) Haushalte laeuft die Uebernahme komplett clientseitig
      // (addIngredientToListClientSide()) statt ueber den Server-Endpunkt, der fuer diese Haushalte
      // mit 409 ablehnt (server.js).
      const res = (state.crypto?.encryptionStatus === 'active')
        ? await addIngredientToListClientSide({ sourceWeekStart, dayIndex, slotIndex, ingredientIndex, targetDayIndex, targetWeekStart })
        : await api('POST', `/api/weeks/${sourceWeekStart}/add-ingredient-to-list`,
            { dayIndex, slotIndex, ingredientIndex, targetDayIndex, targetWeekStart });
      // AP0-Vorgabe: state.data/state.updatedAt nur uebernehmen, wenn die tatsaechlich
      // beschriebene Woche der aktuell geladenen entspricht (identische Begruendung wie beim
      // AP0-Ruecklauf/submitMealSlotRecipe() oben).
      if (res.targetWeekStart === state.weekStart) {
        state.data = res.data;
        state.data.goals = state.data.goals || [];
        state.data.highlights = state.data.highlights || [];
        state.data.calls = state.data.calls || [];
        state.updatedAt = res.updatedAt;
        state.dirty = false;
      }
      markIngredientAddedToList(sourceWeekStart, dayIndex, slotIndex, ingredientIndex);
    }
    mealSlotShoppingQueue = null;
    closeMealSlotDialog();
    flash(`Zutaten wurden der Einkaufsliste vom ${chosen.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })} hinzugefügt.`);
  } catch (err) {
    setStepError('msdShopDateError', err.message);
  } finally {
    $('#msdShopDateSubmit').disabled = false;
  }
}

// AP1.4: die kompakte Wochenzuweisungs-Tabelle (#recipeAssignTable/#recipeAssignWrap, vormals
// renderRecipeAssignHead()/buildAssignCellContent()/renderRecipeAssignBody()/
// renderRecipeAssignGrid()) sowie die Drag&Drop-Zuweisung selbst (recipeIdFromDrag()/
// registerAssignDropTarget()/handleRecipeDrop()/submitRecipeServings()/#recipeServingsDialog/
// pendingAssignment) sind ersatzlos entfernt -- siehe Kommentar bei #view-rezepte in index.html.
// Der Zell-Klick-Dialog aus AP1.2 (openMealSlotDialog()/submitMealSlotRecipe()) war seither der
// einzige NEUE Zuweisungsweg; die Korrektur bereits zugewiesener Rezepte lief zunaechst weiterhin
// inline in der Zelle (buildRecipeAssignToken()). AP1-Korrektur (siehe Kommentar dort): auch das
// ist inzwischen ersetzt -- openMealSlotRecipeCell() (weiter oben) uebernimmt diese Aufgabe jetzt
// ebenfalls ueber denselben Dialog.

/* ---------------- Rein clientseitige Markierung bereits auf eine Einkaufsliste uebernommener
   Zutaten (addedToListMarks) -- der Server dedupliziert bewusst nicht (siehe add-ingredient-to-
   list in server.js), die Markierung ist nur ein UX-Hinweis gegen versehentliche Mehrfachklicks
   und ueberlebt keinen Seitenneuladen. Gebraucht von renderMealSlotIngredientRows() (Checkbox-
   Anfangszustand) und submitMealSlotShopDate() (setzt die Markierung nach erfolgreicher
   Uebernahme). AP1-Korrektur: das fruehere Einzel-Zutat-Tag-Auswahl-Dialog-Paar
   (openIngredientToListDialog()/submitIngredientToList()/pendingIngredientToList/
   #ingredientToListDialog, AP4.2) ist ersatzlos entfernt -- der Wizard-eigene, batch-faehige
   Einkaufstag-Schritt (submitMealSlotShopDate()) deckt denselben Bedarf bereits ab, siehe
   Kommentar bei buildMealSlotRecipeDisplay() oben.
   AP2-Update: Schluessel um "weekStart" erweitert (vorher nur dayIndex:slotIndex:ingredientIndex)
   -- ohne Wochenbezug wuerde eine Markierung in der aktuellen Woche faelschlich auch fuer eine
   Zuweisung an derselben Tag/Mahlzeit/Zutat-Position in der naechsten Woche (oder umgekehrt)
   gelten, obwohl es zwei voellig unabhaengige Zuweisungen sind. ---------------- */
const addedToListMarks = new Set(); // Keys: "weekStart:dayIndex:slotIndex:ingredientIndex"
function ingredientMarkKey(weekStart, dayIndex, slotIndex, ingredientIndex) {
  return `${weekStart}:${dayIndex}:${slotIndex}:${ingredientIndex}`;
}
function isIngredientMarkedAddedToList(weekStart, dayIndex, slotIndex, ingredientIndex) {
  return addedToListMarks.has(ingredientMarkKey(weekStart, dayIndex, slotIndex, ingredientIndex));
}
function markIngredientAddedToList(weekStart, dayIndex, slotIndex, ingredientIndex) {
  addedToListMarks.add(ingredientMarkKey(weekStart, dayIndex, slotIndex, ingredientIndex));
}
// Wird gerufen, sobald der Zelleninhalt einer Zuweisung sich aendert (neues Rezept zugewiesen
// oder Zuweisung entfernt) -- die bisherigen ingredientIndex-basierten Markierungen wuerden sonst
// auf voellig andere Zutaten eines neuen Snapshots zeigen.
function clearIngredientListMarksFor(weekStart, dayIndex, slotIndex) {
  const prefix = `${weekStart}:${dayIndex}:${slotIndex}:`;
  Array.from(addedToListMarks).forEach(key => { if (key.startsWith(prefix)) addedToListMarks.delete(key); });
}

/* ---------------- Konto-Ansicht (AP2.2b, projects/wochenplaner-termine-verschluesselung/plan.md) ----------------
   Ersetzt die vormalige, zur Laufzeit erzeugte openMenu()-Funktion (<dialog class="acct-dialog">,
   siehe Git-Historie) -- dieselben fuenf Aktionen/dieselbe Logik, nur jetzt gegen das statische
   Markup der neuen Ansicht #view-konto (index.html) verdrahtet statt gegen ein dynamisch gebautes
   <dialog>. Wird EINMALIG aus boot() aufgerufen (nicht bei jedem Ansichtswechsel wie setSection()),
   da Name/E-Mail/Haushaltsname sich waehrend einer Sitzung nicht aendern (state.user, siehe boot()). */
function initAccountView() {
  $('#acctWho').textContent = `${state.user.name} · ${state.user.email} · Haushalt „${state.user.householdName}“`;
  const out = $('#acctOut');
  const showOut = msg => { out.textContent = msg; out.hidden = false; };
  $('#acctInvite').onclick = async () => {
    const { code } = await api('POST', '/api/invites');
    showOut(`Einladungscode: ${code} (14 Tage gültig)`);
  };
  $('#acctExport').onclick = () => { exportJSON(); showOut('Datei wurde heruntergeladen.'); };
  $('#acctImport').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json';
    inp.onchange = () => { if (inp.files[0]) importJSON(inp.files[0]); };
    inp.click();
  };
  $('#acctTemplateDel').onclick = async () => {
    await api('DELETE', '/api/template');
    showOut('Vorlage gelöscht.');
  };
  $('#acctLogout').onclick = async () => {
    await api('POST', '/api/auth/logout');
    // AP2.1: Haushalts-Schluessel aktiv aus dem Speicher entfernen, statt nur auf das Verschwinden
    // des JS-Kontexts beim Navigieren zu vertrauen -- selbst wenn ein Navigations-/Reload-Fehler
    // das Verlassen der Seite verzoegert, bleibt der Schluessel damit nicht laenger als noetig
    // im Speicher.
    WPCrypto.clearHouseholdKey();
    location.href = 'login.html';
  };

  // AP2.6: Passwort-Aendern/Wiederherstellungscode-Karten brauchen einen bereits entsperrten
  // Haushalts-Schluessel im Speicher (Re-Wrap-Prinzip) -- ohne einen eigenen, bereits bestehenden
  // password-Wrap gibt es schlicht nichts, was man neu verpacken koennte. Statt Formularfelder
  // unbrauchbar anzuzeigen, blenden wir beide Karten dann mit einer kurzen Erklaerung aus.
  //
  // Bugfix (Nutzer-Feedback 2026-09-06): urspruenglich wurde hier auf state.crypto.
  // encryptionStatus==='active' geprueft (Zustand des GESAMTEN Haushalts) statt auf
  // state.crypto.wrappedKey (Zustand DIESES Kontos). Das versteckte die Karten unnoetig auch
  // fuer das MITGLIED, das den AP2.3-Bootstrap bereits selbst abgeschlossen hat, waehrend der
  // Haushalt insgesamt noch auf 'activating' steht (zweites Mitglied hat noch nicht aktiviert) --
  // dieses Mitglied hat zu diesem Zeitpunkt aber bereits einen eigenen, gueltigen password-Wrap
  // und koennte ihn problemlos re-wrappen. Massgeblich ist daher wrappedKey (Konto-Ebene), nicht
  // encryptionStatus (Haushalts-Ebene) -- fuer ein Nachzuegler-Mitglied ganz ohne eigenen Wrap
  // (nur pendingWrap, siehe boot()) bleibt wrappedKey weiterhin null, die Karten bleiben also
  // korrekt ausgeblendet.
  const pwCard = $('#acctPwForm').closest('.card');
  const recoveryCard = $('#acctRecoveryRegen').closest('.card');
  if (!state.crypto?.wrappedKey) {
    pwCard.hidden = true;
    recoveryCard.hidden = true;
  } else {
    initAccountPasswordForm();
    initAccountRecoveryRegen();
  }
}

// AP2.6, Teil A: Passwort-Aenderung. Server prueft das ALTE Passwort weiterhin per bcrypt
// (bestehendes Verhalten) -- der Client leitet zusaetzlich aus dem NEUEN Passwort einen neuen
// Wrap-Schluessel ab und schickt nur den fertigen, neu gewrappten password-Wrap (ap1.2-
// datenmodell.md Abschnitt 7). Der Wiederherstellungscode bleibt davon vollstaendig unberuehrt.
function initAccountPasswordForm() {
  const form = $('#acctPwForm');
  const errEl = $('#acctPwError');
  form.onsubmit = async ev => {
    ev.preventDefault();
    errEl.hidden = true;
    const oldPassword = $('#pwCurrent').value;
    const newPassword = $('#pwNew').value;
    const newPassword2 = $('#pwConfirm').value;
    if (newPassword !== newPassword2) {
      errEl.textContent = 'Die beiden neuen Passwörter stimmen nicht überein.';
      errEl.hidden = false;
      return;
    }
    $('#acctPwSubmit').disabled = true;
    try {
      const kdfParams = WPCrypto.defaultKdfParams();
      const newSalt = await WPCrypto.generateSalt();
      const newWrapKey = await WPCrypto.deriveWrapKey(newPassword, newSalt, kdfParams);
      const newWrapped = await WPCrypto.wrapKey(WPCrypto.getHouseholdKey(), newWrapKey);
      await api('PUT', '/api/account/password', {
        oldPassword, newPassword,
        passwordWrap: {
          wrappedKey: WPCrypto.toB64(newWrapped.wrappedKey), wrapNonce: WPCrypto.toB64(newWrapped.nonce),
          kdfSalt: WPCrypto.toB64(newSalt), kdfAlgo: kdfParams.algo,
          kdfTimeCost: kdfParams.opslimit, kdfMemoryCost: kdfParams.memlimit, kdfParallelism: kdfParams.parallelism
        }
      });
      form.reset();
      flash('Passwort erfolgreich geändert.');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      $('#acctPwSubmit').disabled = false;
    }
  };
}

// Zeigt einen (neu erzeugten) Wiederherstellungscode EINMALIG an -- gemeinsam genutzt von
// initAccountRecoveryRegen() (freiwillig, ueber die Konto-Ansicht) und
// forceRecoveryCodeRegeneration() (zwingend nach einem Passwort-Reset, siehe boot()). Identisches
// Blockier-Muster wie login.js/showRecoveryCodeOnce(): kein Abbrechen vor Bestaetigung.
function showRecoveryCodeOnce(code) {
  return new Promise(resolve => {
    const dlg = $('#recoveryCodeDialog');
    $('#recoveryCodeOut').textContent = code;
    const checkbox = $('#recoveryCodeConfirm');
    const btn = $('#recoveryCodeContinue');
    checkbox.checked = false;
    btn.disabled = true;
    checkbox.onchange = () => { btn.disabled = !checkbox.checked; };
    const onCancel = ev => ev.preventDefault();
    dlg.addEventListener('cancel', onCancel);
    btn.onclick = () => {
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
      resolve();
    };
    dlg.showModal();
  });
}

// Erzeugt einen komplett NEUEN Wiederherstellungscode fuer den Haushalt und macht den alten damit
// ungueltig (ZANDORs Vorgabe 3: nie still/automatisch, immer ein expliziter, vom Nutzer
// ausgeloester Vorgang mit sofortiger einmaliger Anzeige). Der bestehende Haushalts-Schluessel
// bleibt dabei unveraendert -- nur seine "Verpackung" fuer den Wiederherstellungscode wird
// ersetzt, identisch zum Passwort-Re-Wrap-Prinzip.
async function regenerateRecoveryCode() {
  const kdfParams = WPCrypto.defaultKdfParams();
  const recoveryCode = await WPCrypto.generateRecoveryCode();
  const normalized = WPCrypto.normalizeRecoveryCode(recoveryCode);

  const rcSalt = await WPCrypto.generateSalt();
  const rcWrapKey = await WPCrypto.deriveWrapKey(normalized, rcSalt, kdfParams);
  const rcWrap = await WPCrypto.wrapKey(WPCrypto.getHouseholdKey(), rcWrapKey);

  const verifierSalt = await WPCrypto.generateSalt();
  const verifier = await WPCrypto.deriveWrapKey(normalized, verifierSalt, kdfParams);

  await api('POST', '/api/crypto/recovery-code', {
    recoveryWrap: {
      wrappedKey: WPCrypto.toB64(rcWrap.wrappedKey), wrapNonce: WPCrypto.toB64(rcWrap.nonce),
      kdfSalt: WPCrypto.toB64(rcSalt), kdfAlgo: kdfParams.algo,
      kdfTimeCost: kdfParams.opslimit, kdfMemoryCost: kdfParams.memlimit, kdfParallelism: kdfParams.parallelism
    },
    recoveryVerifier: { verifierSalt: WPCrypto.toB64(verifierSalt), verifier: WPCrypto.toB64(verifier) }
  });
  await showRecoveryCodeOnce(recoveryCode);
}

function initAccountRecoveryRegen() {
  const btn = $('#acctRecoveryRegen');
  const out = $('#acctRecoveryOut');
  btn.onclick = async () => {
    if (!confirm('Einen neuen Wiederherstellungscode erzeugen? Der bisherige Code wird dabei für den gesamten Haushalt sofort ungültig.')) return;
    btn.disabled = true;
    try {
      await regenerateRecoveryCode();
      out.textContent = 'Neuer Wiederherstellungscode erzeugt.';
      out.hidden = false;
    } catch (err) {
      out.textContent = 'Fehler: ' + err.message;
      out.hidden = false;
    } finally {
      btn.disabled = false;
    }
  };
}

// AP2.6, Teil B (ZANDORs Vorgabe 3): direkt nach einem erfolgreichen Passwort-Reset via
// Wiederherstellungscode (login.js) hinterlaesst login.js einen harmlosen Merker in localStorage
// (KEIN Schluesselmaterial, siehe dortiger Kommentar) -- beim naechsten normalen Login wird der
// Nutzer dadurch HIER zwingend zur Neu-Erzeugung des Codes aufgefordert, bevor die App normal
// nutzbar wird (keine stille/automatische Rotation, siehe ap1.2-datenmodell.md Abschnitt 7a).
async function forceRecoveryCodeRegenerationIfNeeded() {
  const marker = localStorage.getItem('wp_force_recovery_regen');
  if (!marker || marker !== state.user.email) return;
  alert('Du hast dein Passwort gerade über den Wiederherstellungscode zurückgesetzt. Aus Sicherheitsgründen ' +
    'muss jetzt ein neuer Wiederherstellungscode erzeugt werden, bevor es weitergeht.');
  await regenerateRecoveryCode();
  localStorage.removeItem('wp_force_recovery_regen');
}

/* ---------------- Start ---------------- */
function setView(view) {
  if (state.data) syncFromDOM();
  state.view = view;
  document.body.classList.toggle('view-day', view === 'day');
  $('#btnView').textContent = view === 'day' ? 'Wochenansicht' : 'Tagesansicht';
  if (state.data) renderAll();
}

async function boot() {
  injectSprite();
  buildPalette();
  buildLegend();

  const me = await api('GET', '/api/me');
  state.user = me.user;
  state.crypto = me.crypto;
  $('#householdName').textContent = me.user.householdName;
  initAccountView(); // AP2.2b: einmalige Verdrahtung der neuen Konto-Ansicht, siehe dortiger Kommentar

  // AP2.1/AP2.3: index.html ist ein eigenes Dokument/JS-Kontext gegenueber login.html -- der
  // Haushalts-Schluessel kann daher nicht "mitgebracht" werden (siehe Kommentar bei
  // #unlockDialog). Drei sich gegenseitig ausschliessende Faelle, siehe /api/me:
  //  1. state.crypto.encryptionStatus==='plaintext': Bestandshaushalt, der die Verschluesselung
  //     ueberhaupt noch nicht aktiviert hat -- Bootstrap-Fluss (AP2.3).
  //  2. state.crypto.wrappedKey vorhanden: dieses Konto hat bereits einen eigenen password-Wrap
  //     (frisch registrierter Haushalt ODER bereits aktiviertes/aktivierendes Bestandsmitglied) --
  //     normales Entsperren wie in AP2.1.
  //  3. state.crypto.pendingWrap vorhanden (aber kein wrappedKey): Nachzuegler-Mitglied eines
  //     bereits von einem ANDEREN Mitglied aktivierten Haushalts -- Aktivierungs-Fluss (AP2.3).
  // Ohne einen dieser drei Zustaende bleibt der Haushalt plaintext und keiner der Dialoge wird
  // gezeigt (unveraendertes Verhalten wie vor AP2.1).
  if (state.crypto?.encryptionStatus === 'plaintext') {
    await promptBootstrapExisting();
  } else if (state.crypto?.wrappedKey) {
    await promptUnlock();
  } else if (state.crypto?.pendingWrap) {
    await promptActivatePending();
  }

  // AP2.6: siehe Kommentar bei forceRecoveryCodeRegenerationIfNeeded() -- muss NACH dem Entsperren
  // (Haushalts-Schluessel im Speicher) und VOR dem Sweep laufen (ein noch gueltiger Wrap ist keine
  // Voraussetzung fuer den Sweep, aber die Reihenfolge "erst Sicherheit, dann Komfort" ist hier
  // bewusst so gewaehlt).
  if (WPCrypto.hasHouseholdKey()) {
    await forceRecoveryCodeRegenerationIfNeeded();
  }

  // AP2.5: nicht-blockierender Sweep im Hintergrund -- ausschliesslich, wenn WIRKLICH jedes
  // Mitglied bereits einen Wrap hat (encryption_status==='active', ap1.2-datenmodell.md
  // Abschnitt 4.2 Schritt 4). Bei 'activating' wuerde ein noch nicht aktiviertes Mitglied sonst
  // von einer zwischenzeitlich verschluesselten Altwoche ausgesperrt.
  if (state.crypto?.encryptionStatus === 'active') {
    runEncryptionSweep().catch(err => console.error('AP2.5-Sweep konnte nicht gestartet werden:', err));
  }

  if (window.matchMedia('(max-width: 900px)').matches) { setView('day'); state.day = (new Date().getDay() + 6) % 7; }

  await loadWeek(isoOf(toMonday(new Date())));
  await refreshArchive();
  await loadRecipes(); // AP2.2: haushaltsweit, unabhaengig von der geladenen Woche

  initMealPlanToolbar();
  initFocusBlocks();

  // AP1.2: "data-mealcell" ist mit dem Wegfall der contentEditable-Essensplan-Zellen entfallen
  // (siehe buildMealCellDisplay()/Kommentar in syncFromDOM()) -- nicht mehr Teil dieser Liste.
  document.addEventListener('input', e => {
    if (e.target.closest?.('[data-cell],[data-label],[data-role],[data-bind]')) markDirty();
  });
  // AP7.1-Korrektur (projects/wochenplaner-design-nacharbeiten/plan.md, Nutzer-Feedback nach
  // Live-Test): der globale, prominente #btnPrint bleibt an seiner Position (siehe index.html,
  // ".print-page"-Sichtbarkeit), druckt aber jetzt kontextsensitiv je nach aktuell sichtbarer
  // Seite -- auf "Essen & Kochen" den Essensplan (derselbe body.printing-mealplan-Mechanismus,
  // den zuvor der inzwischen entfernte, seiteneigene #mpPrint-Button exklusiv nutzte), sonst
  // unveraendert den Hauptraster. document.body.dataset.section wird von setSection() bei jedem
  // Ansichtswechsel aktuell gehalten (siehe dort), daher hier einfach direkt abgefragt.
  $('#btnPrint').onclick = () => {
    syncFromDOM();
    if (document.body.dataset.section === 'essen') {
      document.body.classList.add('printing-mealplan');
    } else {
      renderSheet();
    }
    window.print();
  };
  $('#btnPrev').onclick = () => loadWeek(addDays(state.weekStart, -7));
  $('#btnNext').onclick = () => loadWeek(addDays(state.weekStart, 7));
  $('#btnToday').onclick = () => loadWeek(isoOf(toMonday(new Date())));
  $('#monday').onchange = e => { if (e.target.value) loadWeek(isoOf(toMonday(parseISO(e.target.value)))); };
  $('#archive').onchange = e => { if (e.target.value) loadWeek(e.target.value); };
  $('#btnTemplateApply').onclick = () => applyTemplate().catch(err => flash(err.message));
  $('#btnTemplateSave').onclick = () => saveTemplate().catch(err => flash(err.message));
  $('#btnAddPerson').onclick = () => { syncFromDOM(); state.data.rows.push({ kind: 'person', label: 'Name', role: '', cells: Array.from({ length: 7 }, () => []) }); renderAll(); markDirty(); };
  $('#btnAddShared').onclick = () => { syncFromDOM(); state.data.rows.push({ kind: 'shared', label: 'Neue Zeile', role: '', cells: Array.from({ length: 7 }, () => []) }); renderAll(); markDirty(); };
  $('#btnView').onclick = () => setView(state.view === 'sheet' ? 'day' : 'sheet');
  $('#btnIcons').onclick = () => document.body.classList.toggle('palette-open');
  // AP2.2b: #btnMenu ("Konto") hat jetzt wie die uebrigen vier Menuepunkte ein "data-view"
  // (index.html) und wird daher bereits ueber die generische Schleife direkt darunter bedient --
  // kein eigener onclick-Handler mehr noetig (die frueher hier stehende Zuweisung an openMenu()
  // ist mit deren Entfernen entfallen).

  document.querySelectorAll('.app-nav .nav-btn').forEach(btn => {
    btn.addEventListener('click', () => setSection(btn.dataset.view));
  });

  $('#dlClose').onclick = closeDayList;
  // AP2.1: Klick auf den nativen ::backdrop registriert sich als Klick auf das <dialog>-Element
  // SELBST (e.target === dlg), da alle Nachfahren-Elemente (Kopf/Body/Buttons) das Ereignis
  // stoppen wuerden, sofern sie getroffen sind -- ein Treffer direkt auf "daylist" bedeutet also
  // zuverlaessig "ausserhalb der Karte geklickt", identisches Verhalten wie zuvor beim div-Overlay.
  $('#daylist').addEventListener('click', e => { if (e.target.id === 'daylist') closeDayList(); });
  // "close"-Ereignis (native dialog-API) greift fuer JEDEN Schliessweg (Button, ESC-Taste,
  // Backdrop-Klick via obigem Handler) -- Badges im Raster/in der Tagesansicht aktualisieren,
  // falls Eintraege geaendert wurden. Vorher nur beim Button-Klick moeglich (ESC schloss die
  // fruehere reine div-Overlay-Loesung gar nicht).
  $('#daylist').addEventListener('close', () => { renderAll(); });
  // Hochformat fuer den Ausdruck der Tagesliste kommt rein statisch aus der benannten
  // @page-Regel "daylist-print" in style.css (aktiviert ueber .daylist{page:daylist-print}
  // sobald body.printing-daylist gesetzt ist) — keine Laufzeit-Style-Injektion noetig/erlaubt.
  $('#dlPrint').onclick = () => { syncFromDOM(); document.body.classList.add('printing-daylist'); window.print(); };

  // AP7.1-Korrektur: #mpPrint (eigener Essensplan-Drucken-Button in #view-essen) ist entfallen --
  // seine Drucklogik (syncFromDOM()+body.printing-mealplan+window.print()) lebt jetzt im
  // kontextsensitiven #btnPrint-Handler oben, keine eigene Verdrahtung hier mehr noetig.

  // AP1.2: Zell-Klick-Dialog (#mealSlotDialog) -- ein Klick auf die 5 Optionen wird per
  // Event-Delegation auf dem Container abgefangen (die Buttons werden nicht dynamisch neu
  // erzeugt, ein einziger Listener genuegt). Gleiches Schliess-/Backdrop-/close-Event-Muster wie
  // alle uebrigen Overlays der App (#daylist/#recipeForm/...): der "close"-Handler deckt JEDEN
  // Schliessweg ab (Button, ESC, Backdrop-Klick) und ruft syncFromDOM()/renderAll() -- exakt die
  // vom Auftrag geforderte Konsistenz mit den 4 einfachen Faellen, die selbst KEINEN eigenen
  // renderAll()-Aufruf brauchen (schreiben direkt in state.data, das "close"-Ereignis erledigt den
  // Rest einheitlich fuer alle 5 Optionen).
  $('#mealSlotDialog').querySelector('.msd-options').addEventListener('click', e => {
    const btn = e.target.closest('.msd-option');
    if (btn) handleMealSlotOption(btn.dataset.option);
  });
  $('#msdTextForm').addEventListener('submit', submitMealSlotText);
  $('#msdTextBack').onclick = () => mealSlotShowStep('msdStepOptions');
  $('#msdRecipePickBack').onclick = () => mealSlotShowStep('msdStepOptions');
  // AP1-Korrektur: "Zurueck" ist kontextabhaengig -- kam der Rezeptdetails-Schritt ueber
  // openMealSlotRecipeCell() (Bearbeiten einer bereits zugewiesenen Zelle, kein Options-/
  // Rezeptauswahl-Schritt dazwischen), fuehrt "Zurueck" zu den 5 Optionen (ermoeglicht z. B. auch
  // einen Wechsel zu Freitext/Außerhalb oder -- ueber "Rezeptkarte" erneut -- ein anderes Rezept);
  // kam er ueber die normale Neuzuweisungs-Kette (Optionen -> Rezeptauswahl -> Details), fuehrt
  // "Zurueck" wie bisher zur Rezeptauswahl zurueck.
  $('#msdRecipeDetailBack').onclick = () => {
    mealSlotRecipe = null;
    if (mealSlotEditingRecipeCell && mealSlotContext) {
      // AP2: weekStart/isNextWeek des BISHERIGEN Kontexts explizit mitgeben -- ohne weekCtx
      // wuerde primeMealSlotOptionsStep() auf state.weekStart/isNextWeek:false zurueckfallen und
      // damit bei einer Zelle der naechsten Woche faelschlich in die aktuelle Woche "zurueckspringen".
      const { meal, mi, d, weekStart, isNextWeek } = mealSlotContext;
      primeMealSlotOptionsStep(meal, mi, d, { weekStart, isNextWeek });
    } else {
      mealSlotShowStep('msdStepRecipePick');
    }
  };
  // AP1-Korrektur: Direktes Entfernen der Zuweisung, ohne den Umweg ueber "Zurueck" -> Optionen ->
  // "Nicht geplant" (das laesst eine bestehende Zuweisung bewusst UNVERAENDERT, siehe
  // handleMealSlotOption()) -- entspricht dem frueheren Entfernen-Button direkt in der Zelle
  // (buildRecipeAssignToken(), jetzt entfernt). Nur sichtbar, wenn eine bereits bestehende
  // Zuweisung bearbeitet wird (siehe openMealSlotRecipeCell()/openMealSlotRecipeDetail()).
  // AP2: applyMealSlotTokens([]) statt direkter Mutation -- dieselbe Funktion, die auch die 4
  // einfachen Optionen nutzen, damit "Entfernen" fuer die naechste Woche automatisch denselben
  // gezielten set-meal-cell-Schreibpfad nimmt statt state.data/markDirty() zu beruehren.
  $('#msdRecipeRemove').onclick = () => { applyMealSlotTokens([]); };
  $('#msdRecipeDetailForm').addEventListener('submit', submitMealSlotRecipe);
  $('#msdShopDateForm').addEventListener('submit', submitMealSlotShopDate);
  $('#msdClose').onclick = closeMealSlotDialog;
  $('#mealSlotDialog').addEventListener('click', e => { if (e.target.id === 'mealSlotDialog') closeMealSlotDialog(); });
  $('#mealSlotDialog').addEventListener('close', () => {
    syncFromDOM();
    renderAll();
    mealSlotContext = null;
    mealSlotRecipe = null;
    mealSlotShoppingQueue = null;
    mealSlotEditingRecipeCell = false;
  });

  // AP2.2: Rezeptkarten-Ansicht + Anlegen-/Bearbeiten-Formular.
  $('#btnRecipeNew').onclick = () => openRecipeForm(null);
  $('#rfIngredientAdd').onclick = () => {
    const count = document.querySelectorAll('#rfIngredients [data-ingredient-row]').length;
    if (count >= RECIPE_LIMITS.ingredients) { flash(`Maximal ${RECIPE_LIMITS.ingredients} Zutaten möglich.`); return; }
    addIngredientRow();
  };
  $('#rfForm').addEventListener('submit', submitRecipeForm);
  $('#rfClose').onclick = () => $('#recipeForm').close();
  // Backdrop-Klick schliesst, identisches Muster wie bei #daylist/#mealplan oben (ein Treffer
  // direkt auf das <dialog>-Element selbst bedeutet "ausserhalb der Karte geklickt").
  $('#recipeForm').addEventListener('click', e => { if (e.target.id === 'recipeForm') $('#recipeForm').close(); });

  // AP2.1/AP2.2 (projects/wochenplaner-rezeptkarten-drucken/plan.md): Druck-"Dialog" fuer eine
  // einzelne Rezeptkarte -- gleiches Bedienmuster wie #dlPrint (Tagesliste, siehe oben): der
  // Vorschau-Container ist bereits mit dem gewaehlten Rezept befuellt (openRecipePrint()),
  // "Drucken" setzt nur noch die Sichtbarkeits-Klasse und ruft window.print() (Layout kommt rein
  // statisch aus @page recipe-print in style.css -- keine Laufzeit-Style-Injektion noetig/
  // erlaubt, siehe CSP). #recipePrint ist seit dem Mehrseitendruck-Fix (Nutzer-Test mit
  // Testrezept ID 8, siehe Kommentar bei openRecipePrint()) ein normales <div> statt eines
  // <dialog> -- Schliessen laeuft daher ueber closeRecipePrint() (Klasse entfernen) statt der
  // nativen dialog.close()-Methode, ESC-Taste ebenfalls manuell nachgebildet (kein natives
  // <dialog>-ESC-Verhalten mehr vorhanden).
  $('#rpPrintBtn').onclick = () => { document.body.classList.add('printing-recipe'); window.print(); };
  $('#rpClose').onclick = closeRecipePrint;
  // Backdrop-Klick schliesst -- #recipePrint selbst ist jetzt die volle Ueberlagerungsflaeche
  // (siehe style.css), ein Treffer direkt darauf (statt auf ein Nachfahren-Element wie
  // .recipe-print-card) bedeutet weiterhin "ausserhalb der Karte geklickt".
  $('#recipePrint').addEventListener('click', e => { if (e.target.id === 'recipePrint') closeRecipePrint(); });
  // ESC schliesst -- musste bei #daylist/#recipeForm nicht extra verdrahtet werden (natives
  // <dialog>-Verhalten), fehlt hier aber, seit #recipePrint kein <dialog> mehr ist.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#recipePrint').classList.contains('open')) closeRecipePrint();
  });

  // AP1.4: #recipeServingsDialog/submitRecipeServings()/handleRecipeDrop() (Drag&Drop-Zuweisung)
  // sind ersatzlos entfernt -- keine Verdrahtung mehr noetig.
  // AP1-Korrektur: #ingredientToListDialog/submitIngredientToList()/closeIngredientToListDialog()
  // (AP4.2, Einzel-Zutat-Tagesauswahl nach Checkbox-Klick in der jetzt entfernten
  // buildRecipeAssignToken()) sind ebenfalls ersatzlos entfernt -- der Wizard-eigene
  // Einkaufstag-Schritt (#msdShopDateForm, siehe oben) deckt denselben Bedarf batch-faehig ab.

  window.addEventListener('beforeprint', () => { if (state.view === 'day') { syncFromDOM(); renderSheet(); } });
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing-daylist');
    document.body.classList.remove('printing-mealplan');
    document.body.classList.remove('printing-recipe');
  });
  window.addEventListener('beforeunload', e => {
    if (!state.dirty) return;
    syncFromDOM();
    fetch(`/api/weeks/${state.weekStart}`, {
      method: 'PUT', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: state.data, baseUpdatedAt: state.updatedAt })
    });
    e.preventDefault(); e.returnValue = '';
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.dirty) save(); });
}

boot().catch(err => { console.error(err); setStatus('Fehler beim Laden', 'error'); });
