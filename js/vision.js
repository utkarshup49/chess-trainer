// Board vision: know every square without looking at the coordinates.
//
// Two drills, both with a 30-second round or untimed practice:
//   Find: a square name appears over the board; tap that square.
//   Name: a square lights up; pick its name from four.
// Every answer is timed and remembered per square (separately for each drill
// and for White's and Black's side of the board). Squares you miss or are slow
// on come up more often, and the map below the board shows where you hesitate.
import { Chessground } from 'https://cdn.jsdelivr.net/npm/chessground@9.2.1/+esm';
import { markActive } from './activity.js';

const KEY = 'chess-gym-vision-v1';
const ROUND_SECONDS = 30;
const FILES = 'abcdefgh';
const SQUARES = [...FILES].flatMap(f => [1, 2, 3, 4, 5, 6, 7, 8].map(r => f + r));
const MODES = {
  find: { name: 'Find', help: 'Tap the square named on the board.' },
  name: { name: 'Name', help: 'Pick the name of the lit square.' },
};

// ---------- Saved stats ----------
function load() {
  let data;
  try { data = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { data = {}; }
  // Older saves kept the find drill's stats at the top level.
  if (data.white || data.black) {
    data.find = { white: data.white || {}, black: data.black || {} };
    delete data.white;
    delete data.black;
  }
  data.find = data.find || {};
  data.name = data.name || {};
  data.best = data.best || {};
  data.rounds = data.rounds || [];
  return data;
}
function save(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* not kept */ }
}
const statsFor = (mode, view) => load()[mode][view] || {};

function record(mode, view, square, ms, missed) {
  const data = load();
  const s = (data[mode][view] = data[mode][view] || {});
  const sq = s[square] || { tries: 0, misses: 0, ms: null };
  sq.tries += 1;
  if (missed) sq.misses += 1;
  // A moving average, so the map follows how you are doing now.
  else sq.ms = sq.ms === null ? ms : Math.round(sq.ms * 0.7 + ms * 0.3);
  s[square] = sq;
  save(data);
}

// Weaker squares are picked more often; unseen squares count as weak.
function pickSquare(mode, view, previous) {
  const s = statsFor(mode, view);
  const weights = SQUARES.map(sq => {
    if (sq === previous) return 0;
    const st = s[sq];
    if (!st || !st.tries) return 3;
    const slow = st.ms ? Math.min(3, st.ms / 1500) : 1.5;
    return 0.5 + slow + (st.misses / st.tries) * 6;
  });
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < SQUARES.length; i++) {
    r -= weights[i];
    if (r <= 0) return SQUARES[i];
  }
  return SQUARES[0];
}

