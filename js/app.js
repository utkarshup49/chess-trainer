// Page router: home -> module -> learn / drill.
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
  const modules = await loadModules();
  return modules.find(m => m.id === id);
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
    const done = m.lines.filter(l => progress.lines[l.id] && progress.lines[l.id].done).length;
    const pct = Math.round((done / m.lines.length) * 100);
    return `
      <a class="module-card" href="#/m/${m.id}">
        <span class="tag">${m.type === 'opening' ? 'Opening' : 'Endgame'}</span>
        <h2>${escapeHtml(m.title)}</h2>
        <p>${escapeHtml(m.description)}</p>
        <div class="meter" aria-label="${done} of ${m.lines.length} lines played"><span style="width:${pct}%"></span></div>
        <p class="meta">${done} / ${m.lines.length} lines played</p>
      </a>`;
  }).join('');

  app.innerHTML = `
    <section class="home">
      <header class="hero">
        <p class="eyebrow">Your training board</p>
        <h1>Chess Gym</h1>
        <p class="lede">Play the moves yourself. Wrong moves get explained, and the drills pick a different line every time.</p>
      </header>
      <div class="module-grid">${cards}</div>
    </section>`;
}

// ---------- Module page ----------
async function renderModule(id) {
  const m = await loadModule(id);
  if (!m) return renderMissing();
  const progress = getModuleProgress(m.id);

  const group = (side, label) => {
    const lines = m.lines.filter(l => l.side === side);
    if (!lines.length) return '';
    const done = lines.filter(l => progress.lines[l.id] && progress.lines[l.id].done).length;
    const items = lines.map(l => {
      const s = lineStatus(progress, l.id);
      return `<li><a href="#/m/${m.id}/learn/${l.id}"><span>${escapeHtml(l.name)}</span><span class="chip" data-tone="${s.tone}">${s.text}</span></a></li>`;
    }).join('');
    const unlocked = done === lines.length;
    const drill = unlocked
      ? `<a class="button primary" href="#/m/${m.id}/drill/${side}">Random drill: ${label} lines</a>`
      : `<div class="locked"><p>Play all ${lines.length} ${label} lines once to unlock the random drill (${done}/${lines.length}).</p>
         <a class="small-link" href="#/m/${m.id}/drill/${side}">Start the drill anyway</a></div>`;
    return `
      <section class="line-group">
        <div class="group-head"><h2>You play ${label}</h2><span class="meta">${done}/${lines.length}</span></div>
        <ol class="line-list">${items}</ol>
        ${drill}
      </section>`;
  };

  const d = progress.drill;
  app.innerHTML = `
    <section class="module">
      <a class="crumb" href="#/">← All modules</a>
      <header class="module-head">
        <p class="eyebrow">${m.type === 'opening' ? 'Opening' : 'Endgame'} module</p>
        <h1>${escapeHtml(m.title)}</h1>
        <p class="lede">${escapeHtml(m.description)}</p>
        <p class="meta">${escapeHtml(m.source || '')}</p>
      </header>
      <div class="groups">
        ${group('white', 'White')}
        ${group('black', 'Black')}
      </div>
      <section class="mixed">
        <div>
          <h2>Both colours</h2>
          <p class="meta">A random line each round, and you don't know which colour you'll get.</p>
        </div>
        <a class="button" href="#/m/${m.id}/drill/mixed">Mixed drill</a>
      </section>
      <section class="stats">
        <p class="meta">Drill record: ${d.played} played · ${d.clean} clean · best streak ${d.best}</p>
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
  if (m.type === 'opening') {
    if (mode === 'learn' && !m.lines.some(l => l.id === arg)) return renderMissing();
    active = new OpeningTrainer(app, m, mode === 'learn' ? { mode, lineId: arg } : { mode, side: arg });
  }
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
