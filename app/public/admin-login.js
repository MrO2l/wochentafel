const $ = s => document.querySelector(s);
const msg = (text, cls) => { const m = $('#msg'); m.textContent = text; m.className = 'msg ' + (cls || ''); };

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin'
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

$('#formAdminLogin').onsubmit = async e => {
  e.preventDefault();
  msg('', '');
  const username = $('#au').value;
  const password = $('#ap').value;

  const { ok, status, json } = await postJson('/api/admin/auth/login', { username, password });
  if (ok) { location.href = 'admin.html'; return; }

  // 429 (eskalierende Sperre, server.js createLoginThrottle) und 401 (falsche
  // Zugangsdaten) sollen klar unterscheidbar sein, nicht in einer generischen
  // Fehlermeldung verschwinden -- beide liefern bereits eine sprechende
  // error-Meldung vom Server (Wartezeit in Sekunden bzw. "Benutzername oder
  // Passwort stimmt nicht"), die hier 1:1 uebernommen wird.
  msg(json.error || 'Anmeldung fehlgeschlagen.', 'err');
};

// Bereits eine gueltige Admin-Session vorhanden? Dann direkt zur Uebersicht
// weiterleiten (analog login.js -> index.html fuer die Haushalts-Session).
fetch('/api/admin/me', { credentials: 'same-origin' }).then(r => { if (r.ok) location.href = 'admin.html'; });
