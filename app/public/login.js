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
  const normalizedCode = WPCrypto.normalizeRecoveryCode(recoveryCode);
  const rcSalt = await WPCrypto.generateSalt();
  const rcWrapKey = await WPCrypto.deriveWrapKey(normalizedCode, rcSalt, kdfParams);
  const rcWrap = await WPCrypto.wrapKey(householdKey, rcWrapKey);

  // AP2.6 (ap1.2-datenmodell.md Abschnitt 2.2a, MORROW/ZANDOR): zweiter, von wrap_key
  // UNABHAENGIGER Argon2id-Output DESSELBEN Codes -- eigenes Salt (Domain-Separation), sonst
  // identische Kostenparameter. Dieser "verifier" ist der EINZIGE der vier hier erzeugten Werte,
  // der jemals (roh, per TLS) den Browser verlaesst -- beim Passwort-Reset, siehe login.js weiter
  // unten. Der Server hasht ihn selbst (SHA-256) und kann damit spaeter die Code-Kenntnis pruefen,
  // ohne wrap_key oder den Haushalts-Schluessel je zu sehen.
  const verifierSalt = await WPCrypto.generateSalt();
  const verifier = await WPCrypto.deriveWrapKey(normalizedCode, verifierSalt, kdfParams);

  return {
    recoveryCode,
    crypto: {
      passwordWrap: { wrappedKey: WPCrypto.toB64(pwWrap.wrappedKey), wrapNonce: WPCrypto.toB64(pwWrap.nonce),
        kdfSalt: WPCrypto.toB64(pwSalt), kdfAlgo: kdfParams.algo,
        kdfTimeCost: kdfParams.opslimit, kdfMemoryCost: kdfParams.memlimit, kdfParallelism: kdfParams.parallelism },
      recoveryWrap: { wrappedKey: WPCrypto.toB64(rcWrap.wrappedKey), wrapNonce: WPCrypto.toB64(rcWrap.nonce),
        kdfSalt: WPCrypto.toB64(rcSalt), kdfAlgo: kdfParams.algo,
        kdfTimeCost: kdfParams.opslimit, kdfMemoryCost: kdfParams.memlimit, kdfParallelism: kdfParams.parallelism },
      recoveryVerifier: { verifierSalt: WPCrypto.toB64(verifierSalt), verifier: WPCrypto.toB64(verifier) }
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

/* ---------------- AP2.6: Passwort-Reset via Wiederherstellungscode (ap1.2-datenmodell.md
 * Abschnitt 7a) ----------------
 * Schritt 1 (dieser Handler): rein lokal -- POST /api/auth/recover liefert die AEAD-geschuetzten
 * Wrap-Felder + recoveryVerifierSalt (NICHT recovery_verifier_hash, der bleibt server-intern).
 * Der Client entpackt lokal den Haushalts-Schluessel (wirft bei falschem Code automatisch, kein
 * Server-Roundtrip fuer DIESE Pruefung noetig) und leitet zusaetzlich den "verifier" ab (zweiter,
 * unabhaengiger Argon2id-Output desselben Codes, eigenes Salt). Schritt 2 (siehe
 * #recoverStep2Submit unten) sendet ausschliesslich diesen verifier (nie den Code selbst, nie
 * wrap_key, nie den Haushalts-Schluessel) an POST /api/auth/password-reset.
 */
let recoverState = null; // { email, householdKey, verifier } -- ausschliesslich zwischen Schritt 1 und 2 gehalten

$('#formRecover').onsubmit = async e => {
  e.preventDefault();
  const email = $('#cve').value.trim().toLowerCase();
  const codeInput = WPCrypto.normalizeRecoveryCode($('#cvc').value);
  msg('Prüfe …', '');
  $('#recoverStep1Submit').disabled = true;
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

    // Zweiter, unabhaengiger Argon2id-Output desselben Codes (eigenes Salt) -- das ist der Wert,
    // den Schritt 2 an den Server schickt. Die lokale AEAD-Unwrap-Pruefung oben ist bereits der
    // vollstaendige Nachweis "Code korrekt" fuer den Nutzer -- der verifier dient ausschliesslich
    // dazu, dass der SERVER dieselbe Kenntnis unabhaengig pruefen kann.
    const verifier = await WPCrypto.deriveWrapKey(codeInput, WPCrypto.fromB64(wrapInfo.recoveryVerifierSalt), kdfParams);

    recoverState = { email, householdKey, verifier };
    msg('Code korrekt — bitte jetzt ein neues Passwort festlegen.', 'ok');
    $('#recoverStep1').hidden = true;
    $('#recoverStep2').hidden = false;
    $('#cvnp').focus();
  } catch (err) {
    msg(err.message, 'err');
  } finally {
    $('#recoverStep1Submit').disabled = false;
  }
};

$('#recoverStep2Submit').onclick = async () => {
  if (!recoverState) return;
  const newPassword = $('#cvnp').value;
  const newPassword2 = $('#cvnp2').value;
  if (newPassword.length < 10) { msg('Das neue Passwort muss mindestens 10 Zeichen haben.', 'err'); return; }
  if (newPassword !== newPassword2) { msg('Die beiden Passwörter stimmen nicht überein.', 'err'); return; }

  $('#recoverStep2Submit').disabled = true;
  msg('Setze neues Passwort …', '');
  try {
    const kdfParams = WPCrypto.defaultKdfParams();
    const newSalt = await WPCrypto.generateSalt();
    const newWrapKey = await WPCrypto.deriveWrapKey(newPassword, newSalt, kdfParams);
    const newWrapped = await WPCrypto.wrapKey(recoverState.householdKey, newWrapKey);

    await post('/api/auth/password-reset', {
      email: recoverState.email,
      verifier: WPCrypto.toB64(recoverState.verifier),
      newPassword,
      passwordWrap: {
        wrappedKey: WPCrypto.toB64(newWrapped.wrappedKey), wrapNonce: WPCrypto.toB64(newWrapped.nonce),
        kdfSalt: WPCrypto.toB64(newSalt), kdfAlgo: kdfParams.algo,
        kdfTimeCost: kdfParams.opslimit, kdfMemoryCost: kdfParams.memlimit, kdfParallelism: kdfParams.parallelism
      }
    });

    // ZANDORs Vorgabe 3: keine stille Verifier-Rotation. Stattdessen hinterlassen wir einen
    // harmlosen Merker (KEIN Schluesselmaterial -- nur die E-Mail-Adresse als Erinnerung, siehe
    // app.js/forceRecoveryCodeRegenerationIfNeeded()) fuer den naechsten Login: dort wird der
    // Nutzer zwingend zur Neu-Erzeugung des Wiederherstellungscodes aufgefordert, bevor die App
    // normal nutzbar wird. localStorage ist hier bewusst unkritisch (anders als der Haushalts-
    // Schluessel, der NIE in eine Web-Storage-API darf).
    localStorage.setItem('wp_force_recovery_regen', recoverState.email);

    recoverState = null;
    $('#cvnp').value = ''; $('#cvnp2').value = ''; $('#cvc').value = '';
    $('#recoverStep2').hidden = true;
    $('#recoverStep1').hidden = false;
    $('#tabLogin').click(); // zurueck zum Login-Tab -- bewusst KEIN automatischer Login, siehe server.js-Kommentar
    msg('Passwort erfolgreich zurückgesetzt. Bitte jetzt mit dem neuen Passwort anmelden.', 'ok');
  } catch (err) {
    msg(err.message, 'err');
  } finally {
    $('#recoverStep2Submit').disabled = false;
  }
};

fetch('/api/config').then(r => r.json()).then(cfg => {
  if (!cfg.allowRegistration) {
    $('#tabRegister').disabled = true;
    $('#regHint').textContent = 'Neue Konten sind auf diesem Server deaktiviert. Lass dich von einem Familienmitglied einladen.';
  }
});
fetch('/api/me', { credentials: 'same-origin' }).then(r => { if (r.ok) location.href = 'index.html'; });
