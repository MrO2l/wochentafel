/* Familien-Wochenplan – Oberflaeche.
   Die Wochendaten liegen als Tokens vor (Text / Piktogramm / Zeilenumbruch),
   nicht als HTML. Das haelt Server und Datenbank frei von Markup und macht
   die A4-Ansicht und die Tagesansicht zu zwei Darstellungen derselben Daten. */

const DAYS  = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];
const DAYS_S = ['Mo','Di','Mi','Do','Fr','Sa','So'];
// Matte Vierfarb-Palette, reihum den Personenzeilen zugeordnet (siehe :root-Variablen in style.css).
const FAM_CLASSES = ['fam-a', 'fam-b', 'fam-c', 'fam-d'];

// AP3.1 (projects/wochenplaner-design-nacharbeiten/plan.md, "Architektur-Fundament: State-/
// DOM-Entkopplung fuer Zwei-Wochen-Betrieb"): zwei feste, benannte Pane-Instanzen statt eines
// einzelnen globalen State-Objekts, damit aktuelle und kommende Woche unabhaengig voneinander
// gehalten, editiert, ge-debounced, gespeichert und bei 409-Konflikten re-rendered werden koennen.
// BEWUSST genau zwei benannte Instanzen (panes.current/panes.next), KEINE generische Map/Array
// nach weekStart -- es gibt nie mehr als diese zwei gleichzeitig editierbaren Wochen (siehe
// Ruecklauf an ANORAK/JOHNSON, Frage 1). "root" ist das DOM-Wurzelelement der jeweiligen Pane
// (gesetzt in boot(), siehe dort) und Basis fuer die pane-gescopte Abfragefunktion qs() unten.
function createPane(name) {
  return {
    name,
    weekStart: null,
    data: null,
    updatedAt: null,
    dirty: false,
    saving: false,
    view: 'sheet',
    day: 0,
    // AP1.1: eigener, von "day" unabhaengiger Mobile-Tag fuer die "Essen & Kochen"-Tabelle (siehe
    // renderMealDayNav()) -- nur bei panes.current tatsaechlich genutzt (Essensplan bleibt ausserhalb
    // des AP3.1-Umbaus, siehe dortiger Kommentar), hier trotzdem Teil der Pane-Form (Plan-Vorgabe).
    mealDay: (new Date().getDay() + 6) % 7,
    root: null,
    saveTimer: null,
    // Palette-Fokus-Tracking (siehe insertIcon()) muss pane-bewusst sein, sonst landet ein per
    // Piktogramm-Palette eingefuegtes Icon in der falschen Woche, wenn zuletzt in der jeweils
    // anderen Pane getippt wurde.
    lastCell: null,
    lastRange: null,
  };
}
const panes = { current: createPane('current'), next: createPane('next') };
// Rueckwaertskompatibler Alias: der weit ueberwiegende Teil des bestehenden Codes (Essensplan,
// Einkaufslisten, Tagesliste, Rezeptkarten, Fokusbloecke, Toolbar-Aktionen wie Vorlage/Export/
// Zeile hinzufuegen) bleibt bewusst UNVERAENDERT und liest/schreibt weiterhin "state" -- das ist
// ABSICHTLICH derselbe Objekt-Verweis wie panes.current, kein Duplikat. Nur die im Plan explizit
// benannten "harter Kern"-Funktionen (renderHead/renderSheet/renderDay/syncFromDOM/markDirty/
// setStatus/save/loadWeek/activeContainer/todayColumnIndex/applyTemplate/saveTemplate/exportJSON/
// importJSON) wurden auf einen expliziten, optionalen "pane"-Parameter (Default: panes.current)
// umgestellt; jeder bestehende, nicht angepasste Aufruf verhaelt sich dadurch exakt wie zuvor --
// das ist die Grundlage fuer die im Plan geforderte Regressionsfreiheit.
const state = panes.current;
// "user"/"recipes" sind app-weite, nicht wochenbezogene Daten (kein Teil der Pane-Form oben) --
// bleiben aus Grunden minimaler Diff-Flaeche auf demselben Objekt wie bisher (state === panes.
// current), aber konzeptionell nicht pane-spezifisch.
state.user = null;
state.recipes = []; // AP2.2: haushaltsweite Rezeptkarten-Uebersicht, unabhaengig von der Wochenansicht

