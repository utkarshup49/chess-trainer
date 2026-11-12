// The trainer for tablebase-judged drills (rook endings, queen against pawn,
// fortresses, pawn endings). Same rules as the King + Pawn drills: nothing is
// said while you play, the game runs to a real conclusion, and the post-mortem
// names the move where the result slipped.
import { TrainingBoard, Chess } from './board.js';
import { deal } from './tbgen.js';
import { scoreFen, scoreMoves, OracleOffline } from './oracle.js';
import { recordEndgame, getModuleProgress } from './progress.js';

const REPLY_DELAY = 450;
const HOLD_MOVES = 12;      // defensive moves that count as a held draw
const DEAD_MOVES = 6;       // how long to play on once the result is gone
const WIN_LIMIT = 40;       // a win that takes longer than this is not progress
const TRAP_SAMPLE = 3;      // candidate replies the opponent weighs up in a draw

const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Non-king material for each colour, read straight off a FEN.
function material(fen) {
  const out = { w: { all: 0, pawns: 0, queens: 0 }, b: { all: 0, pawns: 0, queens: 0 } };
  for (const ch of fen.split(' ')[0]) {
    if (!/[a-zA-Z]/.test(ch) || ch.toLowerCase() === 'k') continue;
    const side = ch === ch.toUpperCase() ? out.w : out.b;
    side.all += 1;
    if (ch.toLowerCase() === 'p') side.pawns += 1;
    if (ch.toLowerCase() === 'q') side.queens += 1;
  }
  return out;
}

export class TablebaseTrainer {
  constructor(container, module, { drillId }) {
    this.container = container;
    this.module = module;
    this.drill = module.drills.find(d => d.id === drillId);
    this.timer = null;
    this.board = null;
    this.busy = false;

    this.renderShell();
    this.keyHandler = e => { if (e.key === 'ArrowLeft') this.stepBack(); };
    window.addEventListener('keydown', this.keyHandler);
    // The tablebase sometimes asks for a pause; say so rather than look frozen.
    this.waitHandler = e => {
      if (e.detail.seconds > 0) {
        this.setStatus(`The endgame database asked for a short pause. Carrying on in about ${e.detail.seconds} seconds\u2026`, 'neutral');
      }
    };
    window.addEventListener('oracle-wait', this.waitHandler);
    this.newPosition();
  }

  renderShell() {
    this.container.innerHTML = `
      <section class="train">
        <div class="board-col"><div class="board-wrap" id="board"></div></div>
        <aside class="panel">
          <a class="crumb" href="#/m/${this.module.id}">← ${escapeHtml(this.module.title)}</a>
          <p class="eyebrow" id="eyebrow"></p>
          <h1 class="line-title">${escapeHtml(this.drill.name)}</h1>
          <p class="goal" id="goal"></p>
          <div class="status" id="status" data-tone="neutral"></div>
          <div class="note" id="note" hidden></div>
          <div class="actions">
            <button type="button" id="btn-back" title="Shortcut: left arrow">Step back</button>
            <button type="button" id="btn-hint">Method</button>
            <button type="button" id="btn-show">Show move</button>
            <button type="button" id="btn-new">New position</button>
          </div>
          <div class="finish" id="finish" hidden></div>
          <div class="moves-box">
            <p class="label">Moves</p>
            <ol class="moves" id="moves"></ol>
          </div>
        </aside>
      </section>`;
    const q = s => this.container.querySelector(s);
    this.el = { board: q('#board'), eyebrow: q('#eyebrow'), goal: q('#goal'), status: q('#status'),
                note: q('#note'), moves: q('#moves'), finish: q('#finish') };
    q('#btn-back').onclick = () => this.stepBack();
    q('#btn-hint').onclick = () => this.showMethod();
    q('#btn-show').onclick = () => this.showMove();
    q('#btn-new').onclick = () => this.newPosition();
  }

  destroy() {
    clearTimeout(this.timer);
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('oracle-wait', this.waitHandler);
    if (this.board) this.board.destroy();
  }

