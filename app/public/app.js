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
  day: 0
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
/* Entsprechender Link fuer Zeilen mit mode:'week' ("Essen & Kochen"): oeffnet den
   Essensplan der ganzen Woche statt einer einzelnen Tageszelle. */
function renderWeekLink(row) {
  const totalCount = row.meals.reduce((n, meal) => n + meal.cells.filter(c => c && c.length).length, 0);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'listlink' + (totalCount ? ' filled' : '');
  btn.appendChild(iconSvg('i-liste'));
  const lbl = document.createElement('span');
  lbl.className = 'll-label';
  lbl.textContent = totalCount ? 'Essensplan öffnen' : 'Essensplan für die Woche anlegen';
  btn.appendChild(lbl);
  if (totalCount) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(totalCount);
    btn.appendChild(badge);
  }
  btn.addEventListener('click', openMealPlan);
  return btn;
}

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

/* ---------------- AP3.2: Inhalte der beiden neuen Linksmenue-Ansichten "Einkaufen &
   Besorgungen" / "Essen & Kochen". Fachlogik/Datenhaltung bleibt vollstaendig unveraendert
   (dieselben Zeilen, dieselben Overlays, dasselbe openDayList()/openMealPlan()) -- hier werden
   die bereits vorhandenen renderListLink()/renderWeekLink()-Bausteine in einem eigenen
   Kartenraster wiederverwendet. Funktions-Dopplung-Fix (Nutzer-Feedback 2026-08-19): urspruenglich
   ein ZWEITER, zusaetzlicher Einstieg neben einem gleichwertigen Link im Hauptraster -- renderSheet()
   zeigt diese Zeilen inzwischen nicht mehr an (siehe dort), diese beiden Ansichten sind daher jetzt
   der jeweils EINZIGE Einstiegspunkt. Werden wie renderSheet()/renderDay() bei jeder
   Datenaenderung ueber renderAll() neu gezeichnet, auch waehrend die jeweilige Ansicht gerade
   nicht sichtbar ist (reines display:none/-block, siehe .app-view in style-v2.css — kein
   erneutes Rendern beim Ansichtswechsel selbst noetig). */
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
function renderMealPlanEntry() {
  const wrap = $('#mealplanEntry');
  if (!wrap) return;
  wrap.textContent = '';
  const row = state.data.rows.find(r => r.mode === 'week');
  if (!row) {
    const p = document.createElement('p');
    p.className = 'view-empty';
    p.textContent = 'Für diese Woche ist aktuell keine Essensplan-Zeile angelegt.';
    wrap.appendChild(p);
    return;
  }
  const card = document.createElement('div');
  card.className = 'mealplan-entry-card';
  card.appendChild(renderWeekLink(row)); // dieselbe Schaltflaeche/Zaehlung wie im Hauptraster
  wrap.appendChild(card);
}

