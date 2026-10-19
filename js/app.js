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
  const p = progress.lines[lineId] || {};
  if (p.clean) return { text: 'Passed ×' + p.clean, tone: 'good' };
  if (p.done) return { text: 'Tested ×' + p.done, tone: 'warn' };
  if (p.studied) return { text: 'Learned', tone: 'warn' };
  return { text: 'New', tone: 'idle' };
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
// Two ways in: learn the lines first, then be tested on them.
function openingBody(m, progress) {
  const studied = id => Boolean((progress.lines[id] || {}).studied);
  const tested = id => Boolean((progress.lines[id] || {}).done);

  const learnGroup = (side, sideLabel) => {
    const lines = m.lines.filter(l => l.side === side);
    if (!lines.length) return '';
    const done = lines.filter(l => studied(l.id)).length;
    const items = lines.map(l => `
      <li><a href="#/m/${m.id}/study/${l.id}">
        <span>${escapeHtml(l.name)}</span>
        <span class="chip" data-tone="${studied(l.id) ? 'good' : 'idle'}">${studied(l.id) ? 'Learned' : 'New'}</span>
      </a></li>`).join('');
    return `
      <section class="line-group">
        <div class="group-head"><h2>You play ${sideLabel}</h2><span class="meta">${done}/${lines.length}</span></div>
        <ol class="line-list">${items}</ol>
      </section>`;
  };

  const testGroup = (side, sideLabel) => {
    const lines = m.lines.filter(l => l.side === side);
    if (!lines.length) return '';
    const done = lines.filter(l => tested(l.id)).length;
    const ready = lines.filter(l => studied(l.id)).length;
    const items = lines.map(l => {
      const st = lineStatus(progress, l.id);
      return `<li><a href="#/m/${m.id}/practice/${l.id}"><span>${escapeHtml(l.name)}</span><span class="chip" data-tone="${st.tone}">${st.text}</span></a></li>`;
    }).join('');
    const hint = ready < lines.length
      ? `<p class="meta">${ready} of ${lines.length} learned so far. The random test works either way.</p>` : '';
    return `
      <section class="line-group">
        <div class="group-head"><h2>You play ${sideLabel}</h2><span class="meta">${done}/${lines.length} tested</span></div>
        <a class="button primary" href="#/m/${m.id}/drill/${side}">Random ${sideLabel} line</a>
        ${hint}
        <details class="line-picker">
          <summary>Test one line at a time</summary>
          <ol class="line-list">${items}</ol>
        </details>
      </section>`;
  };

  const d = progress.drill;
  const learnedAll = m.lines.every(l => studied(l.id));
  return `
    <section class="portal">
      <div class="portal-head">
        <span class="step">1</span>
        <div>
          <h2>Learn the lines</h2>
          <p class="meta">Walk through each trap move by move, with the point of every move explained. Nothing to get wrong here.</p>
        </div>
      </div>
      <div class="groups">${learnGroup('white', 'White')}${learnGroup('black', 'Black')}</div>
    </section>

    <section class="portal">
      <div class="portal-head">
        <span class="step">2</span>
        <div>
          <h2>Test yourself</h2>
          <p class="meta">${learnedAll
            ? 'You have been through every line. Now find the moves without help.'
            : 'A random line each round, and you have to find the moves yourself.'}</p>
        </div>
      </div>
      <div class="groups">${testGroup('white', 'White')}${testGroup('black', 'Black')}</div>
      <section class="mixed">
        <div>
          <h2>Both colours</h2>
          <p class="meta">A random line each round, and you don't know which colour you'll get.</p>
        </div>
        <a class="button" href="#/m/${m.id}/drill/mixed">Mixed test</a>
      </section>
      <p class="meta">Test record: ${d.played} played · ${d.clean} clean · best streak ${d.best}</p>
    </section>`;
}

// ---------- Endgame module ----------
function endgameBody(m, progress) {
  const cards = m.drills.map(d => {
    const s = progress.endgames[d.id] || { played: 0, clean: 0, streak: 0, best: 0 };
    const tone = s.clean ? 'good' : s.played ? 'warn' : 'idle';
    const chip = s.played ? `Clean ×${s.clean} of ${s.played}` : 'Not played';
    return `
      <a class="drill-card${d.id === 'random' ? ' mixed-card' : ''}" href="#/m/${m.id}/drill/${d.id}">
        <div class="group-head">
          <h2>${escapeHtml(d.name)}</h2>
          <span class="chip" data-tone="${tone}">${chip}</span>
        </div>
        <p class="meta">${d.side === 'either' ? 'Either colour' : 'You play ' + (d.side === 'white' ? 'White' : 'Black')}</p>
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

  // 'learn' is the old name for 'practice'; keep it working for saved links.
  const perLine = mode === 'study' || mode === 'practice' || mode === 'learn';
  if (perLine && !m.lines.some(l => l.id === arg)) return renderMissing();

  if (mode === 'study') {
    const { LineStudy } = await import('./study.js');
    active = new LineStudy(app, m, { lineId: arg });
    return;
  }
  if (perLine) {
    active = new OpeningTrainer(app, m, { mode: 'learn', lineId: arg });
    return;
  }
  active = new OpeningTrainer(app, m, { mode, side: arg });
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
