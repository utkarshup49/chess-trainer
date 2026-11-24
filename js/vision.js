// Board vision: find the named square as fast as you can.
//
// Unlike a plain coordinates trainer, this one remembers how you do on every
// square (separately for White's and Black's view of the board): squares you
// miss or are slow on come up more often, and a heat map shows where you are
// quick and where you hesitate.

const KEY = 'chess-gym-vision-v1';
const ROUND_SECONDS = 30;
const FILES = 'abcdefgh';
const SQUARES = [...FILES].flatMap(f => [1, 2, 3, 4, 5, 6, 7, 8].map(r => f + r));
const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
}
function save(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* not kept */ }
}

// Stats for one view: { square: { tries, misses, ms } }, ms = recent average.
function statsFor(view) {
  return load()[view] || {};
}

function record(view, square, ms, missed) {
  const data = load();
  const s = (data[view] = data[view] || {});
  const sq = s[square] || { tries: 0, misses: 0, ms: null };
  sq.tries += 1;
  if (missed) sq.misses += 1;
  // A moving average, so the map follows how you are doing now.
  if (!missed) sq.ms = sq.ms === null ? ms : Math.round(sq.ms * 0.7 + ms * 0.3);
  s[square] = sq;
  data.best = data.best || {};
  save(data);
}

// Weaker squares are picked more often; unseen squares count as weak.
function pickSquare(view, previous) {
  const s = statsFor(view);
  const weights = SQUARES.map(sq => {
    const st = s[sq];
    if (sq === previous) return 0;
    if (!st || !st.tries) return 3;
    const missRate = st.misses / st.tries;
    const slow = st.ms ? Math.min(3, st.ms / 1500) : 1.5;
    return 0.5 + slow + missRate * 6;
  });
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < SQUARES.length; i++) {
    r -= weights[i];
    if (r <= 0) return SQUARES[i];
  }
  return SQUARES[0];
}

export class VisionTrainer {
  constructor(container) {
    this.container = container;
    this.view = 'white';
    this.running = false;
    this.render();
  }

  destroy() {
    clearInterval(this.ticker);
  }