  async newPosition() {
    clearTimeout(this.timer);
    if (this.dealing) return;
    this.dealing = true;
    this.setStatus('Dealing a position…', 'neutral');
    this.el.finish.hidden = true;
    this.hideNote();

    // The mixed drill picks one of the module's own drills without saying which.
    const pool = this.module.drills.filter(d => d.recipe);
    this.source = this.drill.recipe ? this.drill : pool[Math.floor(Math.random() * pool.length)];

    let pos = null;
    try {
      pos = await deal(this.source.recipe, Chess);
      if (!pos) pos = await deal(this.source.recipe, Chess, { budget: 80 });
    } catch (e) {
      this.dealing = false;
      if (e instanceof OracleOffline) return this.offline();
      throw e;
    }
    this.dealing = false;
    if (!pos) return this.setStatus('No position came up this time. Press New position.', 'bad');

    this.userColor = pos.userColor === 'w' ? 'white' : 'black';
    this.sign = pos.userColor === 'w' ? 1 : -1;       // turns White's view into mine
    this.target = pos.goal === 'win' ? 1 : 0;
    this.beginRound(pos.fen);
  }

  offline() {
    this.setStatus('Cannot reach the endgame database.', 'bad');
    this.showNote('Offline', ['These drills are judged by Lichess’s endgame tablebase, so they need a connection.']);
  }

  beginRound(fen) {
    clearTimeout(this.timer);
    if (this.board) this.board.destroy();
    this.live = this.target;
    this.turningPoint = null;
    this.played = 0;
    this.helped = false;
    this.finished = false;
    this.busy = false;
    this.options = null;
    this.startStm = fen.split(' ')[1] === 'w' ? 0 : 1;
    this.startMaterial = material(fen);

    this.board = new TrainingBoard(this.el.board, this.userColor, m => this.onUserMove(m), fen);
    const stats = getModuleProgress(this.module.id).endgames[this.drill.id];
    this.el.eyebrow.textContent =
      `You play ${this.userColor === 'white' ? 'White' : 'Black'} · streak ${stats ? stats.streak : 0}`;
    this.el.goal.textContent = this.drill.recipe
      ? this.drill.goal
      : `${this.drill.goal} Here you need ${this.target === 1 ? 'to win' : 'a draw'}.`;
    this.el.finish.hidden = true;
    this.hideNote();
    this.afterChange();
  }

  fen() { return this.board.game.fen(); }
  myTurn() { return (this.board.game.turn() === 'w') === (this.userColor === 'white'); }

  async afterChange() {
    this.renderMoves();
    if (this.finished) return;
    const game = this.board.game;
    const fen = this.fen();
    const winning = this.target === 1;

    let wdl;
    try {
      wdl = (await scoreFen(fen)).wdl * this.sign;
    } catch (e) {
      if (e instanceof OracleOffline) return this.offline();
      throw e;
    }

    // Games that are simply over.
    if (game.isCheckmate()) {
      return this.myTurn() ? this.finish(false, 'Checkmate.') : this.finish(true, 'Checkmate.');
    }
    if (game.isStalemate() || game.isInsufficientMaterial()) {
      const what = game.isStalemate() ? 'Stalemate' : 'Nothing left to win with';
      return winning ? this.finish(false, `${what}. Draw.`) : this.finish(true, `${what} — the draw is safe.`);
    }

    const now = material(fen);
    const me = this.userColor === 'white' ? 'w' : 'b';
    const them = me === 'w' ? 'b' : 'w';
    const start = this.startMaterial;

    if (winning) {
      // Converted: still winning, and something real has changed in my favour.
      const converted = now[me].queens > start[me].queens || now[them].all < start[them].all;
      if (wdl === 1 && converted) return this.finish(true, 'Converted — the rest is technique.');
      if (wdl !== 1 && now[me].all < start[me].all && this.turningPoint) {
        return this.finish(false, 'The winning material is gone.');
      }
    } else {
      if (wdl === 0 && start[them].pawns > 0 && now[them].pawns === 0 && now[them].queens === start[them].queens) {
        return this.finish(true, 'Their last pawn is gone — dead draw.');
      }
      if (wdl === 0 && this.played >= (this.source.hold || HOLD_MOVES)) {
        return this.finish(true, 'You have held it long enough — the fortress stands.');
      }
      if (wdl < 0 && now[them].queens > start[them].queens) return this.finish(false, 'They queened.');
    }

    if (this.turningPoint && this.played - this.turningPoint.playedAt >= DEAD_MOVES) {
      return this.finish(false, winning ? 'The win is gone for good now.' : 'They are through.');
    }
    if (this.played >= WIN_LIMIT) {
      return this.finish(false, `Still winning after ${WIN_LIMIT} moves, but no closer. The method below is the way through.`);
    }

    if (this.myTurn()) {
      try {
        this.options = await scoreMoves(game, Chess);
      } catch (e) {
        if (e instanceof OracleOffline) return this.offline();
        throw e;
      }
      this.setStatus('Your move', 'neutral');
      this.board.setLocked(false);
    } else {
      this.setStatus('Thinking…', 'neutral');
      this.board.setLocked(true);
      this.timer = setTimeout(() => this.opponentMove(), REPLY_DELAY);
    }
  }

