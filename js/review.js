// Review a finished game against the bot: the engine scores every position,
// marks your inaccuracies, mistakes and blunders, and shows the better move.
import { TrainingBoard, Chess } from './board.js';
import { getEngine } from './engine.js';
import { getGame, updateGame } from './games.js';

const DEPTH = 11;
const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Chance of winning (0-100) for White at a centipawn score, the curve Lichess uses.
export const winPercent = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-2000, Math.min(2000, cp)))) - 1);

// How a move is graded from the drop in the mover's winning chances.
function grade(drop) {
  if (drop >= 30) return { key: 'blunder', label: 'Blunder', mark: '??' };
  if (drop >= 20) return { key: 'mistake', label: 'Mistake', mark: '?' };
  if (drop >= 10) return { key: 'inaccuracy', label: 'Inaccuracy', mark: '?!' };
  return null;
}

// An engine score in words. cp is from White's side unless `forYou` is set.
function evalWords(cp, forYou = false) {
  const good = forYou ? 'you' : 'White';
  const bad = forYou ? 'the bot' : 'Black';
  if (Math.abs(cp) >= 9000) return `a forced mate for ${cp > 0 ? good : bad}`;
  if (Math.abs(cp) < 25) return 'about equal';
  return `${(Math.abs(cp) / 100).toFixed(1)} pawns in ${cp > 0 ? good : bad}'s favour`.replace("you's", 'your');
}

export class GameReview {
  constructor(container, gameId) {
    this.container = container;
    this.game = getGame(gameId);
    this.alive = true;
    if (!this.game) {
      container.innerHTML = '<section class="module"><h1>Game not found</h1><p><a href="#/play">Back to Play the bot</a></p></section>';
      return;
    }
    // Every position of the game, with the move that led to it.
    const chess = new Chess();
    this.positions = [{ fen: chess.fen(), move: null }];
    for (const san of this.game.moves) {
      const m = chess.move(san);
      this.positions.push({ fen: chess.fen(), move: m });
    }
    this.ply = this.positions.length - 1;
    this.renderShell();
    this.board = new TrainingBoard(this.el.board, this.game.side, () => {});
    this.board.setLocked(true);
    this.keyHandler = e => {
      if (e.key === 'ArrowRight') this.go(this.ply + 1);
      else if (e.key === 'ArrowLeft') this.go(this.ply - 1);
    };
    window.addEventListener('keydown', this.keyHandler);
    this.go(this.ply);
    if (this.game.evals && this.game.evals.length === this.positions.length) this.analysed();
    else this.analyse();
  }

  destroy() {
    this.alive = false;
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    if (this.board) this.board.destroy();
  }

