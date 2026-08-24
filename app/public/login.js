const $ = s => document.querySelector(s);
const msg = (text, cls) => { const m = $('#msg'); m.textContent = text; m.className = 'msg ' + cls; };
let inviteMode = false;

function showTab(login) {
  $('#tabLogin').setAttribute('aria-selected', String(login));
  $('#tabRegister').setAttribute('aria-selected', String(!login));
  $('#formLogin').hidden = !login;
  $('#formRegister').hidden = login;
  $('#msg').className = 'msg';
}
$('#tabLogin').onclick = () => showTab(true);
$('#tabRegister').onclick = () => showTab(false);
$('#modeNew').onclick = () => setMode(false);
$('#modeInvite').onclick = () => setMode(true);
function setMode(invite) {
  inviteMode = invite;
  $('#modeNew').setAttribute('aria-selected', String(!invite));
  $('#modeInvite').setAttribute('aria-selected', String(invite));
  $('#boxNew').hidden = invite;
  $('#boxInvite').hidden = !invite;
}

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