// Four names to choose from: the answer and three near misses (the mirror
// square, or one square along the file or rank: the usual confusions).
function choicesFor(square) {
  const f = FILES.indexOf(square[0]), r = Number(square[1]);
  const near = new Set([
    FILES[7 - f] + r, FILES[f] + (9 - r), FILES[7 - f] + (9 - r),
    FILES[Math.max(0, f - 1)] + r, FILES[Math.min(7, f + 1)] + r,
    FILES[f] + Math.max(1, r - 1), FILES[f] + Math.min(8, r + 1),
  ]);
  near.delete(square);
  const pool = [...near].sort(() => Math.random() - 0.5).slice(0, 3);
  return [square, ...pool].sort(() => Math.random() - 0.5);
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export class VisionTrainer {
  constructor(container) {
    this.container = container;
    this.mode = 'find';
    this.side = 'white';      // the choice: white, black or random
    this.view = 'white';      // the side actually shown
    this.running = false;
    this.render();
  }

  destroy() {
    clearInterval(this.ticker);
    clearTimeout(this.flashTimer);
    if (this.cg) this.cg.destroy();
  }

  render() {
    this.container.innerHTML = `
      <section class="vt">
        <header class="vt-top">
          <a class="crumb" href="#/">← Home</a>
          <h1>Board vision</h1>
        </header>
        <div class="vt-controls" role="group" aria-label="Drill settings">
          <div class="seg">
            ${Object.entries(MODES).map(([k, m]) => `<button type="button" data-mode="${k}" aria-pressed="${k === this.mode}">${m.name}</button>`).join('')}
          </div>
          <div class="seg">
            <button type="button" data-side="white" aria-pressed="true">White</button>
            <button type="button" data-side="black" aria-pressed="false">Black</button>
            <button type="button" data-side="random" aria-pressed="false">Random</button>
          </div>
        </div>
        <div class="vt-stage">
          <div class="vt-timer" aria-hidden="true"><span id="timebar"></span></div>
          <div class="vt-board">
            <div class="board-wrap" id="vboard"><div class="board-surface"></div></div>
            <div class="vt-overlay" id="overlay" aria-live="polite"></div>
          </div>
          <div class="vt-choices" id="choices" hidden></div>
          <div class="vt-score">
            <div><b id="s-found">0</b><span>found</span></div>
            <div><b id="s-missed">0</b><span>missed</span></div>
            <div><b id="s-best">–</b><span>best round</span></div>
          </div>
          <div class="vt-actions">
            <button type="button" class="primary" id="btn-start">Start 30s round</button>
            <button type="button" id="btn-practice">Practise</button>
          </div>
        </div>
        <section class="vt-map">
          <div class="vt-map-head">
            <h2>Your map</h2>
            <p class="meta" id="map-caption"></p>
          </div>
          <div class="vt-map-body">
            <div class="heat" id="heat"></div>
            <div class="vt-facts" id="facts"></div>
          </div>
        </section>
      </section>`;
    const $ = id => this.container.querySelector('#' + id);
    this.el = {
      board: $('vboard'), overlay: $('overlay'), choices: $('choices'), timebar: $('timebar'),
      found: $('s-found'), missed: $('s-missed'), best: $('s-best'), heat: $('heat'), facts: $('facts'),
      caption: $('map-caption'), start: $('btn-start'), practice: $('btn-practice'),
    };
    this.el.start.onclick = () => (this.running ? this.stop() : this.start(true));
    this.el.practice.onclick = () => (this.running ? this.stop() : this.start(false));
    this.el.choices.onclick = e => {
      const b = e.target.closest('[data-sq]');
      if (b) this.answer(b.dataset.sq, b);
    };
    this.container.querySelectorAll('[data-mode]').forEach(b => {
      b.onclick = () => this.setSetting(() => { this.mode = b.dataset.mode; }, '[data-mode]', b);
    });
    this.container.querySelectorAll('[data-side]').forEach(b => {
      b.onclick = () => this.setSetting(() => { this.side = b.dataset.side; }, '[data-side]', b);
    });
    this.drawBoard();
    this.idle();
  }

  // Changing a setting ends a practice run (a timed round must finish first).
  setSetting(apply, selector, button) {
    if (this.running && this.timed) return;
    if (this.running) this.stop(true);
    apply();
    this.container.querySelectorAll(selector).forEach(x => x.setAttribute('aria-pressed', String(x === button)));
    this.view = this.side === 'random' ? 'white' : this.side;
    this.cg.set({ orientation: this.view });
    this.idle();
  }

  drawBoard() {
    this.cg = Chessground(this.el.board.querySelector('.board-surface'), {
      fen: '8/8/8/8/8/8/8/8',
      orientation: this.view,
      coordinates: false,
      highlight: { lastMove: false, check: false },
      movable: { free: false, color: undefined },
      draggable: { enabled: false },
      premovable: { enabled: false },
      drawable: { enabled: false },
      blockTouchScroll: true, // a tap counts once (no extra emulated mouse click)
      events: { select: sq => { if (this.mode === 'find') this.answer(sq); } },
    });
  }

  // Colour a few squares, for a moment if ms is given: { e4: 'vt-hit' }.
  paint(classes, ms) {
    this.cg.set({ highlight: { custom: new Map(Object.entries(classes)) } });
    clearTimeout(this.flashTimer);
    if (ms) this.flashTimer = setTimeout(() => this.paint(this.baseClasses(), 0), ms);
  }

  baseClasses() {
    return this.running && this.mode === 'name' && this.current ? { [this.current]: 'vt-target' } : {};
  }

  idle() {
    const best = load().best[`${this.mode}-${this.side}`];
    this.el.best.textContent = best || '–';
    this.el.found.textContent = '0';
    this.el.missed.textContent = '0';
    this.el.choices.hidden = true;
    this.el.timebar.style.width = '100%';
    this.el.timebar.classList.remove('low');
    this.showOverlay(`<span class="vt-hint">${MODES[this.mode].help}</span>`);
    this.paint({}, 0);
    this.setButtons();
    this.drawMap();
  }

  setButtons() {
    this.el.start.textContent = this.running && this.timed ? 'Stop' : 'Start 30s round';
    this.el.practice.textContent = this.running && !this.timed ? 'Stop practising' : 'Practise';
    this.el.start.hidden = this.running && !this.timed;
    this.el.practice.hidden = this.running && this.timed;
  }

  showOverlay(html, kind = '') {
    this.el.overlay.innerHTML = html;
    this.el.overlay.className = 'vt-overlay ' + kind;
  }

  start(timed) {
    clearInterval(this.ticker);
    this.running = true;
    this.timed = timed;
    this.score = 0;
    this.missedCount = 0;
    this.previous = null;
    this.view = this.side === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : this.side;
    this.cg.set({ orientation: this.view });
    this.el.found.textContent = '0';
    this.el.missed.textContent = '0';
    if (timed) {
      this.endsAt = Date.now() + ROUND_SECONDS * 1000;
      this.ticker = setInterval(() => this.tick(), 100);
    }
    this.setButtons();
    this.drawMap();
    this.next();
  }

  tick() {
    const left = Math.max(0, this.endsAt - Date.now());
    this.el.timebar.style.width = (left / (ROUND_SECONDS * 1000)) * 100 + '%';
    this.el.timebar.classList.toggle('low', left < 5000);
    if (left <= 0) this.stop();
  }

  next() {
    this.current = pickSquare(this.mode, this.view, this.previous);
    this.previous = this.current;
    this.shownAt = performance.now();
    if (this.mode === 'find') {
      this.showOverlay(`<span class="vt-coord">${this.current}</span>`);
      this.el.choices.hidden = true;
      // Restart the pop animation for the new name.
      void this.el.overlay.offsetWidth;
      this.el.overlay.classList.add('pop');
    } else {
      this.showOverlay('');
      this.el.choices.innerHTML = choicesFor(this.current).map(sq => `<button type="button" data-sq="${sq}">${sq}</button>`).join('');
      this.el.choices.hidden = false;
    }
    this.paint(this.baseClasses(), 0);
  }

  answer(square, button) {
    if (!this.running || !this.current) return;
    // Guard against one tap arriving twice (touch, then mouse).
    const now = performance.now();
    if (now - (this.lastTap || 0) < 250) return;
    this.lastTap = now;
    const target = this.current;
    const ms = Math.round(now - this.shownAt);
    const right = square === target;
    record(this.mode, this.view, target, ms, !right);
    markActive();
    if (right) {
      this.score += 1;
      this.paint({ [target]: 'vt-hit' }, 300);
      if (button) button.classList.add('hit');
    } else {
      this.missedCount += 1;
      // Show where it really was.
      this.paint(this.mode === 'find' ? { [square]: 'vt-miss', [target]: 'vt-answer' } : { [target]: 'vt-answer' }, 800);
      if (button) button.classList.add('miss');
    }
    this.el.found.textContent = this.score;
    this.el.missed.textContent = this.missedCount;
    if (!this.timed && (this.score + this.missedCount) % 5 === 0) this.drawMap();
    if (this.mode === 'name') {
      this.current = null; // no double answers while the result shows
      setTimeout(() => { if (this.running) this.next(); }, right ? 250 : 800);
    } else {
      this.next();
    }
  }

  stop(quiet = false) {
    clearInterval(this.ticker);
    const wasTimed = this.timed;
    this.running = false;
    this.current = null;
    this.el.choices.hidden = true;
    this.paint({}, 0);
    this.setButtons();
    if (quiet) return;
    if (!wasTimed) return this.idle();
    const data = load();
    const key = `${this.mode}-${this.side}`;
    const best = data.best[key] || 0;
    if (this.score > best) data.best[key] = this.score;
    data.rounds.push({ mode: this.mode, side: this.side, score: this.score, missed: this.missedCount, at: Date.now() });
    data.rounds = data.rounds.slice(-40);
    save(data);
    this.el.best.textContent = Math.max(best, this.score) || '–';
    const accuracy = pct(this.score, this.score + this.missedCount);
    this.showOverlay(`
      <span class="vt-result">${this.score}</span>
      <span class="vt-hint">${this.score > best ? 'New best!' : `Your best is ${best}.`} ${accuracy}% right.</span>`, 'done');
    this.drawMap();
  }

  // The map: the board as you see it, each square coloured by how you do on it.
  drawMap() {
    const view = this.view;
    const s = statsFor(this.mode, view);
    const ranks = view === 'white' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const files = view === 'white' ? [...FILES] : [...FILES].reverse();
    const order = ranks.flatMap(r => files.map(f => f + r));
    this.el.heat.innerHTML = order.map(sq => {
      const st = s[sq];
      const dark = (FILES.indexOf(sq[0]) + Number(sq[1])) % 2 === 1; // a1 is dark
      let style = '';
      if (st && st.tries) {
        const slow = st.ms ? Math.min(1, Math.max(0, (st.ms - 700) / 2300)) : 1;
        const bad = Math.min(1, slow * 0.7 + (st.misses / st.tries) * 1.5);
        style = ` style="background:hsl(${Math.round(130 - 130 * bad)} 55% ${dark ? 36 : 44}%)"`;
      }
      const tip = st && st.tries ? `${sq}: ${st.ms ? (st.ms / 1000).toFixed(1) + ' s' : 'no time yet'}, ${st.misses} missed of ${st.tries}` : `${sq}: not tried yet`;
      return `<span class="hsq ${dark ? 'dark' : 'light'}${st && st.tries ? ' seen' : ''}"${style} title="${tip}">${sq}</span>`;
    }).join('');

    const tried = Object.entries(s).filter(([, st]) => st.tries);
    const tries = tried.reduce((n, [, st]) => n + st.tries, 0);
    const misses = tried.reduce((n, [, st]) => n + st.misses, 0);
    const times = tried.map(([, st]) => st.ms).filter(Boolean);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length / 1000 : null;
    const weak = tried
      .map(([sq, st]) => ({ sq, score: (st.ms || 3000) + 2000 * (st.misses / st.tries) }))
      .sort((a, b) => b.score - a.score).slice(0, 5).map(x => x.sq);
    const rounds = load().rounds.filter(r => r.mode === this.mode).slice(-12);
    const top = Math.max(1, ...rounds.map(r => r.score));
    this.el.caption.textContent = `${MODES[this.mode].name} drill, seen from ${view === 'white' ? "White's" : "Black's"} side. Green squares are quick; red ones are slow or missed.`;
    this.el.facts.innerHTML = tried.length ? `
      <dl>
        <div><dt>Squares tried</dt><dd>${tried.length}/64</dd></div>
        <div><dt>Right first time</dt><dd>${pct(tries - misses, tries)}%</dd></div>
        <div><dt>Average time</dt><dd>${avg ? avg.toFixed(1) + 's' : '–'}</dd></div>
      </dl>
      <p class="vt-weak">Slowest: ${weak.map(w => `<span class="sq-chip">${w}</span>`).join('')}</p>
      ${rounds.length ? `
        <div class="vt-rounds" role="img" aria-label="Your last timed rounds">${rounds.map(r => `<span style="height:${Math.max(10, (r.score / top) * 100)}%"><i>${r.score}</i></span>`).join('')}</div>
        <p class="meta">Your last ${rounds.length} timed round${rounds.length > 1 ? 's' : ''}.</p>` : ''}`
      : '<p class="meta">Play a round and your map fills in here.</p>';
  }
}