/* ---------------- AP3.2: Umschalten zwischen den drei Ansichten im neuen Linksmenue (bzw. der
   daraus umgeklappten unteren Tab-Leiste auf schmalen Bildschirmen). Reiner Sichtbarkeits-
   umschalter (wie im freigegebenen Klick-Mockup) — keine eigene Datenhaltung, kein Routing;
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
  // Essensplan-Zellen liegen in einem eigenen Overlay ausserhalb von .stage/#dayview (so wie
  // Blatt und Tagesansicht immer beide im Dokument stehen, siehe Dokumentation 4.9, hier um
  // eine dritte Darstellung erweitert) — deshalb unabhaengig von der aktiven Ansicht immer
  // mitsynchronisiert, nicht nur wenn das Overlay gerade sichtbar ist.
  document.querySelectorAll('.mp-cell[data-mealcell]').forEach(el => {
    const [mi, di] = el.getAttribute('data-mealcell').split(',').map(Number);
    const weekRow = state.data.rows.find(r => r.mode === 'week');
    if (weekRow && weekRow.meals[mi]) weekRow.meals[mi].cells[di] = cellToTokens(el);
  });
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
    const res = await api('PUT', `/api/weeks/${state.weekStart}`, { data: state.data, baseUpdatedAt: state.updatedAt });
    state.updatedAt = res.updatedAt;
    state.dirty = false;
    setStatus('Gespeichert ' + new Date(res.updatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), 'saved');
    refreshArchive();
  } catch (err) {
    if (err.status === 409) {
      state.data = err.payload.data;
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
  state.data = res.data;
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
  const { template } = await api('GET', '/api/template');
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
  await api('PUT', '/api/template', { data: state.data });
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
  document.body.classList.add('daylist-open');
}
function closeDayList() {
  document.body.classList.remove('daylist-open');
  renderAll(); // Badges im Raster/in der Tagesansicht aktualisieren, falls Eintraege geaendert wurden
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
function openMealPlan() {
  syncFromDOM();
  const mon = parseISO(state.weekStart);
  const sun = parseISO(state.weekStart); sun.setDate(sun.getDate() + 6);
  $('#mpSub').textContent =
    'KW ' + isoWeek(mon) + ' · ' +
    mon.toLocaleDateString('de-DE', { day: '2-digit', month: 'long' }) + ' – ' +
    sun.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  renderMealPlanHead();
  renderMealPlanBody();
  document.body.classList.add('mealplan-open');
}
function closeMealPlan() {
  syncFromDOM();
  document.body.classList.remove('mealplan-open');
  renderAll();
}
function renderMealPlanHead() {
  const headRow = $('#mpHeadRow');
  headRow.querySelectorAll('th:not(.corner)').forEach(th => th.remove());
  const todayIdx = todayColumnIndex();
  DAYS.forEach((name, i) => {
    const d = parseISO(state.weekStart); d.setDate(d.getDate() + i);
    const th = document.createElement('th');
    if (i === todayIdx) th.className = 'today';
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
      if (d === todayIdx) td.className = 'today';
      td.appendChild(editableCell(meal.cells[d], { 'data-mealcell': `${mi},${d}`, 'data-ph': '–' }, 'mp-cell autobreak'));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
}
function initMealPlanToolbar() {
  $('#mealplanToolbar').appendChild(buildMiniPalette(['i-kochen', 'i-essen']));
}

/* ---------------- Kontomenue ---------------- */
function openMenu() {
  const dlg = document.createElement('dialog');
  dlg.className = 'acct-dialog';
  dlg.innerHTML = `
    <div class="acct-body">
      <h2>Konto</h2>
      <p class="acct-who"></p>
      <div class="acct-actions">
        <button class="btn" data-act="invite">Familienmitglied einladen</button>
        <button class="btn" data-act="export">Diese Woche als Datei sichern</button>
        <button class="btn" data-act="import">Datei einlesen</button>
        <button class="btn" data-act="template-del">Vorlage löschen</button>
        <button class="btn" data-act="logout">Abmelden</button>
      </div>
      <div class="acct-out" data-out></div>
      <div class="acct-foot"><button class="btn" data-act="close">Schließen</button></div>
    </div>`;
  dlg.querySelector('p').textContent = `${state.user.name} · ${state.user.email} · Haushalt „${state.user.householdName}“`;
  const out = dlg.querySelector('[data-out]');
  dlg.addEventListener('click', async e => {
    const act = e.target.getAttribute?.('data-act');
    if (!act) return;
    if (act === 'close') dlg.close();
    if (act === 'logout') { await api('POST', '/api/auth/logout'); location.href = 'login.html'; }
    if (act === 'invite') {
      const { code } = await api('POST', '/api/invites');
      out.textContent = `Einladungscode: ${code} (14 Tage gültig)`;
    }
    if (act === 'export') { exportJSON(); out.textContent = 'Datei wurde heruntergeladen.'; }
    if (act === 'import') {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'application/json';
      inp.onchange = () => { if (inp.files[0]) { importJSON(inp.files[0]); dlg.close(); } };
      inp.click();
    }
    if (act === 'template-del') { await api('DELETE', '/api/template'); out.textContent = 'Vorlage gelöscht.'; }
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
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
  $('#householdName').textContent = me.user.householdName;

  if (window.matchMedia('(max-width: 900px)').matches) { setView('day'); state.day = (new Date().getDay() + 6) % 7; }

  await loadWeek(isoOf(toMonday(new Date())));
  await refreshArchive();

  initMealPlanToolbar();
  initFocusBlocks();

  document.addEventListener('input', e => {
    if (e.target.closest?.('[data-cell],[data-label],[data-role],[data-bind],[data-mealcell]')) markDirty();
  });
  $('#btnPrint').onclick = () => { syncFromDOM(); renderSheet(); window.print(); };
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
  $('#btnMenu').onclick = openMenu;

  document.querySelectorAll('.app-nav .nav-btn').forEach(btn => {
    btn.addEventListener('click', () => setSection(btn.dataset.view));
  });

  $('#dlClose').onclick = closeDayList;
  $('#daylistOverlay').addEventListener('click', e => { if (e.target.id === 'daylistOverlay') closeDayList(); });
  // Hochformat fuer den Ausdruck der Tagesliste kommt rein statisch aus der benannten
  // @page-Regel "daylist-print" in style.css (aktiviert ueber .daylist{page:daylist-print}
  // sobald body.printing-daylist gesetzt ist) — keine Laufzeit-Style-Injektion noetig/erlaubt.
  $('#dlPrint').onclick = () => { syncFromDOM(); document.body.classList.add('printing-daylist'); window.print(); };

  $('#mpClose').onclick = closeMealPlan;
  $('#mealplanOverlay').addEventListener('click', e => { if (e.target.id === 'mealplanOverlay') closeMealPlan(); });
  $('#mpPrint').onclick = () => { syncFromDOM(); document.body.classList.add('printing-mealplan'); window.print(); };

  window.addEventListener('beforeprint', () => { if (state.view === 'day') { syncFromDOM(); renderSheet(); } });
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing-daylist');
    document.body.classList.remove('printing-mealplan');
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
