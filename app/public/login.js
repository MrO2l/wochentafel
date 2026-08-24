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

$('#formRegister').onsubmit = async e => {
  e.preventDefault();
  const body = { name: $('#rn').value, email: $('#re').value, password: $('#rp').value };
  if (inviteMode) body.inviteCode = $('#ri').value.trim().toUpperCase();
  else body.householdName = $('#rh').value.trim() || ('Haushalt ' + $('#rn').value);
  try { await post('/api/auth/register', body); location.href = 'index.html'; }
  catch (err) { msg(err.message, 'err'); }
};

fetch('/api/config').then(r => r.json()).then(cfg => {
  if (!cfg.allowRegistration) {
    $('#tabRegister').disabled = true;
    $('#regHint').textContent = 'Neue Konten sind auf diesem Server deaktiviert. Lass dich von einem Familienmitglied einladen.';
  }
});
fetch('/api/me', { credentials: 'same-origin' }).then(r => { if (r.ok) location.href = 'index.html'; });