  renderShell() {
    const g = this.game;
    const when = new Date(g.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const result = { win: 'You won', draw: 'Draw', loss: 'You lost' }[g.outcome];
    this.container.innerHTML = `
      <section class="train">
        <div class="board-col">
          <div class="board-wrap" id="board"></div>
          <div class="graph" id="graph"></div>
        </div>
        <aside class="panel">
          <a class="crumb" href="#/play">← Play the bot</a>
          <p class="eyebrow">Game review · ${escapeHtml(when)}</p>
          <h1 class="line-title">${result} against the ${g.rating} bot</h1>
          <p class="meta">${escapeHtml(g.moduleTitle)} as ${g.side === 'white' ? 'White' : 'Black'}${g.lineName ? ' · ' + escapeHtml(g.lineName) : ''} · ${escapeHtml(g.reason || '')}</p>
          <div class="status" id="status" data-tone="neutral">Analysing the game…</div>
          <div id="summary"></div>
          <div class="teach" id="explain"></div>
          <div class="actions">
            <button type="button" id="btn-first" aria-label="Start">|‹</button>
            <button type="button" id="btn-prev" aria-label="Back">‹ Back</button>
            <button type="button" class="primary" id="btn-next" aria-label="Next">Next ›</button>
            <button type="button" id="btn-last" aria-label="End">›|</button>
          </div>
          <div class="moves-box">
            <p class="label">Moves: click any move</p>
            <ol class="moves study-moves" id="moves"></ol>
          </div>
        </aside>
      </section>`;
    const $ = id => this.container.querySelector('#' + id);
    this.el = { board: $('board'), graph: $('graph'), status: $('status'), summary: $('summary'), explain: $('explain'), moves: $('moves') };
    $('btn-first').onclick = () => this.go(0);
    $('btn-prev').onclick = () => this.go(this.ply - 1);
    $('btn-next').onclick = () => this.go(this.ply + 1);
    $('btn-last').onclick = () => this.go(this.positions.length - 1);
    this.el.moves.onclick = e => {
      const t = e.target.closest('[data-ply]');
      if (t) this.go(Number(t.dataset.ply));
    };
    this.renderMoves();
  }

  // Score every position with the engine, then keep the result with the game.
  async analyse() {
    let engine;
    try {
      engine = await getEngine();
    } catch (e) {
      this.setStatus(e.message, 'bad');
      return;
    }
    const evals = [];
    const best = [];
    for (let i = 0; i < this.positions.length; i++) {
      if (!this.alive) return;
      this.setStatus(`Analysing the game… ${Math.round((i / this.positions.length) * 100)}%`);
      const fen = this.positions[i].fen;
      const chess = new Chess(fen);
      if (chess.isCheckmate()) { evals.push(chess.turn() === 'w' ? -10000 : 10000); best.push(null); continue; }
      if (chess.isGameOver()) { evals.push(0); best.push(null); continue; }
      const r = await engine.evaluate(fen, DEPTH);
      evals.push(r.score);
      best.push(r.best);
    }
    this.game.evals = evals;
    this.game.best = best;
    updateGame(this.game.id, { evals, best });
    if (this.alive) this.analysed();
  }

  analysed() {
    const { evals, best } = this.game;
    // Grade each move from the mover's point of view.
    this.grades = [null];
    for (let i = 1; i < this.positions.length; i++) {
      const whiteMoved = i % 2 === 1;
      const before = winPercent(evals[i - 1]);
      const after = winPercent(evals[i]);
      const drop = whiteMoved ? before - after : after - before;
      const move = this.positions[i].move;
      const wasBest = best[i - 1] && best[i - 1] === move.from + move.to + (move.promotion || '');
      this.grades.push({ drop: Math.max(0, drop), grade: wasBest ? null : grade(drop) });
    }
    this.setStatus('Analysis done. Click a move or use the arrows.', 'neutral');
    this.renderSummary();
    this.renderGraph();
    this.renderMoves();
    this.go(this.ply);
  }

  isMine(ply) {
    return (ply % 2 === 1) === (this.game.side === 'white');
  }

  renderSummary() {
    const count = (mine, key) => this.grades.filter((g, i) => i > 0 && this.isMine(i) === mine && g.grade && g.grade.key === key).length;
    const accuracy = mine => {
      const drops = this.grades.filter((g, i) => i > 0 && this.isMine(i) === mine).map(g => g.drop);
      if (!drops.length) return 100;
      const acc = drops.map(d => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * d) - 3.1669)));
      return Math.round(acc.reduce((a, b) => a + b, 0) / acc.length);
    };
    const row = (who, mine) => `
      <tr><th>${who}</th><td>${accuracy(mine)}%</td>
        <td><span class="badge inaccuracy">${count(mine, 'inaccuracy')}</span></td>
        <td><span class="badge mistake">${count(mine, 'mistake')}</span></td>
        <td><span class="badge blunder">${count(mine, 'blunder')}</span></td></tr>`;
    const g = this.game;
    const bookLine = g.bookPly
      ? `Your preparation lasted until move ${Math.ceil(g.bookPly / 2)}${typeof g.bookEval === 'number' ? `, and the engine rated the position ${evalWords(g.bookEval, true)} at that point` : ''}.`
      : 'You left your preparation straight away.';
    const surprise = this.surpriseText();
    const moments = this.grades
      .map((gr, i) => ({ gr, i }))
      .filter(({ gr, i }) => i > 0 && this.isMine(i) && gr.grade && gr.grade.key !== 'inaccuracy');
    this.el.summary.innerHTML = `
      <table class="review-table">
        <thead><tr><th></th><th>Accuracy</th><th>Inaccuracies</th><th>Mistakes</th><th>Blunders</th></tr></thead>
        <tbody>${row('You', true)}${row('Bot', false)}</tbody>
      </table>
      <p class="meta">${bookLine}</p>
      ${surprise}
      ${moments.length ? `<p class="label">Your turning points</p><div class="moments">${moments.map(({ gr, i }) =>
        `<button type="button" class="moment ${gr.grade.key}" data-ply="${i}">${this.moveLabel(i)}${gr.grade.mark}</button>`).join('')}</div>` : ''}`;
    this.el.summary.querySelectorAll('[data-ply]').forEach(b => { b.onclick = () => this.go(Number(b.dataset.ply)); });
  }

  // The surprise bot left the book: what it played, and how you answered.
  surpriseText() {
    const s = this.game.surprise;
    if (!s || !this.positions[s.ply + 1]) return '';
    const at = s.ply + 1;
    const kind = { sound: 'a reasonable move', mistake: 'a mistake', blunder: 'a blunder' }[s.kind];
    let text = `The bot left your lines with ${this.moveLabel(at)}: ${kind}` +
      (s.kind === 'sound' ? '.' : `, giving away about ${(s.loss / 100).toFixed(1)} pawns.`);
    const reply = this.positions[at + 1];
    const bestUci = this.game.best[at];
    if (reply && bestUci) {
      const bestSan = new Chess(this.positions[at].fen).move({ from: bestUci.slice(0, 2), to: bestUci.slice(2, 4), promotion: bestUci[4] }).san;
      const g = this.grades[at + 1];
      if (bestSan === reply.move.san) text += ` You found the best answer, ${bestSan}.`;
      else if (!g.grade) text += ` Your answer ${reply.move.san} was fine; the engine's choice was ${bestSan}.`;
      else text += ` Your answer ${reply.move.san} was ${g.grade.label.toLowerCase() === 'inaccuracy' ? 'an inaccuracy' : 'a ' + g.grade.label.toLowerCase()}; ${s.kind === 'sound' ? 'better was' : 'the way to punish it was'} ${bestSan}.`;
    }
    return `<p class="note-title">The surprise</p><p>${escapeHtml(text)}</p>
      <div class="moments"><button type="button" class="moment" data-ply="${at}">See the surprise</button>${reply ? `<button type="button" class="moment" data-ply="${at + 1}">See your answer</button>` : ''}</div>`;
  }

  moveLabel(ply) {
    const n = Math.ceil(ply / 2);
    return `${n}${ply % 2 === 1 ? '.' : '…'} ${this.positions[ply].move.san}`;
  }

  // The evaluation over the game, as a filled area: White's chances from the top.
  renderGraph() {
    const evals = this.game.evals;
    const n = evals.length - 1 || 1;
    const W = 600, H = 90;
    const x = i => (i / n) * W;
    const y = cp => H - (winPercent(cp) / 100) * H;
    const pts = evals.map((cp, i) => `${x(i).toFixed(1)},${y(cp).toFixed(1)}`).join(' ');
    const book = this.game.bookPly ? `<line class="book-line" x1="${x(this.game.bookPly)}" x2="${x(this.game.bookPly)}" y1="0" y2="${H}"/>` : '';
    const dots = this.grades.map((g, i) => (i > 0 && this.isMine(i) && g.grade && g.grade.key !== 'inaccuracy'
      ? `<circle class="dot ${g.grade.key}" cx="${x(i)}" cy="${y(evals[i])}" r="5"/>` : '')).join('');
    this.el.graph.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Evaluation over the game">
        <rect class="black-area" x="0" y="0" width="${W}" height="${H}"/>
        <polygon class="white-area" points="0,${H} ${pts} ${W},${H}"/>
        <line class="mid" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/>
        ${book}${dots}
        <line class="cursor" id="cursor" x1="0" x2="0" y1="0" y2="${H}"/>
      </svg>
      <p class="meta">White's chances over the game. The dashed line is where your preparation ended.</p>`;
    const svg = this.el.graph.querySelector('svg');
    svg.onclick = e => {
      const r = svg.getBoundingClientRect();
      this.go(Math.round(((e.clientX - r.left) / r.width) * n));
    };
    this.moveCursor();
  }

  moveCursor() {
    const c = this.el.graph.querySelector('#cursor');
    if (!c) return;
    const n = this.positions.length - 1 || 1;
    const X = (this.ply / n) * 600;
    c.setAttribute('x1', X);
    c.setAttribute('x2', X);
  }

  go(ply) {
    this.ply = Math.max(0, Math.min(this.positions.length - 1, ply));
    const pos = this.positions[this.ply];
    this.board.showPosition(pos.fen, pos.move ? [pos.move.from, pos.move.to] : null);
    this.renderMoves();
    this.moveCursor();
    this.explain();
  }

  // What happened on the move that led to this position.
  explain() {
    const i = this.ply;
    const shapes = [];
    if (i === 0) {
      this.el.explain.innerHTML = '<p class="note-title">Start of the game</p><p>Step through with Next, or jump to a turning point.</p>';
      this.board.showShapes([]);
      return;
    }
    const move = this.positions[i].move;
    const who = this.isMine(i) ? 'You' : 'The bot';
    let title = `${this.moveLabel(i)}`;
    let text = `${who} played ${move.san}.`;
    if (i <= (this.game.bookPly || 0)) text += ' Still in your prepared line.';
    if (this.grades) {
      const g = this.grades[i];
      const evalNow = this.game.evals[i];
      const bestUci = this.game.best[i - 1];
      if (g.grade) {
        title += ` ${g.grade.mark} ${g.grade.label}`;
        shapes.push({ orig: move.from, dest: move.to, brush: 'red' });
        if (bestUci) {
          const bestSan = new Chess(this.positions[i - 1].fen).move({ from: bestUci.slice(0, 2), to: bestUci.slice(2, 4), promotion: bestUci[4] }).san;
          text += ` Better was ${bestSan} (shown in green).`;
          shapes.push({ orig: bestUci.slice(0, 2), dest: bestUci.slice(2, 4), brush: 'green' });
        }
      }
      text += ` After it, the engine says: ${evalWords(evalNow)}.`;
    }
    this.el.explain.innerHTML = `<p class="note-title">${escapeHtml(title)}</p><p>${escapeHtml(text)}</p>`;
    this.board.showShapes(shapes);
  }

  setStatus(text, tone = 'neutral') {
    this.el.status.textContent = text;
    this.el.status.dataset.tone = tone;
  }

  renderMoves() {
    const cell = j => {
      if (j >= this.positions.length) return '<span></span>';
      const g = this.grades && this.grades[j] && this.grades[j].grade;
      const cls = [j === this.ply ? 'here' : '', g ? g.key : '', j <= (this.game.bookPly || 0) ? 'book' : ''].filter(Boolean).join(' ');
      return `<span class="${cls}" data-ply="${j}" role="button" tabindex="0">${this.positions[j].move.san}${g ? g.mark : ''}</span>`;
    };
    let html = '';
    for (let j = 1, n = 1; j < this.positions.length; j += 2, n++) {
      html += `<li><span class="num">${n}.</span>${cell(j)}${cell(j + 1)}</li>`;
    }
    this.el.moves.innerHTML = html;
  }
}
