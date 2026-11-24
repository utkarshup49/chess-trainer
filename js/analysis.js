// Analysis board: play any moves for both sides and see what the engine
// thinks, with its three best lines and an evaluation bar. Opened empty, or
// with a game or puzzle handed over from another page.
import { TrainingBoard, Chess } from './board.js';
import { getEngine } from './engine.js';
import { takeHandoff } from './handoff.js';
import { winPercent } from './review.js';

const DEPTH = 14;
const LINES = 3;
const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function scoreText(cp, mate) {
  if (mate !== null && mate !== undefined) return (mate > 0 ? '#' : '#-') + Math.abs(mate);
  return (cp > 0 ? '+' : '') + (cp / 100).toFixed(2);
}

export class AnalysisBoard {
  constructor(container) {
    this.container = container;
    this.alive = true;
    const given = takeHandoff();
    this.startFen = new Chess().fen();
    this.moves = (given && given.moves) || [];
    this.orientation = (given && given.orientation) || 'white';
    this.ply = given && Number.isInteger(given.ply) ? given.ply : this.moves.length;
    this.render();
    this.board = new TrainingBoard(this.el.board, this.orientation, m => this.onMove(m));
    this.keyHandler = e => {
      if (e.target.closest && e.target.closest('textarea, input')) return;
      if (e.key === 'ArrowLeft') this.go(this.ply - 1);
      else if (e.key === 'ArrowRight') this.go(this.ply + 1);
    };
    window.addEventListener('keydown', this.keyHandler);
    this.go(this.ply);
    getEngine().then(e => { this.engine = e; this.think(); }).catch(err => this.setEngineText(err.message));
  }

  destroy() {
    this.alive = false;
    window.removeEventListener('keydown', this.keyHandler);
    if (this.engine) this.engine.stop();
    if (this.board) this.board.destroy();
  }

  render() {
    this.container.innerHTML = `
      <section class="train">
        <div class="board-col">
          <div class="evalbar" aria-label="Evaluation"><span id="evalfill" style="width:50%"></span><b id="evaltext">0.00</b></div>
          <div class="board-wrap" id="board"></div>
        </div>
        <aside class="panel">
          <a class="crumb" href="#/">← Home</a>
          <p class="eyebrow">Analysis board</p>
          <h1 class="line-title">Try any moves</h1>
          <p class="meta">Move pieces for either side. The engine's best three lines update as you go; click a line to play its first move.</p>
          <ol class="engine-lines" id="lines"><li class="meta">Loading the engine…</li></ol>
          <div class="actions">
            <button type="button" id="btn-start" aria-label="Start">|‹</button>
            <button type="button" id="btn-prev">‹ Back</button>
            <button type="button" id="btn-next">Next ›</button>
            <button type="button" id="btn-end" aria-label="End">›|</button>
            <button type="button" id="btn-flip">Flip</button>
          </div>
          <div class="moves-box">
            <p class="label">Moves: click to jump</p>
            <ol class="moves study-moves" id="moves"></ol>
          </div>
          <details class="line-picker">
            <summary>Load a PGN or FEN</summary>
            <textarea id="load-text" rows="4" placeholder="Paste a PGN (1. e4 e5 2. Nf3 …) or a FEN"></textarea>
            <div class="actions"><button type="button" id="btn-load">Load</button><button type="button" id="btn-reset">Clear board</button></div>
            <p class="meta" id="load-msg"></p>
          </details>
        </aside>
      </section>`;
    const $ = id => this.container.querySelector('#' + id);
    this.el = { board: $('board'), lines: $('lines'), moves: $('moves'), fill: $('evalfill'), evaltext: $('evaltext'), loadText: $('load-text'), loadMsg: $('load-msg') };
    $('btn-start').onclick = () => this.go(0);
    $('btn-prev').onclick = () => this.go(this.ply - 1);
    $('btn-next').onclick = () => this.go(this.ply + 1);
    $('btn-end').onclick = () => this.go(this.moves.length);
    $('btn-flip').onclick = () => this.flip();
    $('btn-load').onclick = () => this.load(this.el.loadText.value);
    $('btn-reset').onclick = () => { this.startFen = new Chess().fen(); this.moves = []; this.go(0); };
    this.el.moves.onclick = e => {
      const t = e.target.closest('[data-ply]');
      if (t) this.go(Number(t.dataset.ply));
    };
    this.el.lines.onclick = e => {
      const t = e.target.closest('[data-move]');
      if (t) this.playUci(t.dataset.move);
    };
  }

  // The position after the first `ply` moves.
  gameAt(ply) {
    const g = new Chess(this.startFen);
    for (const m of this.moves.slice(0, ply)) g.move(m);
    return g;
  }