/* ---------------- Hilfsfunktionen ---------------- */
const $ = sel => document.querySelector(sel); // app-weite Singletons (Palette, Legende, Dialoge, Toolbar-Chrome der aktuellen Woche)
// AP3.1: pane-gescopte Variante fuer alles, was es jetzt zweimal im DOM gibt (Grid/Kopfzeilen-
// Chrome je Pane) -- sucht INNERHALB der Pane-Wurzel (pane.root) statt im gesamten Dokument, damit
// gleichlautende Marker-Klassen (".js-...") in beiden Panes nicht kollidieren.
const qs = (pane, sel) => pane.root ? pane.root.querySelector(sel) : null;
// AP3.1: bestimmt, welche Pane ein gegebenes DOM-Element "gehoert" -- fuer Ereignisse, die nicht
// bereits ueber einen Funktionsabschluss (Closure) wissen, in welcher Pane sie ausgeloest wurden
// (globaler "input"-Listener, Palette-Fokus-Tracking, Doppelklick-Icon-Entfernen). Elemente
// innerhalb der geteilten mobilen Tagesansicht (#dayview) gehoeren der aktuell dort aktiven Pane
// (siehe dayViewActivePane/switchDayViewPane() weiter unten).
function paneForElement(el) {
  if (panes.next.root && panes.next.root.contains(el)) return panes.next;
  if ($('#dayview')?.contains(el)) return dayViewActivePane;
  return panes.current;
}
// AP3.1: welche Pane zuletzt eine editierbare Zelle fokussiert hat -- bestimmt, wohin die
// Piktogramm-Palette (insertIcon()) als naechstes einfuegt.
let activeEditPane = panes.current;
// AP3.1 (Frage 3, Mobile bleibt sequenziell): welche Pane die geteilte mobile Tagesansicht
// (#dayview/#daynav/#dayCards) gerade befuellt -- es gibt bewusst KEIN zweites #dayview-Markup,
// siehe switchDayViewPane() weiter unten.
let dayViewActivePane = panes.current;
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
function todayColumnIndex(pane = panes.current) {
  const t = new Date();
  return isoOf(toMonday(t)) === pane.weekStart ? (t.getDay() + 6) % 7 : -1;
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

// AP3.1: "lastCell"/"lastRange" sind jetzt Teil der jeweiligen Pane (siehe createPane()) statt
// globaler Variablen -- "activeEditPane" (oben, bei panes/qs definiert) merkt sich, welche Pane
// diese Referenzen gerade traegt, damit die Piktogramm-Palette in die richtige Woche einfuegt.
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (!sel.rangeCount) return;
  const node = sel.getRangeAt(0).startContainer;
  const cell = (node.nodeType === 1 ? node : node.parentElement)?.closest('.cell[contenteditable]');
  if (cell) {
    const pane = paneForElement(cell);
    pane.lastRange = sel.getRangeAt(0).cloneRange();
    pane.lastCell = cell;
    activeEditPane = pane;
  }
});
function insertIcon(id, label) {
  const pane = activeEditPane;
  if (!pane.lastCell || !document.body.contains(pane.lastCell)) { flash('Bitte zuerst in ein Feld tippen.'); return; }
  if (document.activeElement !== pane.lastCell) pane.lastCell.focus();
  const frag = document.createDocumentFragment();
  frag.appendChild(iconSpan(id, label));
  // geschuetztes Leerzeichen, damit der Browser es am Zeilenende nicht verwirft;
  // beim Speichern wird daraus wieder ein normales Leerzeichen
  const tail = document.createTextNode(label + String.fromCharCode(160));
  frag.appendChild(tail);
  let endNode = tail;
  if (pane.lastCell.classList.contains('autobreak')) {
    // Neue Listen-/Essensplan-Editierfelder (Tagesliste, Essensplan): nach dem Piktogramm
    // automatisch eine neue Zeile beginnen, damit der folgende Text nicht am Icon "klebt"
    // (Design-Feedback). Bewusst nur fuer diese neuen Elemente (Klasse "autobreak") — das
    // bestehende Verhalten der Personen-/Haushalt-Zeilen im Hauptraster bleibt unveraendert.
    const br = document.createElement('br');
    frag.appendChild(br);
    endNode = br;
  }
  let r = pane.lastRange;
  if (!r || !pane.lastCell.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(pane.lastCell); r.collapse(false); }
  r.deleteContents(); r.insertNode(frag);
  const after = document.createRange(); after.setStartAfter(endNode); after.collapse(true);
  const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(after);
  pane.lastRange = after.cloneRange();
  markDirty(pane);
}
document.addEventListener('dblclick', e => {
  const ic = e.target.closest('.ic');
  if (ic && ic.closest('.cell[contenteditable]')) { const pane = paneForElement(ic); ic.remove(); markDirty(pane); }
});

