// Page router: home -> module -> a line or a drill.
import { OpeningTrainer } from './opening.js';
import { getModuleProgress, resetModule } from './progress.js';

const app = document.getElementById('app');
const cache = {};
let active = null; // the trainer currently on screen

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function loadJson(path) {
  if (!cache[path]) {
    const res = await fetch(path);
    if (!res.ok) throw new Error('Could not load ' + path);
    cache[path] = await res.json();
  }
  return cache[path];
}

async function loadModules() {
  const list = await loadJson('modules/index.json');
  return Promise.all(list.map(entry => loadJson(entry.file)));
}

async function loadModule(id) {
  return (await loadModules()).find(m => m.id === id);
}

const isEndgame = m => m.type === 'endgame';
const unitsOf = m => (isEndgame(m) ? m.drills : m.lines);

function unitDone(progress, m, unit) {
  if (isEndgame(m)) {
    const s = progress.endgames[unit.id];
    return Boolean(s && s.played);
  }
  const p = progress.lines[unit.id];
  return Boolean(p && p.done);
}

function lineStatus(progress, lineId) {
  const p = progress.lines[lineId];
  if (!p || !p.done) return { text: 'Not played', tone: 'idle' };
  if (p.clean) return { text: 'Clean ×' + p.clean, tone: 'good' };
  return { text: 'Done ×' + p.done, tone: 'warn' };
}

// ---------- Home ----------
async function renderHome() {
  const modules = await loadModules();
  const cards = modules.map(m => {
    const progress = getModuleProgress(m.id);
    const units = unitsOf(m);
    const done = units.filter(u => unitDone(progress, m, u)).length;
    const noun = isEndgame(m) ? 'drills' : 'lines';
    const pct = units.length ? Math.round((done / units.length) * 100) : 0;
    return `
      <a class="module-card" href="#/m/${m.id}">
        <span class="tag">${isEndgame(m) ? 'Endgame' : 'Opening'}</span>
        <h2>${escapeHtml(m.title)}</h2>
        <p>${escapeHtml(m.description)}</p>
        <div class="meter" aria-label="${done} of ${units.length} ${noun} played"><span style="width:${pct}%"></span></div>
        <p class="meta">${done} / ${units.length} ${noun} played</p>
      </a>`;
  }).join('');

  app.innerHTML = `
    <section class="home">
      <header class="hero">
        <p class="eyebrow">Your training board</p>
        <h1>Chess Gym</h1>
        <p class="lede">Play the moves yourself. Wrong moves get explained, and the drills pick a different position every time.</p>
      </header>
      <div class="module-grid">${cards}</div>
    </section>`;
}

// ---------- Opening module ----------
function openingBody(m, progress) {
  const group = (side, sideLabel) => {
    const lines = m.lines.filter(l => l.side === side);
    if (!lines.length) return '';
    const done = lines.filter(l => progress.lines[l.id] && progress.lines[l.id].done).length;
    const items = lines.map(l => {
      const s = lineStatus(progress, l.id);
      return `<li><a href="#/m/${m.id}/learn/${l.id}"><span>${escapeHtml(l.name)}</span><span class="chip" data-tone="${s.tone}">${s.text}</span></a></li>`;
    }).join('');
    const drill = done === lines.length
      ? `<a class="button primary" href="#/m/${m.id}/drill/${side}">Random drill: ${sideLabel} lines</a>`
      : `<div class="locked"><p>Play all ${lines.length} ${sideLabel} lines once to unlock the random drill (${done}/${lines.length}).</p>
         <a class="small-link" href="#/m/${m.id}/drill/${side}">Start the drill anyway</a></div>`;
    return `
      <section class="line-group">
        <div class="group-head"><h2>You play ${sideLabel}</h2><span class="meta">${done}/${lines.length}</span></div>
        <ol class="line-list">${items}</ol>
        ${drill}
      </section>`;
  };

  const d = progress.drill;
  return `
    <div class="groups">${group('white', 'White')}${group('black', 'Black')}</div>
    <section class="mixed">
      <div>
        <h2>Both colours</h2>
        <p class="meta">A random line each round, and you don't know which colour you'll get.</p>
      </div>
      <a class="button" href="#/m/${m.id}/drill/mixed">Mixed drill</a>
    </section>
    <p class="meta">Drill record: ${d.played} played · ${d.clean} clean · best streak ${d.best}</p>`;
}