  go(ply) {
    this.ply = Math.max(0, Math.min(this.moves.length, ply));
    const g = this.gameAt(this.ply);
    const last = g.history({ verbose: true }).pop();
    this.board.showPosition(g.fen(), last ? [last.from, last.to] : null);
    this.board.userColor = this.board.sideToMove(); // either side may move here
    this.board.sync();
    this.renderMoves();
    this.think();
  }

  onMove(move) {
    // A new move replaces whatever came after this point.
    this.moves = this.moves.slice(0, this.ply).concat(move.san);
    this.go(this.ply + 1);
  }

  playUci(uci) {
    const g = this.gameAt(this.ply);
    const m = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    if (m) this.onMove({ san: m.san });
  }

  flip() {
    this.orientation = this.orientation === 'white' ? 'black' : 'white';
    this.board.cg.set({ orientation: this.orientation });
  }

  load(text) {
    text = text.trim();
    if (!text) return;
    try {
      const g = new Chess();
      if (/^[rnbqkpRNBQKP1-8/]+ [wb] /.test(text)) {
        g.load(text);
        this.startFen = g.fen();
        this.moves = [];
      } else {
        g.loadPgn(text);
        const header = g.header && g.header();
        this.startFen = header && header.FEN ? header.FEN : new Chess().fen();
        this.moves = g.history();
      }
      this.el.loadMsg.textContent = 'Loaded.';
      this.go(this.moves.length);
    } catch (e) {
      this.el.loadMsg.textContent = 'That doesn’t look like a valid PGN or FEN.';
    }
  }

  // Ask the engine about the current position; only the latest answer is shown.
  async think() {
    if (!this.engine || !this.alive) return;
    const fen = this.gameAt(this.ply).fen();
    this.wanted = fen;
    if (this.busy) { this.engine.stop(); return; } // the running search ends early, then we re-run
    this.busy = true;
    const g = new Chess(fen);
    if (g.isGameOver()) {
      this.busy = false;
      this.setEngineText(g.isCheckmate() ? 'Checkmate.' : 'Draw.');
      this.setEval(g.isCheckmate() ? (g.turn() === 'w' ? -10000 : 10000) : 0, null);
      return;
    }
    this.el.lines.classList.add('thinking');
    const lines = await this.engine.analyse(fen, { depth: DEPTH, multipv: LINES });
    this.busy = false;
    if (!this.alive) return;
    if (this.wanted !== fen) return this.think();
    this.el.lines.classList.remove('thinking');
    this.showLines(fen, lines);
  }

  showLines(fen, lines) {
    const whiteToMove = fen.split(' ')[1] === 'w';
    const sign = whiteToMove ? 1 : -1;
    this.el.lines.innerHTML = lines.map(l => {
      const g = new Chess(fen);
      const san = [];
      for (const u of (l.pv || [l.move]).slice(0, 8)) {
        const m = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        if (!m) break;
        san.push(m.san);
      }
      const mate = l.mate === null ? null : sign * l.mate;
      return `<li><button type="button" class="engine-line" data-move="${l.move}"><b>${scoreText(sign * l.score, mate)}</b> ${escapeHtml(san.join(' '))}</button></li>`;
    }).join('');
    if (lines[0]) {
      const best = lines[0];
      this.setEval(sign * best.score, best.mate === null ? null : sign * best.mate);
      this.board.showArrow(best.move.slice(0, 2), best.move.slice(2, 4), 'paleBlue');
    }
  }

  setEval(cp, mate) {
    this.el.fill.style.width = winPercent(cp) + '%';
    this.el.evaltext.textContent = scoreText(cp, mate);
  }

  setEngineText(text) {
    this.el.lines.innerHTML = `<li class="meta">${escapeHtml(text)}</li>`;
  }

  renderMoves() {
    const cell = j => (j <= this.moves.length && j > 0
      ? `<span class="${j === this.ply ? 'here' : ''}" data-ply="${j}" role="button" tabindex="0">${this.moves[j - 1]}</span>` : '<span></span>');
    let html = '';
    const blackFirst = this.startFen.split(' ')[1] === 'b';
    const offset = blackFirst ? 1 : 0;
    for (let j = 1 - offset, n = 1; j <= this.moves.length; j += 2, n++) {
      html += `<li><span class="num">${n}.</span>${j >= 1 ? cell(j) : '<span>…</span>'}${cell(j + 1)}</li>`;
    }
    this.el.moves.innerHTML = html || '<li><span class="empty">No moves yet.</span></li>';
  }
}