/* ---------------- Darstellung: A4-Blatt ---------------- */
// AP3.1: "pane" (Default panes.current) bestimmt sowohl Datenquelle (pane.weekStart) als auch
// DOM-Ziel (qs(pane, ...) statt globalem $()) -- fuer panes.current bleibt das Verhalten dank
// pane.root === $('#sheet') unveraendert identisch zum bisherigen $('#headRow')/$('#kwLabel')/...
// Das Datumsfeld (#monday) gibt es nur einmal (Werkzeugleiste, ausserhalb jeder Pane-Wurzel) --
// "naechste Woche" hat keine eigene Datums-/Archiv-Navigation (immer pane.weekStart + 7 Tage,
// siehe loadWeek()), deshalb wird es nur fuer panes.current gesetzt.
function renderHead(pane = panes.current) {
  const mon = parseISO(pane.weekStart);
  const headRow = qs(pane, '.js-head-row');
  headRow.querySelectorAll('th:not(.corner)').forEach(th => th.remove());
  const todayIdx = todayColumnIndex(pane);
  DAYS.forEach((name, i) => {
    const d = parseISO(pane.weekStart); d.setDate(d.getDate() + i);
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
  const sun = parseISO(pane.weekStart); sun.setDate(sun.getDate() + 6);
  qs(pane, '.js-kw-label').textContent = 'KW ' + isoWeek(mon);
  qs(pane, '.js-range-label').textContent =
    mon.toLocaleDateString('de-DE', { day: '2-digit', month: 'long' }) + ' – ' +
    sun.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  if (pane === panes.current) $('#monday').value = pane.weekStart;
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

// AP3.1: "pane" (Default panes.current) parametrisiert Datenquelle (pane.data) und DOM-Ziel
// (qs(pane, ...)); fuer panes.next erbt die Tabelle dieselben generischen Zell-/Zeilen-/Avatar-
// Regeln aus style.css (die meisten sind nicht auf "#grid" beschraenkt, siehe next-pane-grid-
// Kommentar in index.html).
function renderSheet(pane = panes.current) {
  renderHead(pane);
  const body = qs(pane, '.js-grid-body');
  body.textContent = '';
  let firstShared = true;
  let personIndex = 0;
  const todayIdx = todayColumnIndex(pane);
  pane.data.rows.forEach((row, ri) => {
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
    del.onclick = () => { if (confirm('Diese Zeile entfernen?')) { syncFromDOM(pane); pane.data.rows.splice(ri, 1); renderAll(pane); markDirty(pane); } };
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

  // Motto/Notizen sind ueber qs(pane, ...) gescopt, statt wie zuvor per globalem $() gesucht --
  // beide Panes haben jetzt je ein eigenes [data-bind="motto"]/[data-bind="notes"]-Element
  // (next-pane: siehe index.html). Defensiv mit "if (el)" abgesichert, falls eine Pane (z. B.
  // ein zukuenftiges drittes Pane) diese Felder einmal nicht mitbringt.
  const motto = qs(pane, '[data-bind="motto"]');
  if (motto) { motto.textContent = ''; motto.appendChild(tokensToFragment(pane.data.motto)); }
  const notes = qs(pane, '.notes [data-bind="notes"]');
  if (notes) { notes.textContent = ''; notes.appendChild(tokensToFragment(pane.data.notes)); }
}

/* ---------------- Darstellung: Tagesansicht ----------------
   AP3.1 (Frage 3, Mobile bleibt sequenziell): renderDay() schreibt IMMER in dieselben, geteilten
   #daynav/#dayCards-Elemente -- es gibt kein zweites #dayview-Markup. Welche Pane dort gerade
   sichtbar ist, bestimmt "dayViewActivePane" (siehe switchDayViewPane()); ruft z. B. renderAll()
   die jeweils NICHT sichtbare Pane auf (etwa nach einem 409-Konflikt im Hintergrund), ist das ein
   sicherer No-Op, statt die gerade angezeigte andere Pane versehentlich zu ueberschreiben. */
function renderDay(pane = panes.current) {
  if (pane !== dayViewActivePane) return;
  const nav = $('#daynav');
  nav.textContent = '';
  const todayIdx = todayColumnIndex(pane);
  DAYS.forEach((name, i) => {
    const d = parseISO(pane.weekStart); d.setDate(d.getDate() + i);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-current', String(i === pane.day));
    if (i === todayIdx) b.classList.add('today');
    b.innerHTML = '<span></span><small></small>';
    b.querySelector('span').textContent = DAYS_S[i];
    b.querySelector('small').textContent = fmtShort(d);
    b.onclick = () => { syncFromDOM(pane); pane.day = i; renderDay(pane); };
    nav.appendChild(b);
  });
  nav.children[pane.day]?.scrollIntoView({ inline: 'center', block: 'nearest' });

  const wrap = $('#dayCards');
  wrap.textContent = '';
  const d = parseISO(pane.weekStart); d.setDate(d.getDate() + pane.day);

  const card = document.createElement('div');
  card.className = 'daycard';
  const h = document.createElement('h3');
  h.textContent = DAYS[pane.day];
  const sub = document.createElement('span');
  sub.textContent = d.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  h.appendChild(sub);
  card.appendChild(h);

  let personIndex = 0;
  pane.data.rows.forEach((row, ri) => {
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
    line.appendChild(editableCell(row.cells[pane.day], { 'data-cell': `${ri},${pane.day}` }));
    card.appendChild(line);
  });
  wrap.appendChild(card);

  const notesCard = document.createElement('div');
  notesCard.className = 'daycard notes-card';
  const nh = document.createElement('h3'); nh.textContent = 'Notizen der Woche';
  notesCard.appendChild(nh);
  const nrow = document.createElement('div'); nrow.className = 'dayrow';
  nrow.appendChild(editableCell(pane.data.notes, { 'data-bind': 'notes' }));
  notesCard.appendChild(nrow);
  wrap.appendChild(notesCard);
}

// AP3.1: "current" behaelt ihren bestehenden Sheet-/Tagesansicht-Umschalter (pane.view,
// unveraendertes AP1.1-Verhalten) -- ausser die geteilte Tagesansicht zeigt gerade "next" (dann
// hat "current" aktuell keine sichtbare editierbare Flaeche, syncFromDOM() wird dafuer unten
// defensiv zu einem No-Op statt zu crashen). "next" hat auf Desktop keinen eigenen Sheet-/
// Tagesansicht-Umschalter (Ruecklauf an ANORAK/JOHNSON, Frage 3) -- ihre editierbare Flaeche ist
// dort immer die eigene, kompakte Sheet-Karte (pane.root); ist sie stattdessen (auf Mobile) gerade
// die in #dayview aktive Pane, gilt wie bei "current" das geteilte Markup.
function activeContainer(pane = panes.current) {
  if (pane === panes.next) return dayViewActivePane === panes.next ? $('#dayview') : pane.root;
  if (dayViewActivePane === panes.next) return null;
  return pane.view === 'sheet' ? $('#sheet') : $('#dayview');
}
// AP3.1: "pane" (Default panes.current) haelt renderAll() fuer bestehende Aufrufer (Einkaufen/
// Essensplan/Fokusbloecke, alle weiterhin current-only, siehe deren Kommentare) exakt unveraendert.
// Fuer panes.next werden bewusst NUR Sheet/Kopfzeilen-Chrome neu gezeichnet: Einkaufen/Essen &
// Kochen/Fokusbloecke sind nicht Teil der im Plan festgelegten AP3.1-"harter Kern"-Funktionsliste
// und zeigten auch vorher nie Daten der naechsten Woche (kein Funktionsverlust).
function renderAll(pane = panes.current) {
  if (pane === panes.current) {
    renderSheet(pane); renderDay(pane); renderShoppingView(); renderMealPlanEntry(); renderFocusBlocks();
  } else {
    renderSheet(pane);
  }
}

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
    const editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'btn btn-outline-secondary btn-sm';
    editBtn.textContent = 'Bearbeiten';
    editBtn.addEventListener('click', () => openRecipeForm(r));
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'btn btn-outline-secondary btn-sm text-danger';
    delBtn.textContent = 'Löschen';
    delBtn.addEventListener('click', () => deleteRecipe(r.id, r.title));
    actions.append(editBtn, delBtn);
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
}

/* ---------------- Daten aus dem DOM zurueckschreiben ---------------- */
// AP3.1: "pane" (Default panes.current) bestimmt sowohl die DOM-Quelle (activeContainer(pane))
// als auch das Ziel-Datenobjekt (pane.data). Defensiv gegen "root === null": das passiert, wenn
// diese Pane gerade (auf Mobile) keine sichtbare editierbare Flaeche hat, weil die geteilte
// Tagesansicht momentan die jeweils andere Pane zeigt (siehe activeContainer()) -- ihr zuletzt
// synchronisierter Stand bleibt in diesem Fall unveraendert gueltig, es gibt nichts nachzuholen.
function syncFromDOM(pane = panes.current) {
  const root = activeContainer(pane);
  if (!root) return;
  root.querySelectorAll('[data-cell]').forEach(el => {
    const [ri, di] = el.getAttribute('data-cell').split(',').map(Number);
    if (pane.data.rows[ri]) pane.data.rows[ri].cells[di] = cellToTokens(el);
  });
  root.querySelectorAll('[data-label]').forEach(el => {
    const ri = Number(el.getAttribute('data-label'));
    if (pane.data.rows[ri]) pane.data.rows[ri].label = el.textContent.trim().slice(0, 80);
  });
  root.querySelectorAll('[data-role]').forEach(el => {
    const ri = Number(el.getAttribute('data-role'));
    if (pane.data.rows[ri]) pane.data.rows[ri].role = el.textContent.trim().slice(0, 80);
  });
  const motto = root.querySelector('[data-bind="motto"]');
  if (motto) pane.data.motto = cellToTokens(motto);
  const notes = root.querySelector('[data-bind="notes"]');
  if (notes) pane.data.notes = cellToTokens(notes);
  // AP1.2: Essensplan-Zellen sind seit dem Zell-Klick-Dialog nicht mehr contentEditable (siehe
  // buildMealCellDisplay()) -- es gibt daher kein "[data-mealcell]" mehr, ueber das hier aus dem
  // DOM zurueckgeschrieben werden muesste. Schreibzugriffe laufen jetzt ausschliesslich direkt auf
  // state.data (Wizard-Funktionen unten, seit der AP1-Korrektur auch fuer Rezept-Zuweisungen),
  // jeweils gefolgt von markDirty() -- dieselbe Debounce-/Speicherkette wie ueberall sonst, nur
  // ohne den Umweg ueber DOM-Scraping. Frueher stand hier eine eigene ".mp-cell[data-mealcell]"-
  // Sync-Schleife (siehe Git-Historie vor AP1.2), die mit dem Wegfall der contentEditable-Zellen
  // gegenstandslos geworden ist. Essensplan bleibt current-only, siehe AP3.1-Scope-Kommentare.
}

/* ---------------- Speichern ----------------
   AP3.1: eigener Debounce-Timer/"saving"-Flag JE Pane (pane.saveTimer, siehe createPane()) statt
   eines einzelnen globalen "saveTimer" -- ein Save von Woche A verzoegert/verschluckt dadurch nie
   mehr den faelligen Save von Woche B, ein 409-Konflikt einer Pane rendert nur noch diese eine
   Pane neu (renderAll(pane)), nicht mehr versehentlich unbeobachtete Eingaben der anderen. */
// "pane" als drittes, optionales Argument (statt erstes) -- damit bleiben ALLE bestehenden
// 2-Argument-Aufrufe (setStatus(text, cls)) im uebrigen, nicht am AP3.1-Umbau beteiligten Code
// unveraendert und wirken weiterhin auf panes.current.
function setStatus(text, cls, pane = panes.current) {
  // "current" nutzt weiterhin den einzigen Werkzeugleisten-Status (#status, ausserhalb jeder
  // Pane-Wurzel) -- "next" hat ihren eigenen, in ihrer Kopfzeile sichtbaren Status (Pflicht-
  // bestandteil der AP3.1-Abnahme "Kopfzeilen-Chrome pro Pane eindeutig zuordenbar").
  const el = pane === panes.current ? $('#status') : qs(pane, '.js-pane-status');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('saving', 'saved', 'error');
  if (cls) el.classList.add(cls);
  // Mobile Wochen-Umschalter-Tabs (#paneSwitch) zeigen zusaetzlich eine Kurzfassung, damit der
  // Status auch dann pane-eindeutig ablesbar bleibt, wenn die betroffene Pane gerade NICHT die im
  // gemeinsamen #dayview sichtbare ist (siehe renderPaneSwitch() weiter unten in boot()).
  if (pane.tabStatusEl) pane.tabStatusEl.textContent = text;
}
function markDirty(pane = panes.current) {
  pane.dirty = true;
  setStatus('Nicht gespeichert', 'saving', pane);
  clearTimeout(pane.saveTimer);
  pane.saveTimer = setTimeout(() => save(pane), 1000);
}
function flash(text) { const b = $('#banner'); b.textContent = text; b.classList.add('show'); setTimeout(() => b.classList.remove('show'), 5000); }

async function save(pane = panes.current) {
  clearTimeout(pane.saveTimer);
  if (pane.saving || !pane.data) return;
  syncFromDOM(pane);
  pane.saving = true;
  setStatus('Speichert …', 'saving', pane);
  try {
    const res = await api('PUT', `/api/weeks/${pane.weekStart}`, { data: pane.data, baseUpdatedAt: pane.updatedAt });
    pane.updatedAt = res.updatedAt;
    pane.dirty = false;
    setStatus('Gespeichert ' + new Date(res.updatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), 'saved', pane);
    if (pane === panes.current) refreshArchive(); // Archivliste ist current-only relevant/sichtbar
  } catch (err) {
    if (err.status === 409) {
      pane.data = err.payload.data;
      // Fokusbloecke (Datenmodell-Fokusbloecke-v2.md): siehe Kommentar in loadWeek() -- derselbe
      // Fallback fuer den Fall, dass die zwischenzeitlich vom anderen Geraet gespeicherte Woche
      // (noch) keine dieser Felder kennt.
      pane.data.goals = pane.data.goals || [];
      pane.data.highlights = pane.data.highlights || [];
      pane.data.calls = pane.data.calls || [];
      pane.updatedAt = err.payload.updatedAt;
      pane.dirty = false;
      renderAll(pane);
      setStatus('Neu geladen', 'saved', pane);
      flash((pane === panes.next ? 'Nächste Woche: ' : '') + 'Diese Woche wurde zwischenzeitlich auf einem anderen Gerät geändert. Der aktuelle Stand vom Server ist jetzt zu sehen.');
    } else {
      setStatus('Nicht gespeichert', 'error', pane);
      flash((pane === panes.next ? 'Nächste Woche – ' : '') + 'Speichern fehlgeschlagen: ' + err.message);
    }
  } finally { pane.saving = false; }
}

/* ---------------- Woche laden ----------------
   AP3.1: "pane" als zweites, optionales Argument (Default panes.current) -- bestehende
   1-Argument-Aufrufe (Wochenwahl/Prev/Next/Heute/Archiv) laden dadurch unveraendert die aktuelle
   Woche in panes.current. Am Ende (nur fuer panes.current) wird automatisch die "naechste Woche"
   (pane.weekStart + 7 Tage) in panes.next nachgeladen -- "naechste Woche" hat keine eigene Datums-/
   Archiv-Navigation, sie folgt immer der aktuellen (siehe Ruecklauf an ANORAK/JOHNSON, Frage 2).
   Ist panes.next dabei noch dirty (unges. Aenderungen aus der bisherigen "naechsten Woche"), wird
   sie durch den rekursiven loadWeek(..., panes.next)-Aufruf zuerst regulaer gespeichert (derselbe
   "if (pane.dirty) await save(pane)"-Weg wie hier oben) -- keine verlorenen Eingaben. */
async function loadWeek(iso, pane = panes.current) {
  if (pane.dirty) await save(pane);
  const res = await api('GET', `/api/weeks/${iso}`);
  pane.weekStart = res.weekStart;
  pane.data = res.data;
  // Fokusbloecke (Datenmodell-Fokusbloecke-v2.md): sehr alte, vor diesem Feature gespeicherte
  // Wochen kennen diese drei Felder eventuell noch nicht -- analog zum bestehenden Fallback in
  // importJSON() ("d.goals || []" etc.) hier ebenfalls robust gegen fehlende Schluessel
  // absichern, damit renderFocusBlocks() nicht auf "undefined" trifft.
  pane.data.goals = pane.data.goals || [];
  pane.data.highlights = pane.data.highlights || [];
  pane.data.calls = pane.data.calls || [];
  pane.updatedAt = res.updatedAt;
  pane.dirty = false;
  renderAll(pane);
  setStatus(res.exists
    ? 'Gespeichert ' + new Date(res.updatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : (res.fromTemplate ? 'Neue Woche aus Vorlage' : 'Neue Woche'), res.exists ? 'saved' : '', pane);
  if (pane === panes.current) {
    $('#archive').value = '';
    // AP2 (projects/wochenplaner-design-nacharbeiten/plan.md): Read-only-Vorschau der FOLGENDEN
    // Woche im Essensplan neu laden, sobald sich die geladene Woche aendert -- bleibt unveraendert
    // eigenstaendig neben panes.next bestehen (siehe dortiger Kommentar), bewusst NACH renderAll()
    // oben, damit die primaere Wochenansicht nicht auf den zusaetzlichen Request wartet.
    await loadNextWeekPreview();
    // AP3.1: panes.next folgt automatisch der geladenen aktuellen Woche.
    await loadWeek(addDays(pane.weekStart, 7), panes.next);
  }
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

/* ---------------- Vorlage ----------------
   AP3.1: "pane" als optionales, trailing Argument (Default panes.current) -- Teil der im Plan
   benannten "harter Kern"-Liste, bislang aber ausschliesslich ueber die bestehenden, unveraenderten
   Werkzeugleisten-Buttons (#btnTemplateApply/#btnTemplateSave) fuer panes.current verdrahtet.
   panes.next bekommt in AP3.1 bewusst keine eigene Vorlage-UI (kein Teil der Mindest-Abnahme,
   an ANORAK/JOHNSON zurueckgemeldet). */
async function applyTemplate(pane = panes.current) {
  const { template } = await api('GET', '/api/template');
  if (!template) { flash('Es ist noch keine Vorlage hinterlegt. Lege eine typische Woche an und sichere sie über „Als Vorlage sichern“.'); return; }
  syncFromDOM(pane);
  // Namen (kind+label) bereits vorhandener Zeilen merken: eine Vorlage mit weniger oder
  // anders sortierten Zeilen als die aktuelle Woche (z. B. weil vor "Als Vorlage sichern"
  // eine Zeile geloescht wurde) darf beim Auffuellen fehlender Positionen keine Zeile
  // duplizieren, die unter einem anderen Index schon existiert.
  const rowKey = r => (r.kind || '') + '|' + String(r.label || '').trim().toLowerCase();
  const existingKeys = new Set(pane.data.rows.map(rowKey));
  template.rows.forEach((trow, i) => {
    const row = pane.data.rows[i];
    if (!row) {
      const key = rowKey(trow);
      if (trow.label && existingKeys.has(key)) return; // schon vorhanden, nicht doppelt einfuegen
      pane.data.rows[i] = structuredClone(trow);
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
  pane.data.rows = pane.data.rows.filter(Boolean);
  renderAll(pane);
  markDirty(pane);
  flash('Vorlage eingefügt – vorhandene Einträge wurden nicht überschrieben.');
}
async function saveTemplate(pane = panes.current) {
  syncFromDOM(pane);
  await api('PUT', '/api/template', { data: pane.data });
  flash('Diese Woche ist jetzt die Vorlage für neue Wochen.');
}

/* ---------------- Import / Export ---------------- */
function exportJSON(pane = panes.current) {
  syncFromDOM(pane);
  const blob = new Blob([JSON.stringify({ version: 2, weekStart: pane.weekStart, ...pane.data }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wochenplan_${pane.weekStart}.json`;
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
function importJSON(file, pane = panes.current) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (d.version === 2 && Array.isArray(d.rows)) {
        pane.data = {
          version: 2, motto: d.motto || [], notes: d.notes || [],
          // Fokusbloecke (Datenmodell-Fokusbloecke-v2.md): in aelteren Export-Dateien noch
          // nicht vorhanden, daher wie motto/notes mit leerem Array abgesichert.
          goals: d.goals || [], highlights: d.highlights || [], calls: d.calls || [],
          rows: d.rows
        };
      } else if (Array.isArray(d.rows)) {                       // Format der Einzeldatei-Version
        pane.data = {
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
      renderAll(pane);
      markDirty(pane);
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
   (#nextWeekPanel). Bewusst KEIN eigener state.data/dirty/save/baseUpdatedAt-Zyklus fuer diese
   zweite Woche (MORROWs Kernempfehlung) -- nur die "mode:'week'"-Zeile wird lokal gehalten
   (nextWeekMeal), Schreibzugriffe laufen ausschliesslich ueber die gezielten Endpunkte assign-
   recipe/set-meal-cell (beide mit targetWeekStart, server.js), siehe applyMealSlotTokens()/
   submitMealSlotRecipe() weiter unten. Eigener Mobile-Tagesumschalter (nextWeekDay/#nextWeekDayNav)
   komplett unabhaengig von state.mealDay/#mpDayNav, damit ein Wechsel des Vorschau-Tages die
   aktuelle Wochenansicht nicht beeinflusst (und umgekehrt) -- dieselbe CSS-Spaltenausblendung wie
   bei #mpTable, jetzt ueber die geteilte Klasse ".mobile-day-table" (siehe style.css). ================= */
let nextWeekStart = null; // ISO-Datum (Montag) der Vorschau-Woche, == addDays(state.weekStart, 7)
let nextWeekMeal = null; // die "mode:'week'"-Zeile der Vorschau-Woche (row.meals[...]) oder null
let nextWeekDay = 0; // Mobile-Tagesumschalter der Vorschau, unabhaengig von state.mealDay

// Laedt die Vorschau neu, sobald sich die geladene Woche aendert (siehe loadWeek()). Ein
// Fehlschlag (z. B. Netzwerkproblem) blendet die Vorschau lediglich leer aus, statt das Laden der
// eigentlich geladenen Woche zu gefaehrden -- die Vorschau ist bewusst ein rein ergaenzendes,
// nicht-kritisches Feature (Stufe 1+2, kein AP0/AP1-Aequivalent an Wichtigkeit).
async function loadNextWeekPreview() {
  nextWeekStart = addDays(state.weekStart, 7);
  try {
    const res = await api('GET', `/api/weeks/${nextWeekStart}`);
    nextWeekMeal = res.data.rows.find(r => r && r.kind === 'shared' && r.mode === 'week') || null;
  } catch (err) {
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
// Zellenaenderung); fuer die AP2-Vorschau der naechsten Woche stattdessen ueber den gezielten
// set-meal-cell-Endpunkt (server.js) -- explizit OHNE state.data/dirty/save-Zyklus fuer diese
// zweite Woche (MORROWs Kernempfehlung). Kein "close"-Aufruf bei einem Fehler im Naechste-Woche-
// Fall: der Dialog bleibt offen (Schritt unveraendert), Fehlermeldung per flash() (die betroffenen
// Schritte -- Optionen/Freitext -- haben keine eigene Inline-Fehleranzeige, anders als die
// Rezeptdetails-/Einkaufstag-Schritte).
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
    await api('POST', `/api/weeks/${state.weekStart}/set-meal-cell`,
      { targetWeekStart: weekStart, dayIndex: d, slotIndex: mi, tokens });
    meal.cells[d] = tokens; // "meal" ist eine Referenz IN nextWeekMeal (siehe renderNextWeekBody()) -- Mutation wirkt sich direkt dort aus.
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
    const res = await api('POST', `/api/weeks/${state.weekStart}/assign-recipe`,
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
      const res = await api('POST', `/api/weeks/${sourceWeekStart}/add-ingredient-to-list`,
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

/* ---------------- Kontomenue ---------------- */
function openMenu() {
  const dlg = document.createElement('dialog');
  dlg.className = 'acct-dialog';
  dlg.innerHTML = `
    <div class="acct-body">
      <h2>Konto</h2>
      <p class="acct-who"></p>
      <div class="acct-actions">
        <button class="legacy-btn" data-act="invite">Familienmitglied einladen</button>
        <button class="legacy-btn" data-act="export">Diese Woche als Datei sichern</button>
        <button class="legacy-btn" data-act="import">Datei einlesen</button>
        <button class="legacy-btn" data-act="template-del">Vorlage löschen</button>
        <button class="legacy-btn" data-act="logout">Abmelden</button>
      </div>
      <div class="acct-out" data-out></div>
      <div class="acct-foot"><button class="legacy-btn" data-act="close">Schließen</button></div>
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
  // AP3.1 (Frage 3): eine frisch aufgerufene Tagesansicht zeigt immer zuerst die aktuelle Woche --
  // der Wochen-Umschalter-Tab (#paneSwitch) kann von dort aus weiterhin zur naechsten Woche
  // wechseln (siehe switchDayViewPane()).
  if (view === 'day') dayViewActivePane = panes.current;
  document.body.classList.toggle('view-day', view === 'day');
  $('#btnView').textContent = view === 'day' ? 'Wochenansicht' : 'Tagesansicht';
  if (state.data) renderAll();
  renderPaneSwitch();
}

/* AP3.1 (Frage 3, Mobile bleibt sequenziell): Wochen-Umschalter-Tab oberhalb des bestehenden
   Tages-Umschalters (#daynav) -- bestimmt, welche Pane die geteilte Tagesansicht (#dayview)
   gerade befuellt. Es gibt bewusst KEIN zweites #dayview-Markup; die jeweils inaktive Pane bleibt
   nur als JS-Objekt (Daten + Dirty-Zustand) im Speicher, geht beim Wechsel also nicht verloren. */
function renderPaneSwitch() {
  const wrap = $('#paneSwitch');
  if (!wrap) return;
  wrap.querySelectorAll('.pane-switch-btn').forEach(btn => {
    const pane = btn.dataset.pane === 'next' ? panes.next : panes.current;
    btn.setAttribute('aria-selected', String(pane === dayViewActivePane));
    // Referenz merken, damit setStatus() diese Kurzfassung bei jeder Statusaenderung live
    // mitfuehrt, auch waehrend diese Pane gerade NICHT die sichtbare ist (siehe dort).
    pane.tabStatusEl = btn.querySelector('.pane-tab-status');
  });
}
function switchDayViewPane(pane) {
  if (pane === dayViewActivePane) return;
  // Bearbeitungsstand der bisher sichtbaren Pane sichern, bevor ihr DOM-Inhalt gleich durch die
  // andere Pane ersetzt wird -- ihr Dirty-/Debounce-Zustand bleibt danach unveraendert im Speicher
  // erhalten (AP3.1-Abnahmekriterium "Dirty-Zustand geht beim Wechsel nicht verloren").
  syncFromDOM(dayViewActivePane);
  dayViewActivePane = pane;
  renderDay(pane);
  renderPaneSwitch();
}

async function boot() {
  injectSprite();
  buildPalette();
  buildLegend();

  // AP3.1: Pane-Wurzelelemente setzen, BEVOR irgendeine Render-/Load-Funktion qs(pane, ...)
  // aufruft. panes.current.root ist "#sheet" (umschliesst Kopfzeilen-Chrome/Grid/Motto/Notizen der
  // aktuellen Woche vollstaendig, siehe index.html) -- NICHT ".stage" (das waere jetzt auch das
  // Elternelement von "#nextPane" und wuerde qs(panes.current, ...) faelschlich beide Panes
  // durchsuchen lassen). panes.next.root ist die neue, eigenstaendige Kartenpane "#nextPane".
  panes.current.root = $('#sheet');
  panes.next.root = $('#nextPane');
  renderPaneSwitch();

  const me = await api('GET', '/api/me');
  state.user = me.user;
  $('#householdName').textContent = me.user.householdName;

  if (window.matchMedia('(max-width: 900px)').matches) { setView('day'); state.day = (new Date().getDay() + 6) % 7; }

  await loadWeek(isoOf(toMonday(new Date()))); // laedt panes.current UND (am Ende) panes.next, siehe loadWeek()
  await refreshArchive();
  await loadRecipes(); // AP2.2: haushaltsweit, unabhaengig von der geladenen Woche

  initMealPlanToolbar();
  initFocusBlocks();

  // AP1.2: "data-mealcell" ist mit dem Wegfall der contentEditable-Essensplan-Zellen entfallen
  // (siehe buildMealCellDisplay()/Kommentar in syncFromDOM()) -- nicht mehr Teil dieser Liste.
  // AP3.1: markDirty() bekommt jetzt die zum bearbeiteten Element gehoerende Pane explizit
  // mitgegeben (paneForElement()) -- ohne das wuerde jede Eingabe in "naechste Woche" faelschlich
  // "aktuelle Woche" als dirty markieren (beide Grids teilen sich diesen einen Listener).
  document.addEventListener('input', e => {
    const el = e.target.closest?.('[data-cell],[data-label],[data-role],[data-bind]');
    if (el) markDirty(paneForElement(el));
  });
  $('#paneSwitch')?.querySelectorAll('.pane-switch-btn').forEach(btn => {
    btn.addEventListener('click', () => switchDayViewPane(btn.dataset.pane === 'next' ? panes.next : panes.current));
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

  $('#mpPrint').onclick = () => { syncFromDOM(); document.body.classList.add('printing-mealplan'); window.print(); };

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
  });
  // AP3.1: deckt jetzt beide Panes ab -- ohne diese Ergaenzung wuerden ungesicherte Aenderungen an
  // "naechste Woche" beim Schliessen des Tabs stillschweigend verloren gehen (panes.current war
  // hier schon vor AP3.1 abgedeckt).
  window.addEventListener('beforeunload', e => {
    let willSave = false;
    if (panes.current.dirty) {
      syncFromDOM(panes.current);
      fetch(`/api/weeks/${panes.current.weekStart}`, {
        method: 'PUT', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: panes.current.data, baseUpdatedAt: panes.current.updatedAt })
      });
      willSave = true;
    }
    if (panes.next.dirty) {
      syncFromDOM(panes.next);
      fetch(`/api/weeks/${panes.next.weekStart}`, {
        method: 'PUT', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: panes.next.data, baseUpdatedAt: panes.next.updatedAt })
      });
      willSave = true;
    }
    if (!willSave) return;
    e.preventDefault(); e.returnValue = '';
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    if (panes.current.dirty) save(panes.current);
    if (panes.next.dirty) save(panes.next);
  });
}

boot().catch(err => { console.error(err); setStatus('Fehler beim Laden', 'error'); });
