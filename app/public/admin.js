const $ = s => document.querySelector(s);
const msg = (text, cls) => { const m = $('#msg'); m.textContent = text; m.className = 'msg ' + (cls || ''); };

// CSRF-Token (server.js, requireAdminCsrf): wird beim Boot per GET /api/admin/me
// bezogen und bei jedem zustandsaendernden Request im Header "X-CSRF-Token"
// mitgeschickt. Das zugehoerige Cookie wird vom Browser automatisch mitgesendet --
// dieses Skript muss es nie selbst lesen (siehe Kommentar in server.js).
let csrfToken = null;

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (method !== 'GET' && csrfToken) opts.headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || 'Es hat nicht geklappt');
    err.status = res.status;
    throw err;
  }
  return json;
}

const STATUS_LABELS = { active: 'aktiv', deactivated: 'deaktiviert', deleted: 'gelöscht' };
const STATUS_BADGE_CLASS = { active: 'bg-success', deactivated: 'bg-warning text-dark', deleted: 'bg-danger' };

function makeActionButton(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sm ' + cls;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderHouseholds(households) {
  const tbody = $('#householdsBody');
  tbody.innerHTML = '';
  if (!households.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">Keine Haushalte vorhanden.</td></tr>';
    return;
  }
  for (const h of households) {
    const tr = document.createElement('tr');

    const tdId = document.createElement('td');
    tdId.textContent = h.householdId;
    tr.appendChild(tdId);

    const tdCreated = document.createElement('td');
    tdCreated.textContent = new Date(h.createdAt).toLocaleString('de-DE');
    tr.appendChild(tdCreated);

    const tdMembers = document.createElement('td');
    tdMembers.textContent = h.memberCount;
    tr.appendChild(tdMembers);

    const tdStatus = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge ' + (STATUS_BADGE_CLASS[h.status] || 'bg-secondary');
    badge.textContent = STATUS_LABELS[h.status] || h.status;
    tdStatus.appendChild(badge);
    if (h.statusReason) {
      const reason = document.createElement('div');
      reason.className = 'small text-muted';
      reason.textContent = 'Grund: ' + h.statusReason;
      tdStatus.appendChild(reason);
    }
    tr.appendChild(tdStatus);

    // Aktionen je nach aktuellem Status: active -> nur Deaktivieren;
    // deactivated -> Reaktivieren + Loeschen; deleted -> nur Reaktivieren
    // (Soft-Delete, F3-Aufbewahrungsfrist -- siehe plan.md).
    const tdActions = document.createElement('td');
    tdActions.className = 'd-flex gap-2 flex-wrap';
    if (h.status === 'active') {
      tdActions.appendChild(makeActionButton('Deaktivieren', 'btn-outline-warning', () => deactivate(h.householdId)));
    }
    if (h.status === 'deactivated') {
      tdActions.appendChild(makeActionButton('Reaktivieren', 'btn-outline-success', () => reactivate(h.householdId)));
      tdActions.appendChild(makeActionButton('Löschen', 'btn-outline-danger', () => openDeleteDialog(h.householdId)));
    }
    if (h.status === 'deleted') {
      tdActions.appendChild(makeActionButton('Reaktivieren', 'btn-outline-success', () => reactivate(h.householdId)));
    }
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }
}

async function loadHouseholds() {
  try {
    const { households } = await api('GET', '/api/admin/households');
    renderHouseholds(households);
  } catch (err) {
    msg('Haushaltsliste konnte nicht geladen werden: ' + err.message, 'err');
  }
}

async function deactivate(id) {
  // Leichte Bestaetigung analog zum bestehenden Muster (app.js nutzt an
  // vergleichbarer Stelle ebenfalls window.confirm() vor destruktiven
  // Aktionen) -- Deaktivieren ist reversibel (Reaktivieren-Button), sperrt
  // aber sofort den Zugriff der Familie, daher trotzdem ein Klick mehr.
  if (!confirm(`Haushalt ${id} wirklich deaktivieren? Der Zugriff wird sofort gesperrt (laufende Sitzungen werden beendet).`)) return;
  try {
    await api('POST', `/api/admin/households/${id}/deactivate`, { status_reason: 'admin_manual' });
    msg(`Haushalt ${id} wurde deaktiviert.`, 'ok');
    loadHouseholds();
  } catch (err) {
    msg(`Deaktivieren fehlgeschlagen: ${err.message}`, 'err');
  }
}

async function reactivate(id) {
  try {
    await api('POST', `/api/admin/households/${id}/reactivate`);
    msg(`Haushalt ${id} wurde reaktiviert.`, 'ok');
    loadHouseholds();
  } catch (err) {
    msg(`Reaktivieren fehlgeschlagen: ${err.message}`, 'err');
  }
}

let pendingDeleteId = null;
function openDeleteDialog(id) {
  pendingDeleteId = id;
  $('#deleteDialogText').textContent =
    `Haushalt ${id} wird gesperrt (Soft-Delete, Aufbewahrungsfrist) und ist bis zur endgültigen ` +
    `Bereinigung technisch wiederherstellbar. Zur Bestätigung die Haushalts-ID erneut eingeben.`;
  $('#deleteConfirmInput').value = '';
  $('#deleteDialogMsg').className = 'msg';
  $('#deleteDialog').showModal();
}

$('#deleteDialog').addEventListener('click', async e => {
  // Klick auf den nativen ::backdrop registriert sich als Klick auf das
  // <dialog>-Element selbst (etabliertes Muster, siehe app.js daylist-
  // Kommentar) -- schliesst den Dialog wie ein Klick auf "Abbrechen".
  if (e.target.id === 'deleteDialog') { $('#deleteDialog').close(); return; }

  const act = e.target.getAttribute?.('data-act');
  if (!act) return;
  if (act === 'cancel') { $('#deleteDialog').close(); return; }
  if (act === 'confirm') {
    const raw = $('#deleteConfirmInput').value.trim();
    const confirmId = Number(raw);
    if (!raw || !Number.isInteger(confirmId) || confirmId !== pendingDeleteId) {
      $('#deleteDialogMsg').textContent = 'Die eingegebene ID stimmt nicht mit der Haushalts-ID überein.';
      $('#deleteDialogMsg').className = 'msg err';
      return;
    }
    try {
      await api('DELETE', `/api/admin/households/${pendingDeleteId}`, { confirmHouseholdId: confirmId });
      $('#deleteDialog').close();
      msg(`Haushalt ${pendingDeleteId} wurde gelöscht.`, 'ok');
      loadHouseholds();
    } catch (err) {
      $('#deleteDialogMsg').textContent = err.message;
      $('#deleteDialogMsg').className = 'msg err';
    }
  }
});
$('#deleteDialog').addEventListener('close', () => { pendingDeleteId = null; });

$('#btnLogout').onclick = async () => {
  await api('POST', '/api/admin/auth/logout').catch(() => {});
  location.href = 'admin-login.html';
};

async function boot() {
  try {
    const me = await api('GET', '/api/admin/me');
    csrfToken = me.csrfToken;
  } catch (err) {
    location.href = 'admin-login.html';
    return;
  }
  await loadHouseholds();
}
boot();
