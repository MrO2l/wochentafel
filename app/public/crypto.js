/* crypto.js -- Clientseitige Krypto-Bausteine (AP2.1, projects/wochenplaner-
 * termine-verschluesselung/plan.md). Bindende Bausteine laut ZANDORs AP1.1-
 * Empfehlung, uebernommen von MORROW in ap1.2-datenmodell.md:
 *   KDF:  Argon2id (crypto_pwhash, ALG_ARGON2ID13), individuelles Salt pro Wrap.
 *   AEAD: XChaCha20-Poly1305 (24-Byte-Nonce -- groesser und kollisionssicherer
 *         als AES-256-GCMs 12-Byte-Nonce, siehe ZANDORs Begruendung).
 *
 * Erwartet, dass vendor/libsodium/libsodium.js UND
 * vendor/libsodium/libsodium-wrappers.js VOR dieser Datei als <script> geladen
 * wurden (window.sodium, siehe dortige Kommentare).
 *
 * KRITISCHSTE Regel dieser Datei (Risikotabelle des Plans, nicht verhandelbar):
 * Der Haushalts-Schluessel -- und jeder daraus abgeleitete/davon entschluesselte
 * Klartext -- verlaesst NIE dieses Modul in Richtung Web-Storage (localStorage/
 * sessionStorage/IndexedDB/Cookies). setHouseholdKey()/getHouseholdKey() halten
 * ihn ausschliesslich in einer modul-lokalen JS-Variable, die mit dem Schliessen/
 * Neuladen der Seite automatisch verschwindet -- genau das ist beabsichtigt.
 * pgcrypto/serverseitige Ver-/Entschluesselung ist ausdruecklich NICHT Teil
 * dieses Bausteins (und nirgends in dieser App vorgesehen).
 */
