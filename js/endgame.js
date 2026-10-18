// Endgame drills. Every position is dealt at random and judged by the solver,
// so there are no moves to memorise: a move counts if it keeps the result.
import { TrainingBoard, Chess } from './board.js';
import { generate, readBoard, scoreState, scoredMoves, chooseReply, toFen, squareName, WIN, DRAW } from './kpgen.js';
import { diagnose, label } from './coach.js';
import { recordEndgame, getModuleProgress } from './progress.js';

const REPLY_DELAY = 520;
const HOLD_TARGET = 16;        // correct defensive moves that count as holding
const PUSH_LIMIT = 60;         // safety net for the attacking drill

const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class EndgameTrainer {
  constructor(container, module, { drillId }) {
    this.container = container;
    this.module = module;
    this.drill = module.drills.find(d => d.id === drillId);
    this.timer = null;
    this.board = null;

    this.renderShell();
    this.keyHandler = e => { if (e.key === 'ArrowLeft') this.stepBack(); };
    window.addEventListener('keydown', this.keyHandler);

    // Solving every King + Pawn vs King position takes a moment the first time,
    // so let the page paint before it starts.
    this.setStatus('Preparing positions…', 'neutral');
    setTimeout(() => this.newPosition(), 30);
  }

  renderShell() {
    this.container.innerHTML = `
      <section class="train">
        <div class="board-col"><div class="board-wrap" id="board"></div></div>
        <aside class="panel">
          <a class="crumb" href="#/m/${this.module.id}">← ${escapeHtml(this.module.title)}</a>
          <p class="eyebrow" id="eyebrow"></p>
          <h1 class="line-title">${escapeHtml(this.drill.name)}</h1>
          <p class="goal" id="goal">${escapeHtml(this.drill.goal)}</p>
          <div class="status" id="status" data-tone="neutral"></div>
          <div class="note" id="note" hidden></div>
          <div class="actions">
            <button type="button" id="btn-back" title="Shortcut: left arrow">Step back</button>
            <button type="button" id="btn-hint">Hint</button>
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

    this.el = {
      board: this.container.querySelector('#board'),
      eyebrow: this.container.querySelector('#eyebrow'),
      status: this.container.querySelector('#status'),
      note: this.container.querySelector('#note'),
      moves: this.container.querySelector('#moves'),
      finish: this.container.querySelector('#finish'),
    };
    this.container.querySelector('#btn-back').onclick = () => this.stepBack();
    this.container.querySelector('#btn-hint').onclick = () => this.hint();
    this.container.querySelector('#btn-show').onclick = () => this.showMove();
    this.container.querySelector('#btn-new').onclick = () => this.newPosition();
  }

  destroy() {
    clearTimeout(this.timer);
    window.removeEventListener('keydown', this.keyHandler);
    if (this.board) this.board.destroy();
  }

  newPosition() {
    clearTimeout(this.timer);
    if (this.board) this.board.destroy();

    const pos = generate(this.drill.id);
    this.start = pos;
    this.userColor = pos.userColor === 'w' ? 'white' : 'black';
    this.target = pos.userColor === 'w' ? WIN : DRAW;
    this.mistakes = 0;
    this.helped = false;
    this.goodMoves = 0;
    this.finished = false;

    this.board = new TrainingBoard(this.el.board, this.userColor, m => this.onUserMove(m), pos.fen);
    const stats = getModuleProgress(this.module.id).endgames?.[this.drill.id];
    const streak = stats ? stats.streak : 0;
    this.el.eyebrow.textContent = `You play ${this.userColor === 'white' ? 'White' : 'Black'} · streak ${streak}`;
    this.el.finish.hidden = true;
    this.hideNote();
    this.renderMoves();
    this.afterChange();
  }

  state() {
    return readBoard(this.board.game);
  }

  // Legal moves from here that keep the learner's result.
  goodOptions() {
    const all = scoredMoves(this.board.game, Chess);
    return all.filter(m => m.result === this.target);
  }

  afterChange() {
    this.renderMoves();
    if (this.finished) return;

    const st = this.state();
    const game = this.board.game;

    // Finished?
    if (this.userColor === 'white' && st.q >= 0) return this.finish(true, 'The pawn queened.');
    if (this.userColor === 'black' && st.p < 0 && st.q < 0) return this.finish(true, 'Pawn captured — bare kings, dead draw.');
    if (game.isStalemate()) {
      return this.userColor === 'black'
        ? this.finish(true, 'Stalemate — the draw is safe.')
        : this.finish(false, 'Stalemate. The win slipped away.');
    }
    if (this.userColor === 'black' && this.goodMoves >= HOLD_TARGET) {
      return this.finish(true, 'You have held it long enough — this is a book draw.');
    }
    if (this.userColor === 'white' && this.goodMoves >= PUSH_LIMIT) {
      return this.finish(false, 'Still winning, but it is taking too long. Try again with the king leading.');
    }

    const mine = (game.turn() === 'w') === (this.userColor === 'white');
    if (mine) {
      this.setStatus('Your move', 'neutral');
      this.board.setLocked(false);
    } else {
      this.setStatus('Thinking…', 'neutral');
      this.board.setLocked(true);
      this.timer = setTimeout(() => this.opponentMove(), REPLY_DELAY);
    }
  }

  opponentMove() {
    const reply = chooseReply(this.board.game, Chess);
    if (!reply) { this.afterChange(); return; }
    this.board.setLocked(false);
    this.board.play({ from: reply.from, to: reply.to, promotion: reply.promotion });
    this.afterChange();
  }

  onUserMove(move) {
    if (this.finished) return;
    this.board.clearArrows();

    const before = this.state();
    const copy = new Chess(this.board.game.fen());
    copy.move({ from: move.from, to: move.to, promotion: move.promotion });
    const after = readBoard(copy);
    const { result } = scoreState(after);

    if (result !== this.target) {
      this.mistakes += 1;
      this.board.reject(move.from, move.to);
      const verdict = this.target === WIN
        ? `${move.san} throws the win away — it becomes a draw.`
        : `${move.san} loses the draw — the pawn gets through.`;
      this.setStatus(verdict, 'bad');
      this.showNote(diagnose({
        drillId: this.drill.id,
        before,
        after,
        move,
        correct: this.goodOptions(),
      }));
      return;
    }

    this.goodMoves += 1;
    this.hideNote();
    this.board.play(move);
    const what = label({ drillId: this.drill.id, before, after: this.state(), move });
    this.afterChange();
    if (!this.finished) this.setStatus(`${move.san} — ${what}.`, 'good');
  }

  hint() {
    if (this.finished || !this.myTurn()) return;
    this.helped = true;
    const options = this.goodOptions();
    if (!options.length) return;
    // Explain the principle without naming the square.
    const worst = scoredMoves(this.board.game, Chess).find(m => m.result !== this.target);
    this.showNote(diagnose({
      drillId: this.drill.id,
      before: this.state(),
      after: worst ? worst.state : options[0].state,
      move: worst ? worst.move : options[0].move,
      correct: options,
    }));
  }

  showMove() {
    if (this.finished || !this.myTurn()) return;
    this.helped = true;
    const options = this.goodOptions();
    if (!options.length) return;
    const best = this.target === WIN
      ? options.reduce((a, b) => (b.depth < a.depth ? b : a))
      : options[0];
    this.board.showArrow(best.move.from, best.move.to);
    this.showNote({ principle: 'One move that works', text: `${best.move.san} keeps ${this.target === WIN ? 'the win' : 'the draw'}. Often more than one move does.` });
  }

  myTurn() {
    return (this.board.game.turn() === 'w') === (this.userColor === 'white');
  }

  stepBack() {
    if (this.finished || this.board.sanHistory().length === 0) return;
    clearTimeout(this.timer);
    this.board.clearArrows();
    while (this.board.sanHistory().length > 0) {
      this.board.undo();
      if (this.myTurn()) break;
    }
    this.goodMoves = Math.max(0, this.goodMoves - 1);
    this.hideNote();
    this.afterChange();
  }

  finish(won, summary) {
    this.finished = true;
    this.board.setLocked(true);
    const clean = won && this.mistakes === 0 && !this.helped;
    const stats = recordEndgame(this.module.id, this.drill.id, clean);
    this.el.eyebrow.textContent = `You play ${this.userColor === 'white' ? 'White' : 'Black'} · streak ${stats.streak} · best ${stats.best}`;
    const tally = clean
      ? 'No mistakes, no help.'
      : `${this.mistakes} wrong ${this.mistakes === 1 ? 'move' : 'moves'}${this.helped ? ', with help' : ''}.`;
    this.setStatus(`${summary} ${won ? tally : ''}`.trim(), won ? 'good' : 'bad');
    this.hideNote();
    this.el.finish.innerHTML =
      `<p class="label">The principle</p><p>${escapeHtml(this.drill.idea)}</p>
       <div class="actions">
         <button type="button" class="primary" id="btn-next">Next position</button>
         <a class="button" href="#/m/${this.module.id}">Stop</a>
       </div>`;
    this.el.finish.hidden = false;
    this.el.finish.querySelector('#btn-next').onclick = () => this.newPosition();
  }

  setStatus(text, tone) {
    this.el.status.textContent = text;
    this.el.status.dataset.tone = tone;
  }

  showNote({ principle, text }) {
    this.el.note.innerHTML = `<p class="note-title">${escapeHtml(principle)}</p><p>${escapeHtml(text)}</p>`;
    this.el.note.hidden = false;
  }

  hideNote() {
    this.el.note.hidden = true;
  }

  renderMoves() {
    const sans = this.board ? this.board.sanHistory() : [];
    const blackFirst = this.start && this.start.stm === 1;
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
