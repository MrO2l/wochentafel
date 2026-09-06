const $ = s => document.querySelector(s);
const msg = (text, cls) => { const m = $('#msg'); m.textContent = text; m.className = 'msg ' + cls; };
let inviteMode = false;

/* AP0.4: Tab-Umschaltung (role="tab"/aria-selected/Panel-Sichtbarkeit/Tastaturnavigation) uebernimmt
   jetzt Bootstraps native Tab-Komponente (data-bs-toggle="tab" im Markup, siehe login.html) --
   dieses Skript reagiert nur noch auf das von ihr ausgeloeste "shown.bs.tab"-Ereignis, um die
   eigene App-Logik (Fehlermeldung zuruecksetzen, inviteMode-Flag) synchron zu halten. Bewusst NICHT
   mehr an "click" gebunden: ein per Pfeiltaste/Home/End angesteuerter Tab wird von Bootstrap ohne
   echtes Klick-Ereignis aktiviert -- eine reine Klick-Bindung wuerde bei Tastaturbedienung
   unbemerkt aus dem Tritt geraten (z.B. inviteMode faelschlich auf dem alten Stand bleiben). */
$('#tabLogin').addEventListener('shown.bs.tab', () => { $('#msg').className = 'msg'; });
$('#tabRegister').addEventListener('shown.bs.tab', () => { $('#msg').className = 'msg'; });
$('#tabRecover').addEventListener('shown.bs.tab', () => { $('#msg').className = 'msg'; });
$('#modeNew').addEventListener('shown.bs.tab', () => { inviteMode = false; });
$('#modeInvite').addEventListener('shown.bs.tab', () => { inviteMode = true; });

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                 body: JSON.stringify(body), credentials: 'same-origin' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Es hat nicht geklappt');
  return json;
}

$('#formLogin').onsubmit = async e => {
  e.preventDefault();
  try { await post('/api/auth/login', { email: $('#le').value, password: $('#lp').value }); location.href = 'index.html'; }
  catch (err) { msg(err.message, 'err'); }
};

/* ---------------- AP2.1: Verschluesselungs-Bootstrap bei der Registrierung ----------------
 * Nur fuer den Zweig "Neuer Haushalt" (kein Einladungscode) -- Bootstrap fuer ein Mitglied, das
 * einer bereits verschluesselten Bestandsfamilie beitritt, ist AP2.3 (separates Arbeitspaket,
 * server.js weist das mit einer klaren Fehlermeldung ab, siehe dortiger Kommentar).
 *
 * Reihenfolge bewusst: ALLES Kryptografische (Haushalts-Schluessel, beide Wraps, Wieder-
 * herstellungscode) entsteht HIER, bevor der Server ueberhaupt kontaktiert wird -- der Server
 * bekommt nur das fertige Ergebnis (Ciphertext-Bytes), nie den Haushalts-Schluessel, das Passwort-
 * abgeleitete Zwischenergebnis oder den Wiederherstellungscode selbst.
 */
async function buildCryptoBootstrap(password) {
  await WPCrypto.ready;
  const householdKey = await WPCrypto.generateHouseholdKey();

  const pwSalt = await WPCrypto.generateSalt();
  const kdfParams = WPCrypto.defaultKdfParams();
  const pwWrapKey = await WPCrypto.deriveWrapKey(password, pwSalt, kdfParams);
  const pwWrap = await WPCrypto.wrapKey(householdKey, pwWrapKey);

  const recoveryCode = await WPCrypto.generateRecoveryCode();
  const rcSalt = await WPCrypto.generateSalt();
  const rcWrapKey = await WPCrypto.deriveWrapKey(WPCrypto.normalizeRecoveryCode(recoveryCode), rcSalt, kdfParams);
  const rcWrap = await WPCrypto.wrapKey(householdKey, rcWrapKey);

  return {
    recoveryCode,
    crypto: {
      passwordWrap: { wrappedKey: WPCrypto.toB64(pwWrap.wrappedKey), wrapNonce: WPCrypto.toB64(pwWrap.nonce),
        kdfSalt: WPCrypto.toB64(pwSalt), kdfAlgo: kdfParams.algo,
        kdfTimeCost: kdfParams.opslimit, kdfMemoryCost: kdfParams.memlimit, kdfParallelism: kdfParams.parallelism },
      recoveryWrap: { wrappedKey: WPCrypto.toB64(rcWrap.wrappedKey), wrapNonce: WPCrypto.toB64(rcWrap.nonce),
        kdfSalt: WPCrypto.toB64(rcSalt), kdfAlgo: kdfParams.algo,
        kdfTimeCost: kdfParams.opslimit, kdfMemoryCost: kdfParams.memlimit, kdfParallelism: kdfParams.parallelism }
    }
  };
}