  // The opponent never spoils its own result. When it is lost it drags things
  // out; when it is winning it gets on with it; and when the position is level
  // it looks for the move that leaves me the most ways to go wrong.
  async pickReply() {
    const game = this.board.game;
    const scored = await scoreMoves(game, Chess);
    if (!scored.length) return null;
    const theirs = m => -m.wdl * this.sign;                    // from the opponent's side
    const best = Math.max(...scored.map(theirs));
    let pool = scored.filter(m => theirs(m) === best);

    if (best < 0) {
      const longest = Math.max(...pool.map(m => m.depth));
      pool = pool.filter(m => m.depth === longest);
    } else if (best > 0) {
      const quickest = Math.min(...pool.map(m => m.depth));
      pool = pool.filter(m => m.depth === quickest);
    } else if (pool.length > 1) {
      const sample = pool.slice().sort(() => Math.random() - 0.5).slice(0, TRAP_SAMPLE);
      const traps = [];
      for (const entry of sample) {
        const replies = await scoreMoves(new Chess(entry.fen), Chess);
        const bad = replies.filter(r => r.wdl * this.sign < this.live).length;
        traps.push(replies.length ? bad / replies.length : 0);
      }
      const most = Math.max(...traps);
      pool = sample.filter((_, i) => traps[i] === most);
    }
    return pool[Math.floor(Math.random() * pool.length)].move;
  }

  async opponentMove() {
    let reply;
    try {
      reply = await this.pickReply();
    } catch (e) {
      if (e instanceof OracleOffline) return this.offline();
      throw e;
    }
    if (!reply || this.finished) return this.afterChange();
    this.board.setLocked(false);
    this.board.play({ from: reply.from, to: reply.to, promotion: reply.promotion });
    this.afterChange();
  }

  // Of the moves that keep the result, the one that gets on with it.
  bestOf(options) {
    if (!options.length) return null;
    return this.live === 1 ? options.reduce((a, b) => (b.depth < a.depth ? b : a)) : options[0];
  }

  async onUserMove(move) {
    if (this.finished || this.busy || !this.options) return;
    this.busy = true;
    this.board.clearArrows();
    const played = this.options.find(o =>
      o.move.from === move.from && o.move.to === move.to && (o.move.promotion || undefined) === (move.promotion || undefined));
    const mine = played ? played.wdl * this.sign : this.live;

    // The result just slipped. Remember where, and say nothing.
    if (mine < this.live && !this.turningPoint) {
      const kept = this.options.filter(o => o.wdl * this.sign === this.live);
      const best = this.bestOf(kept);
      this.turningPoint = {
        number: Math.floor((this.startStm + this.board.sanHistory().length) / 2) + 1,
        playedAt: this.played,
        san: move.san,
        fenBefore: this.fen(),
        bestSan: best ? best.move.san : null,
        others: kept.length - 1,
      };
    }
    if (mine < this.live) this.live = mine;

    this.played += 1;
    this.options = null;
    this.hideNote();
    this.board.play(move);
    await this.afterChange();
    this.busy = false;
  }

  showMethod() {
    this.helped = true;
    this.showNote('The method', this.source.method);
  }

