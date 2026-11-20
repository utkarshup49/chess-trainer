// Page router: home -> module -> a line or a drill.
import { OpeningTrainer } from './opening.js';
import { getModuleProgress, resetModule } from './progress.js';
import { LEVELS } from './bot.js';
import { listGames, lineSummary } from './games.js';

const app = document.getElementById('app');
const cache = {};
let active = null; // the trainer currently on screen

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function loadJson(path) {
  if (!cache[path]) {
    const res = await fetch(path, { cache: 'no-cache' }); // revalidate, so new modules show up at once
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
// Two sections: openings and endgames. Each opens its own list of modules.
const SECTIONS = {
  openings: { type: 'opening', title: 'Openings', noun: 'lines',
    lede: 'Learn each repertoire move by move, test yourself on it, then play it against the bot.' },
  endgames: { type: 'endgame', title: 'Endgames', noun: 'drills',
    lede: 'Fresh positions every time, judged by whether your move keeps the result.' },
};
const sectionOf = m => (isEndgame(m) ? 'endgames' : 'openings');

function moduleCard(m) {
  const progress = getModuleProgress(m.id);
  const units = unitsOf(m);
  const done = units.filter(u => unitDone(progress, m, u)).length;
  const noun = isEndgame(m) ? 'drills' : 'lines';
  const pct = units.length ? Math.round((done / units.length) * 100) : 0;
  return `
      <a class="module-card" href="#/m/${m.id}">
        <h2>${escapeHtml(m.title)}</h2>
        <p>${escapeHtml(m.description)}</p>
        <div class="meter" aria-label="${done} of ${units.length} ${noun} played"><span style="width:${pct}%"></span></div>
        <p class="meta">${done} / ${units.length} ${noun} played</p>
      </a>`;
}

async function renderHome() {
  const modules = await loadModules();
  const cards = Object.entries(SECTIONS).map(([key, sec]) => {
    const list = modules.filter(m => m.type === sec.type);
    const units = list.reduce((n, m) => n + unitsOf(m).length, 0);
    const done = list.reduce((n, m) => {
      const progress = getModuleProgress(m.id);
      return n + unitsOf(m).filter(u => unitDone(progress, m, u)).length;
    }, 0);
    const pct = units ? Math.round((done / units) * 100) : 0;
    return `
      <a class="section-card" href="#/${key}">
        <h2>${sec.title}</h2>
        <p>${sec.lede}</p>
        <p class="names">${list.map(m => escapeHtml(m.title)).join(' · ')}</p>
        <div class="meter" aria-label="${done} of ${units} ${sec.noun} played"><span style="width:${pct}%"></span></div>
        <p class="meta">${list.length} modules · ${done} / ${units} ${sec.noun} played</p>
      </a>`;
  }).join('');

  app.innerHTML = `
    <section class="home">
      <header class="hero">
        <p class="eyebrow">Your training board</p>
        <h1>Chess Gym</h1>
        <p class="lede">Play the moves yourself. Wrong moves get explained, and the drills pick a different position every time.</p>
      </header>
      <div class="section-grid">${cards}</div>
      <a class="play-banner" href="#/play">
        <h2>Play the bot</h2>
        <p>Pick one of your openings and a bot rating from 800 to 2000. The bot can play your lines perfectly, or leave them by surprise so you learn to punish it.</p>
      </a>
    </section>`;
}

async function renderSection(key) {
  const sec = SECTIONS[key];
  const list = (await loadModules()).filter(m => m.type === sec.type);
  app.innerHTML = `
    <section class="home">
      <a class="crumb" href="#/">← Home</a>
      <header class="hero">
        <p class="eyebrow">Section</p>
        <h1>${sec.title}</h1>
        <p class="lede">${sec.lede}</p>
      </header>
      <div class="module-grid">${list.map(moduleCard).join('')}</div>
      ${key === 'openings' ? '<a class="play-banner" href="#/play"><h2>Play the bot</h2><p>Put any of these openings to work in a full game.</p></a>' : ''}
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
  const sides = [...new Set(m.lines.map(l => l.side))];
  const mixed = sides.length > 1 ? `
      <section class="mixed">
        <div>
          <h2>Both colours</h2>
          <p class="meta">A random line each round, and you don't know which colour you'll get.</p>
        </div>
        <a class="button" href="#/m/${m.id}/drill/mixed">Mixed test</a>
      </section>` : '';
  const colour = side => (side === 'white' ? 'White' : 'Black');
  const playLinks = sides.map(side => `
      <a class="button${side === sides[0] ? ' primary' : ''}" href="#/play/${m.id}/${side}/${lastRating()}/book">Book bot as ${colour(side)}</a>
      <a class="button" href="#/play/${m.id}/${side}/${lastRating()}/surprise">Surprise bot as ${colour(side)}</a>`).join('');
  return `
    <section class="portal">
      <div class="portal-head">
        <span class="step">1</span>
        <div>
          <h2>Learn the lines</h2>
          <p class="meta">Walk through each line move by move, with the point of every move explained. Nothing to get wrong here.</p>
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
      ${mixed}
      <p class="meta">Test record: ${d.played} played · ${d.clean} clean · best streak ${d.best}</p>
    </section>

    <section class="portal">
      <div class="portal-head">
        <span class="step">3</span>
        <div>
          <h2>Play it against the bot</h2>
          <p class="meta">A full game. The book bot plays your lines all the way. The surprise bot leaves them at a random moment, sometimes with a mistake you should punish. Bot rating ${lastRating()}; <a href="#/play">change it</a>.</p>
        </div>
      </div>
      <div class="actions">${playLinks}</div>
    </section>`;
}

// ---------- Endgame module ----------
function endgameBody(m, progress) {
  const cards = m.drills.map(d => {
    const s = progress.endgames[d.id] || { played: 0, clean: 0, streak: 0, best: 0 };
    const tone = s.clean ? 'good' : s.played ? 'warn' : 'idle';
    const chip = s.played ? `Clean \u00d7${s.clean} of ${s.played}` : 'Not played';
    const side = d.side === 'either' ? 'Either colour' : 'You play ' + (d.side === 'white' ? 'White' : 'Black');
    const head = `
        <div class="group-head">
          <h2>${escapeHtml(d.name)}</h2>
          <span class="chip" data-tone="${tone}">${chip}</span>
        </div>
        <p class="meta">${side}</p>
        <p>${escapeHtml(d.goal)}</p>
        ${s.best ? `<p class="meta">Best streak ${s.best}</p>` : ''}`;

    // A drill with a worked example gets two ways in: learn it, then drill it.
    if (d.demo) {
      const learned = (progress.lines[d.id] || {}).studied;
      return `
      <div class="drill-card">${head}
        <div class="actions">
          <a class="button${learned ? '' : ' primary'}" href="#/m/${m.id}/demo/${d.id}">${learned ? 'See the method again' : 'Learn the method'}</a>
          <a class="button${learned ? ' primary' : ''}" href="#/m/${m.id}/drill/${d.id}">Drill it</a>
        </div>
      </div>`;
    }
    return `
      <a class="drill-card${d.id === 'random' ? ' mixed-card' : ''}" href="#/m/${m.id}/drill/${d.id}">${head}
      </a>`;
  }).join('');

  // Older modules list their principles; newer ones carry a method per drill.
  const points = m.principles
    ? m.principles.map(p => `<li><h3>${escapeHtml(p.title)}</h3><p>${escapeHtml(p.text)}</p></li>`)
    : m.drills.filter(d => d.recipe).map(d => `
        <li><h3>${escapeHtml(d.name)}</h3>
          <ol class="method">${d.method.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol></li>`);

  return `
    <div class="drill-grid">${cards}</div>
    <section class="principles">
      <h2>${m.principles ? 'The principles behind the drills' : 'The methods'}</h2>
      <ol class="principle-list">${points.join('')}</ol>
    </section>`;
}

async function renderModule(id) {
  const m = await loadModule(id);
  if (!m) return renderMissing();
  const progress = getModuleProgress(m.id);

  app.innerHTML = `
    <section class="module">
      <a class="crumb" href="#/${sectionOf(m)}">← ${SECTIONS[sectionOf(m)].title}</a>
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

// ---------- Play the bot ----------
const RATING_KEY = 'chess-gym-bot-rating';
function lastRating() {
  try { return Number(localStorage.getItem(RATING_KEY)) || 1200; } catch (e) { return 1200; }
}
function rememberRating(r) {
  try { localStorage.setItem(RATING_KEY, String(r)); } catch (e) { /* not kept */ }
}

async function renderPlayHome() {
  const openings = (await loadModules()).filter(m => m.type === 'opening');
  const choices = openings.flatMap(m => [...new Set(m.lines.map(l => l.side))].map(side => ({ m, side })));
  let rating = lastRating();
  let lastChoice = '';
  try { lastChoice = localStorage.getItem('chess-gym-bot-opening') || ''; } catch (e) { /* none */ }
  let chosen = Math.max(0, choices.findIndex(c => `${c.m.id}/${c.side}` === lastChoice));
  let mode = 'book';
  try { mode = localStorage.getItem('chess-gym-bot-mode') || 'book'; } catch (e) { /* default */ }
  const modes = [
    { id: 'book', name: 'Book bot', text: 'Plays your prepared lines all the way, then plays the game out.' },
    { id: 'surprise', name: 'Surprise bot', text: 'Leaves your lines at a random moment (its 4th to 9th move, or never): sometimes with a good sideline, often with a mistake or blunder you should punish.' },
  ];
  const modeButtons = modes.map(x => `
    <button type="button" class="pick${x.id === mode ? ' on' : ''}" data-mode="${x.id}">
      <strong>${x.name}</strong><span class="meta">${x.text}</span>
    </button>`).join('');

  const options = choices.map((c, i) => `
    <button type="button" class="pick${i === chosen ? ' on' : ''}" data-choice="${i}">
      <strong>${escapeHtml(c.m.title)}</strong>
      <span class="meta">You play ${c.side === 'white' ? 'White' : 'Black'} · ${c.m.lines.filter(l => l.side === c.side).length} lines</span>
    </button>`).join('');
  const ratings = LEVELS.map(l => `<button type="button" class="pick rating${l.rating === rating ? ' on' : ''}" data-rating="${l.rating}">${l.rating}</button>`).join('');

  // How each opening has gone so far, line by line.
  const insight = openings.map(m => {
    const rows = lineSummary(m.id);
    if (!rows.length) return '';
    const body = rows.map(r => `
      <tr><td>${escapeHtml(r.name)}</td><td>${r.games}</td><td>${r.wins}/${r.draws}/${r.losses}</td>
        <td>${Math.round((r.points / r.games) * 100)}%</td>
        <td>${r.avgEval === null ? '–' : (r.avgEval > 0 ? '+' : '') + r.avgEval.toFixed(1)}</td></tr>`).join('');
    return `
      <section class="line-group">
        <h3>${escapeHtml(m.title)}</h3>
        <div class="table-scroll"><table class="review-table">
          <thead><tr><th>Line</th><th>Games</th><th>W/D/L</th><th>Score</th><th>Eval at end of prep</th></tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </section>`;
  }).join('');

  const surprised = listGames().filter(g => g.surprise && g.surprise.kind !== 'sound' && g.surprise.reply && 'punished' in g.surprise);
  const punished = surprised.filter(g => g.surprise.punished).length;
  const surpriseStat = surprised.length
    ? `<p class="meta">Surprise bot: you punished ${punished} of the ${surprised.length} mistakes and blunders it made when leaving your lines.</p>` : '';
  const games = listGames().slice(0, 25).map(g => {
    const when = new Date(g.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const tone = g.outcome === 'win' ? 'good' : g.outcome === 'loss' ? 'bad' : 'idle';
    const label = { win: 'Won', draw: 'Draw', loss: 'Lost' }[g.outcome];
    return `<li><a href="#/review/${g.id}">
      <span>${escapeHtml(g.moduleTitle)} · ${g.side === 'white' ? 'White' : 'Black'} vs ${g.mode === 'surprise' ? 'surprise' : 'book'} bot ${g.rating}<span class="meta"> · ${when} · ${Math.ceil(g.moves.length / 2)} moves</span></span>
      <span class="chip" data-tone="${tone}">${label}</span></a></li>`;
  }).join('');

  app.innerHTML = `
    <section class="module">
      <a class="crumb" href="#/">← Home</a>
      <header class="module-head">
        <p class="eyebrow">Practice games</p>
        <h1>Play the bot</h1>
        <p class="lede">Choose an opening and a bot rating. While the game is in your repertoire, the bot plays your prepared lines with you and the coach explains its moves. Once the lines run out, the engine plays the rest at the rating you picked.</p>
      </header>
      <section class="portal">
        <h2>1. Your opening</h2>
        <div class="pick-grid">${options}</div>
        <h2>2. Bot rating</h2>
        <div class="pick-row">${ratings}</div>
        <p class="meta">The ratings are approximate: the bot is tuned so its moves throw away about as much as a human's at that level.</p>
        <h2>3. Bot style</h2>
        <div class="pick-grid">${modeButtons}</div>
        <div class="actions"><a class="button primary" id="start" href="#">Start the game</a></div>
      </section>
      ${insight ? `<section class="portal"><h2>How your lines are going</h2><p class="meta">Score is your points per game. "Eval at end of prep" is the engine's view, in pawns from your side, at the moment your prepared moves ran out: it shows which lines leave you with good positions.</p>${insight}</section>` : ''}
      <section class="portal">
        <h2>Your games</h2>
        ${surpriseStat}
        ${games ? `<ol class="line-list">${games}</ol>` : '<p class="meta">No games yet. Your finished games appear here, with a full review.</p>'}
      </section>
      <p class="meta">The bot and the review use Stockfish (stockfish.js, GPLv3), loaded from the unpkg CDN.</p>
    </section>`;

  const start = document.getElementById('start');
  const update = () => {
    const c = choices[chosen];
    start.href = c ? `#/play/${c.m.id}/${c.side}/${rating}/${mode}` : '#/play';
  };
  app.querySelectorAll('[data-choice]').forEach(b => {
    b.onclick = () => {
      chosen = Number(b.dataset.choice);
      app.querySelectorAll('[data-choice]').forEach(x => x.classList.toggle('on', x === b));
      update();
    };
  });
  app.querySelectorAll('[data-mode]').forEach(b => {
    b.onclick = () => {
      mode = b.dataset.mode;
      try { localStorage.setItem('chess-gym-bot-mode', mode); } catch (e) { /* not kept */ }
      app.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
      update();
    };
  });
  app.querySelectorAll('[data-rating]').forEach(b => {
    b.onclick = () => {
      rating = Number(b.dataset.rating);
      rememberRating(rating);
      app.querySelectorAll('[data-rating]').forEach(x => x.classList.toggle('on', x === b));
      update();
    };
  });
  update();
}

async function renderGame(id, side, rating, mode = 'book') {
  const m = await loadModule(id);
  if (!m || m.type !== 'opening' || !m.lines.some(l => l.side === side)) return renderMissing();
  rememberRating(rating);
  try { localStorage.setItem('chess-gym-bot-opening', `${id}/${side}`); } catch (e) { /* not kept */ }
  const { BotGame } = await import('./play.js');
  active = new BotGame(app, m, { side, rating: Number(rating), mode });
}

// ---------- Training ----------
async function renderTrainer(id, mode, arg) {
  const m = await loadModule(id);
  if (!m) return renderMissing();

  if (isEndgame(m)) {
    const drill = m.drills.find(d => d.id === arg);
    if (!drill) return renderMissing();
    // A drill's worked example, stepped through like an opening line.
    if (mode === 'demo' && drill.demo) {
      const { LineStudy } = await import('./study.js');
      const demo = { ...drill.demo, id: drill.id, name: drill.name, idea: drill.idea };
      active = new LineStudy(app, m, { demo });
      return;
    }
    if (mode !== 'drill') return renderMissing();
    if (m.engine === 'tablebase') {
      const { TablebaseTrainer } = await import('./tbdrill.js');
      active = new TablebaseTrainer(app, m, { drillId: arg });
      return;
    }
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
  const parts = location.hash.replace(/^#\/?/, '').replace(/\?.*$/, '').split('/').filter(Boolean);
  try {
    if (parts.length === 0) await renderHome();
    else if (parts.length === 1 && SECTIONS[parts[0]]) await renderSection(parts[0]);
    else if (parts[0] === 'play' && parts.length === 1) await renderPlayHome();
    else if (parts[0] === 'play' && (parts.length === 4 || parts.length === 5)) await renderGame(parts[1], parts[2], parts[3], parts[4]);
    else if (parts[0] === 'review' && parts.length === 2) {
      const { GameReview } = await import('./review.js');
      active = new GameReview(app, parts[1]);
    }
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