// Zeigt den Wiederherstellungscode EINMALIG an und blockiert das Weiterklicken, bis die Checkbox
// bestaetigt "gespeichert" wurde -- weder ESC noch Backdrop-Klick duerfen den Dialog vorher
// schliessen (cancel-Event abgefangen), sonst koennte der Code versehentlich uebersehen werden.
function showRecoveryCodeOnce(code) {
  return new Promise(resolve => {
    const dlg = $('#recoveryCodeDialog');
    $('#recoveryCodeOut').textContent = code;
    const checkbox = $('#recoveryCodeConfirm');
    const btn = $('#recoveryCodeContinue');
    checkbox.checked = false;
    btn.disabled = true;
    checkbox.onchange = () => { btn.disabled = !checkbox.checked; };
    const onCancel = ev => ev.preventDefault(); // ESC blockieren
    dlg.addEventListener('cancel', onCancel);
    btn.onclick = () => {
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
      resolve();
    };
    dlg.showModal();
  });
}

$('#formRegister').onsubmit = async e => {
  e.preventDefault();
  const password = $('#rp').value;
  const body = { name: $('#rn').value, email: $('#re').value, password };
  if (inviteMode) {
    body.inviteCode = $('#ri').value.trim().toUpperCase();
  } else {
    body.householdName = $('#rh').value.trim() || ('Haushalt ' + $('#rn').value);
    try {
      const bootstrap = await buildCryptoBootstrap(password);
      body.crypto = bootstrap.crypto;
      body._recoveryCode = bootstrap.recoveryCode; // nur lokal verwendet, siehe unten -- NIE Teil des Requests
    } catch (err) {
      msg('Verschluesselung konnte nicht vorbereitet werden: ' + err.message, 'err');
      return;
    }
  }
  const recoveryCode = body._recoveryCode;
  delete body._recoveryCode;
  try {
    const result = await post('/api/auth/register', body);
    if (result.householdEncrypted && recoveryCode) {
      await showRecoveryCodeOnce(recoveryCode);
    }
    location.href = 'index.html';
  }
  catch (err) { msg(err.message, 'err'); }
};

/* ---------------- AP2.1: Wiederherstellungscode-Testfluss (rein lokal, siehe login.html) ---------------- */
$('#formRecover').onsubmit = async e => {
  e.preventDefault();
  const email = $('#cve').value.trim().toLowerCase();
  const codeInput = WPCrypto.normalizeRecoveryCode($('#cvc').value);
  msg('Prüfe …', '');
  try {
    const res = await fetch('/api/auth/recover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }), credentials: 'same-origin'
    });
    const wrapInfo = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(wrapInfo.error || 'Wiederherstellungscode konnte nicht geprüft werden');

    await WPCrypto.ready;
    const kdfParams = {
      algo: wrapInfo.kdfAlgo, opslimit: wrapInfo.kdfTimeCost, memlimit: wrapInfo.kdfMemoryCost,
      parallelism: wrapInfo.kdfParallelism
    };
    const wrapKeyBytes = await WPCrypto.deriveWrapKey(codeInput, WPCrypto.fromB64(wrapInfo.kdfSalt), kdfParams);
    let householdKey;
    try {
      householdKey = await WPCrypto.unwrapKey(
        WPCrypto.fromB64(wrapInfo.wrappedKey), WPCrypto.fromB64(wrapInfo.wrapNonce), wrapKeyBytes);
    } catch {
      msg('Dieser Wiederherstellungscode passt nicht zu dieser E-Mail-Adresse (oder ist falsch eingegeben).', 'err');
      return;
    }

    if (wrapInfo.sample) {
      try {
        const decrypted = await WPCrypto.decryptJSON(householdKey, wrapInfo.sample.nonce, wrapInfo.sample.ciphertext);
        const rowCount = Array.isArray(decrypted.rows) ? decrypted.rows.length : 0;
        msg(`Wiederherstellungscode ist korrekt: der Haushalts-Schlüssel wurde entsperrt und die Woche ` +
            `ab ${wrapInfo.sample.weekStart} (${rowCount} Zeilen) konnte erfolgreich entschlüsselt werden. ` +
            `Termine sind damit wieder lesbar.`, 'ok');
      } catch {
        msg('Der Wiederherstellungscode hat den Haushalts-Schlüssel entsperrt, aber die Test-Woche konnte ' +
            'nicht entschlüsselt werden (unerwartet -- bitte melden).', 'err');
      }
    } else {
      msg('Wiederherstellungscode ist korrekt: der Haushalts-Schlüssel wurde entsperrt. ' +
          '(Für diesen Haushalt liegt noch keine verschlüsselte Woche vor, daher kein Datenbeispiel.)', 'ok');
    }
  } catch (err) {
    msg(err.message, 'err');
  }
};

fetch('/api/config').then(r => r.json()).then(cfg => {
  if (!cfg.allowRegistration) {
    $('#tabRegister').disabled = true;
    $('#regHint').textContent = 'Neue Konten sind auf diesem Server deaktiviert. Lass dich von einem Familienmitglied einladen.';
  }
});
fetch('/api/me', { credentials: 'same-origin' }).then(r => { if (r.ok) location.href = 'index.html'; });