  showMove() {
    if (this.finished || !this.myTurn() || !this.options) return;
    this.helped = true;
    const best = this.bestOf(this.options.filter(o => o.wdl * this.sign === this.live));
    if (!best) return;
    this.board.showArrow(best.move.from, best.move.to);
    this.showNote('One move that works', [`${best.move.san} keeps ${this.live === 1 ? 'the win' : this.live === 0 ? 'the draw' : 'things going'}.`]);
  }

  stepBack() {
    if (this.finished || this.busy || this.board.sanHistory().length === 0) return;
    clearTimeout(this.timer);
    this.board.clearArrows();
    while (this.board.sanHistory().length > 0) {
      this.board.undo();
      if (this.myTurn()) break;
    }
    if (this.turningPoint && this.fen() === this.turningPoint.fenBefore) {
      this.live = this.target;
      this.turningPoint = null;
    }
    this.played = Math.max(0, this.played - 1);
    this.hideNote();
    this.afterChange();
  }

  finish(won, summary) {
    this.finished = true;
    this.board.setLocked(true);
    const clean = won && !this.turningPoint && !this.helped;
    const stats = recordEndgame(this.module.id, this.drill.id, clean);
    this.el.eyebrow.textContent =
      `You play ${this.userColor === 'white' ? 'White' : 'Black'} · streak ${stats.streak} · best ${stats.best}`;
    this.setStatus(summary, won ? 'good' : 'bad');
    this.hideNote();

    const reveal = this.drill.recipe ? '' : `<p class="meta">This one was: ${escapeHtml(this.source.name)}.</p>`;
    const steps = `<ol class="method">${this.source.method.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`;
    let body;
    if (this.turningPoint) {
      const tp = this.turningPoint;
      const kept = this.target === 1 ? 'the win' : 'the draw';
      const only = tp.others === 0 ? 'the only move' : 'one move';
      body = `
        <p class="label">Where it went wrong</p>
        <p class="turning">Move ${tp.number}, ${escapeHtml(tp.san)} — that is where ${kept} slipped away.</p>
        ${tp.bestSan ? `<p>${escapeHtml(tp.bestSan)} was ${only} that kept ${kept}.</p>` : ''}
        <p class="label">The method it broke</p>${steps}${reveal}`;
    } else {
      body = `<p class="label">The method</p>${steps}${reveal}`;
    }
    const retry = this.turningPoint
      ? `<button type="button" class="primary" id="btn-retry">Replay from move ${this.turningPoint.number}</button>` : '';
    this.el.finish.innerHTML = `${body}
      <div class="actions">
        ${retry}
        <button type="button" class="${retry ? '' : 'primary'}" id="btn-next">New position</button>
        <a class="button" href="#/m/${this.module.id}">Stop</a>
      </div>`;
    this.el.finish.hidden = false;
    const retryBtn = this.el.finish.querySelector('#btn-retry');
    if (retryBtn) retryBtn.onclick = () => this.beginRound(this.turningPoint.fenBefore);
    this.el.finish.querySelector('#btn-next').onclick = () => this.newPosition();
  }

  setStatus(text, tone) {
    this.el.status.textContent = text;
    this.el.status.dataset.tone = tone;
  }

  showNote(title, lines) {
    this.el.note.innerHTML = `<p class="note-title">${escapeHtml(title)}</p>` +
      (lines.length > 1
        ? `<ol class="method">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ol>`
        : `<p>${escapeHtml(lines[0])}</p>`);
    this.el.note.hidden = false;
  }

  hideNote() { this.el.note.hidden = true; }

  renderMoves() {
    const sans = this.board ? this.board.sanHistory() : [];
    const blackFirst = this.startStm === 1;
    let html = '';
    if (blackFirst && sans.length) html += `<li><span class="num">1.</span><span>…</span><span>${sans[0]}</span></li>`;
    const rest = blackFirst ? sans.slice(1) : sans;
    const offset = blackFirst ? 2 : 1;
    for (let i = 0; i < rest.length; i += 2) {
      html += `<li><span class="num">${i / 2 + offset}.</span><span>${rest[i]}</span><span>${rest[i + 1] || ''}</span></li>`;
    }
    this.el.moves.innerHTML = html || '<li class="empty">No moves yet</li>';
  }
}