// ---------- Endgame module ----------
function endgameBody(m, progress) {
  const cards = m.drills.map(d => {
    const s = progress.endgames[d.id] || { played: 0, clean: 0, streak: 0, best: 0 };
    const tone = s.clean ? 'good' : s.played ? 'warn' : 'idle';
    const chip = s.played ? `Clean ×${s.clean} of ${s.played}` : 'Not played';
    return `
      <a class="drill-card" href="#/m/${m.id}/drill/${d.id}">
        <div class="group-head">
          <h2>${escapeHtml(d.name)}</h2>
          <span class="chip" data-tone="${tone}">${chip}</span>
        </div>
        <p class="meta">You play ${d.side === 'white' ? 'White' : 'Black'}</p>
        <p>${escapeHtml(d.goal)}</p>
        ${s.best ? `<p class="meta">Best streak ${s.best}</p>` : ''}
      </a>`;
  }).join('');

  const principles = m.principles.map(p => `
    <li><h3>${escapeHtml(p.title)}</h3><p>${escapeHtml(p.text)}</p></li>`).join('');

  return `
    <div class="drill-grid">${cards}</div>
    <section class="principles">
      <h2>The principles behind the drills</h2>
      <ol class="principle-list">${principles}</ol>
    </section>`;
}

async function renderModule(id) {
  const m = await loadModule(id);
  if (!m) return renderMissing();
  const progress = getModuleProgress(m.id);

  app.innerHTML = `
    <section class="module">
      <a class="crumb" href="#/">← All modules</a>
      <header class="module-head">
        <p class="eyebrow">${isEndgame(m) ? 'Endgame' : 'Opening'} module</p>
        <h1>${escapeHtml(m.title)}</h1>
        <p class="lede">${escapeHtml(m.description)}</p>
        <p class="meta">${escapeHtml(m.source || '')}</p>
      </header>
      ${isEndgame(m) ? endgameBody(m, progress) : openingBody(m, progress)}
      <section class="stats">
        <button type="button" class="small-link" id="reset">Reset progress</button>
        <span id="reset-confirm" hidden>Delete all progress for this module?
          <button type="button" class="small-link danger" id="reset-yes">Yes, reset</button>
          <button type="button" class="small-link" id="reset-no">Cancel</button></span>
      </section>
    </section>`;

  const confirmBox = document.getElementById('reset-confirm');
  document.getElementById('reset').onclick = () => { confirmBox.hidden = false; };
  document.getElementById('reset-no').onclick = () => { confirmBox.hidden = true; };
  document.getElementById('reset-yes').onclick = () => { resetModule(m.id); renderModule(m.id); };
}

// ---------- Training ----------
async function renderTrainer(id, mode, arg) {
  const m = await loadModule(id);
  if (!m) return renderMissing();

  if (isEndgame(m)) {
    if (mode !== 'drill' || !m.drills.some(d => d.id === arg)) return renderMissing();
    const { EndgameTrainer } = await import('./endgame.js');
    active = new EndgameTrainer(app, m, { drillId: arg });
    return;
  }

  if (mode === 'learn' && !m.lines.some(l => l.id === arg)) return renderMissing();
  active = new OpeningTrainer(app, m, mode === 'learn' ? { mode, lineId: arg } : { mode, side: arg });
}

function renderMissing() {
  app.innerHTML = `<section class="module"><h1>Page not found</h1><p><a href="#/">Back to all modules</a></p></section>`;
}

async function route() {
  if (active) {
    active.destroy();
    active = null;
  }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (parts.length === 0) await renderHome();
    else if (parts[0] === 'm' && parts.length === 2) await renderModule(parts[1]);
    else if (parts[0] === 'm' && parts.length === 4) await renderTrainer(parts[1], parts[2], parts[3]);
    else renderMissing();
  } catch (e) {
    app.innerHTML = `<section class="module"><h1>Something went wrong</h1><p>${escapeHtml(e.message)}</p><p>Check your connection and reload the page.</p></section>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