  render() {
    this.container.innerHTML = `
      <section class="train">
        <div class="board-col">
          <div class="vision-board" id="vboard" aria-label="Chess board without coordinates"></div>
        </div>
        <aside class="panel">
          <a class="crumb" href="#/">← Home</a>
          <p class="eyebrow">Board vision</p>
          <h1 class="line-title">Find the square</h1>
          <p class="meta">A square name appears; tap that square. Squares you miss or are slow on come up more often.</p>
          <div class="pick-row" id="views">
            <button type="button" class="pick rating on" data-view="white">White's view</button>
            <button type="button" class="pick rating" data-view="black">Black's view</button>
          </div>
          <div class="vision-target" id="target">–</div>
          <div class="status" id="status" data-tone="neutral">Press Start for a ${ROUND_SECONDS}-second round, or Practice to go at your own pace.</div>
          <div class="actions">
            <button type="button" class="primary" id="btn-start">Start (${ROUND_SECONDS}s)</button>
            <button type="button" id="btn-practice">Practice</button>
          </div>
          <p class="label">Your map: green is quick, red is slow or missed</p>
          <div class="heat" id="heat"></div>
          <p class="meta" id="weak"></p>
        </aside>
      </section>`;
    const $ = id => this.container.querySelector('#' + id);
    this.el = { board: $('vboard'), target: $('target'), status: $('status'), heat: $('heat'), weak: $('weak') };
    $('btn-start').onclick = () => this.start(true);
    $('btn-practice').onclick = () => this.start(false);
    this.container.querySelectorAll('[data-view]').forEach(b => {
      b.onclick = () => {
        if (this.running) return;
        this.view = b.dataset.view;
        this.container.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b));
        this.drawBoard();
        this.drawHeat();
      };
    });
    this.drawBoard();
    this.drawHeat();
  }

  // Squares in screen order for the current view.
  ordered() {
    const ranks = this.view === 'white' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const files = this.view === 'white' ? [...FILES] : [...FILES].reverse();
    return ranks.flatMap(r => files.map(f => f + r));
  }

  drawBoard() {
    this.el.board.innerHTML = this.ordered().map(sq => {
      const dark = (FILES.indexOf(sq[0]) + Number(sq[1])) % 2 === 1 ? 'dark' : 'light'; // a1 is dark
      return `<button type="button" class="vsq ${dark}" data-sq="${sq}" aria-label="square"></button>`;
    }).join('');
    this.el.board.onclick = e => {
      const b = e.target.closest('[data-sq]');
      if (b) this.answer(b.dataset.sq, b);
    };
  }

  drawHeat() {
    const s = statsFor(this.view);
    this.el.heat.innerHTML = this.ordered().map(sq => {
      const st = s[sq];
      let bg = 'var(--line)';
      if (st && st.tries) {
        const missRate = st.misses / st.tries;
        const slow = st.ms ? Math.min(1, Math.max(0, (st.ms - 700) / 2300)) : 1;
        const bad = Math.min(1, slow * 0.7 + missRate * 1.5);
        bg = `hsl(${Math.round(130 - 130 * bad)} 55% 45%)`;
      }
      const tip = st && st.tries ? `${sq}: ${st.ms ? (st.ms / 1000).toFixed(1) + 's' : 'no time yet'}, ${st.misses} missed of ${st.tries}` : `${sq}: not tried yet`;
      return `<span class="hsq" style="background:${bg}" title="${tip}">${sq}</span>`;
    }).join('');
    const tried = Object.entries(s).filter(([, st]) => st.tries);
    const weak = tried
      .map(([sq, st]) => ({ sq, score: (st.ms || 3000) + 2000 * (st.misses / st.tries) }))
      .sort((a, b) => b.score - a.score).slice(0, 6).map(x => x.sq);
    this.el.weak.textContent = tried.length
      ? `Your slowest squares from ${this.view === 'white' ? "White's" : "Black's"} side: ${weak.join(', ')}.`
      : 'Play a round to see your map.';
  }

  start(timed) {
    clearInterval(this.ticker);
    this.running = true;
    this.timed = timed;
    this.score = 0;
    this.missedCount = 0;
    this.previous = null;
    if (timed) {
      this.endsAt = Date.now() + ROUND_SECONDS * 1000;
      this.ticker = setInterval(() => this.tick(), 200);
    }
    this.next();
  }

  tick() {
    const left = Math.max(0, Math.ceil((this.endsAt - Date.now()) / 1000));
    this.setStatus(`${left}s left · ${this.score} found${this.missedCount ? ` · ${this.missedCount} missed` : ''}`);
    if (left <= 0) this.stop();
  }

  next() {
    this.current = pickSquare(this.view, this.previous);
    this.previous = this.current;
    this.shownAt = performance.now();
    this.el.target.textContent = this.current;
    if (!this.timed) this.setStatus(`${this.score} found${this.missedCount ? ` · ${this.missedCount} missed` : ''}. Press Start for a timed round.`);
  }

  answer(square, button) {
    if (!this.running) return;
    const ms = Math.round(performance.now() - this.shownAt);
    const right = square === this.current;
    record(this.view, this.current, ms, !right);
    button.classList.add(right ? 'hit' : 'miss');
    setTimeout(() => button.classList.remove('hit', 'miss'), 350);
    if (right) this.score += 1;
    else {
      this.missedCount += 1;
      const correct = this.el.board.querySelector(`[data-sq="${this.current}"]`);
      correct.classList.add('show');
      setTimeout(() => correct.classList.remove('show'), 700);
    }
    if (!this.timed) this.drawHeat();
    this.next();
  }

  stop() {
    clearInterval(this.ticker);
    this.running = false;
    this.el.target.textContent = '–';
    const data = load();
    const best = (data.best = data.best || {});
    const record = best[this.view] || 0;
    if (this.score > record) best[this.view] = this.score;
    save(data);
    this.setStatus(`Time! ${this.score} found, ${this.missedCount} missed. ${this.score > record ? 'New best!' : `Best: ${record}.`}`, 'good');
    this.drawHeat();
  }

  setStatus(text, tone = 'neutral') {
    this.el.status.textContent = text;
    this.el.status.dataset.tone = tone;
  }
}