(function (global) {
  'use strict';

  if (!global.sodium || typeof global.sodium.ready?.then !== 'function') {
    // Weiches Fail: wirft erst beim ersten tatsaechlichen Zugriff (ready-Promise unten), nicht
    // schon beim Laden dieser Datei -- damit die Reihenfolge-Fehlermeldung (falls vendor/libsodium
    // aus irgendeinem Grund nicht geladen wurde) klar auf die Ursache hinweist.
    console.error('crypto.js: window.sodium fehlt -- vendor/libsodium/libsodium.js und ' +
      'libsodium-wrappers.js muessen VOR crypto.js geladen werden.');
  }

  const readyPromise = global.sodium.ready;

  /* ---------------- In-memory-only Haushalts-Schluessel-Ablage ---------------- */
  let householdKeyBytes = null;

  function setHouseholdKey(bytes) { householdKeyBytes = bytes; }
  function getHouseholdKey() { return householdKeyBytes; }
  function hasHouseholdKey() { return householdKeyBytes != null; }
  function clearHouseholdKey() {
    if (householdKeyBytes) { try { global.sodium.memzero(householdKeyBytes); } catch { /* ignorieren */ } }
    householdKeyBytes = null;
  }

  /* ---------------- Kodierung ----------------
   * ORIGINAL-Variante (mit Padding) entspricht Node.js' Buffer.toString('base64')/
   * Buffer.from(str,'base64') auf der Serverseite (server.js) -- siehe API-Envelope-
   * Spezifikation ap1.2-datenmodell.md Abschnitt 6.1. */
  function toB64(bytes) { return global.sodium.to_base64(bytes, global.sodium.base64_variants.ORIGINAL); }
  function fromB64(str) { return global.sodium.from_base64(str, global.sodium.base64_variants.ORIGINAL); }

  /* ---------------- Argon2id-Parameter ----------------
   * INTERACTIVE-Preset (nicht MODERATE/SENSITIVE): laeuft im Browser als WASM/Backup-JS ohne
   * native Beschleunigung, bei jedem Login/Setup einmal. Werte werden PRO WRAP in
   * household_key_wraps gespeichert (Kryptoagilitaet, ap1.2-datenmodell.md Abschnitt 2.2) --
   * eine kuenftige Verschaerfung trifft nur neu erzeugte Wraps, nicht bestehende. */
  function defaultKdfParams() {
    return {
      algo: 'argon2id',
      opslimit: global.sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      memlimit: global.sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      // libsodiums crypto_pwhash(ARGON2ID13) hat intern einen fixen Lanes-/Parallelitaetswert
      // von 1 (nicht als Parameter einstellbar) -- household_key_wraps.kdf_parallelism spiegelt
      // das nur zur Dokumentation/Kryptoagilitaet, siehe Migration 009.
      parallelism: 1
    };
  }

  async function deriveWrapKey(secret, saltBytes, kdfParams) {
    await readyPromise;
    const params = kdfParams || defaultKdfParams();
    if (params.algo !== 'argon2id') throw new Error('Nur argon2id wird unterstuetzt (kdf_algo=' + params.algo + ')');
    const secretBytes = typeof secret === 'string' ? global.sodium.from_string(secret) : secret;
    return global.sodium.crypto_pwhash(
      32, secretBytes, saltBytes,
      params.opslimit, params.memlimit,
      global.sodium.crypto_pwhash_ALG_ARGON2ID13
    );
  }

  async function generateSalt() {
    await readyPromise;
    return global.sodium.randombytes_buf(global.sodium.crypto_pwhash_SALTBYTES);
  }

  async function generateHouseholdKey() {
    await readyPromise;
    return global.sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  }

  /* ---------------- Envelope-Verpackung (Wrap) des Haushalts-Schluessels ----------------
   * "Wrap" = AEAD-Verschluesselung des Haushalts-Schluessels mit einem aus Passwort/
   * Wiederherstellungscode abgeleiteten Schluessel (ZANDORs Envelope-Muster, AP1.1). */
  async function wrapKey(householdKey, wrapKeyBytes) {
    await readyPromise;
    const nonce = global.sodium.randombytes_buf(global.sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const wrapped = global.sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      householdKey, null, null, nonce, wrapKeyBytes);
    return { wrappedKey: wrapped, nonce };
  }

  // Wirft bei falschem Schluessel/manipuliertem Ciphertext automatisch (AEAD-Authentifizierung
  // schlaegt fehl, sodium wirft eine Exception) -- siehe ap1.2-datenmodell.md Abschnitt 2.3: keine
  // separate serverseitige Pruefung noetig oder vorgesehen, das ist bewusst so designt.
  async function unwrapKey(wrappedKeyBytes, nonceBytes, wrapKeyBytes) {
    await readyPromise;
    return global.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, wrappedKeyBytes, null, nonceBytes, wrapKeyBytes);
  }

  /* ---------------- Wochendaten/Vorlagen ver-/entschluesseln ---------------- */
  async function encryptJSON(householdKey, obj) {
    await readyPromise;
    const plaintext = global.sodium.from_string(JSON.stringify(obj));
    const nonce = global.sodium.randombytes_buf(global.sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ciphertext = global.sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext, null, null, nonce, householdKey);
    return { nonce: toB64(nonce), ciphertext: toB64(ciphertext) };
  }

  async function decryptJSON(householdKey, nonceB64, ciphertextB64) {
    await readyPromise;
    const plaintext = global.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, fromB64(ciphertextB64), null, fromB64(nonceB64), householdKey);
    return JSON.parse(global.sodium.to_string(plaintext));
  }

  /* ---------------- Wiederherstellungscode ----------------
   * 16 zufaellige Bytes (128 Bit) als Crockford-Base32 (keine verwechselbaren Zeichen: kein
   * I/L/O/U), in 4er-Gruppen fuer Lesbarkeit beim Abtippen/Abschreiben. Der Code existiert NIE
   * auf dem Server -- auch nicht gehasht (ap1.2-datenmodell.md Abschnitt 2.3) -- und muss daher
   * allein aus seiner eigenen Entropie vor Offline-Rateversuchen gegen einen (potenziell
   * geleakten) Wrap schuetzen; 125 effektiv genutzte Bit sind dafuer bewusst grosszuegig
   * bemessen (deutlich mehr als ein typisches Nutzerpasswort). */
  const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  async function generateRecoveryCode() {
    await readyPromise;
    const bytes = global.sodium.randombytes_buf(16);
    let bits = '';
    bytes.forEach(b => { bits += b.toString(2).padStart(8, '0'); });
    let out = '';
    for (let i = 0; i + 5 <= bits.length; i += 5) {
      out += CROCKFORD_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
    }
    return out.match(/.{1,4}/g).join('-');
  }
  // Normalisiert eine Nutzereingabe vor der KDF (Gross-/Kleinschreibung, Trennzeichen entfernt).
  // Ein Tippfehler wird bewusst NICHT automatisch korrigiert -- er fuehrt einfach zu einem
  // falschen Schluessel und damit zu einem AEAD-Fehler beim Unwrap, das ist gewuenscht/sicher.
  function normalizeRecoveryCode(input) {
    return String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  global.WPCrypto = {
    ready: readyPromise,
    toB64, fromB64,
    defaultKdfParams,
    deriveWrapKey, generateSalt, generateHouseholdKey,
    wrapKey, unwrapKey,
    encryptJSON, decryptJSON,
    generateRecoveryCode, normalizeRecoveryCode,
    setHouseholdKey, getHouseholdKey, hasHouseholdKey, clearHouseholdKey
  };
})(window);
