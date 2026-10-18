// Endgame drills. Positions are dealt at random and judged by the solver.
//
// Nothing is said while you play. If a move throws the result away the game
// carries on to its real conclusion, and only then does the post-mortem point
// back at the move that did it — so you see the consequence before the verdict.
import { TrainingBoard, Chess } from './board.js';
import { generate, readBoard, scoreState, scoredMoves, chooseReply, file, rank, WIN, DRAW } from './kpgen.js';
import { diagnose } from './coach.js';
import { recordEndgame, getModuleProgress } from './progress.js';

const REPLY_DELAY = 480;
const HOLD_TARGET = 16;        // defensive moves that count as holding the draw
const MOVE_LIMIT = 60;
const DEAD_DRAW_MOVES = 10;  // how long to play on once the win is gone

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
          <p class="goal">${escapeHtml(this.drill.goal)}</p>
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
    const pos = generate(this.drill.id);
    this.sourceId = pos.sourceDrill || this.drill.id;
    this.source = this.module.drills.find(d => d.id === this.sourceId) || this.drill;
    this.userColor = pos.userColor === 'w' ? 'white' : 'black';
    this.target = pos.userColor === 'w' ? WIN : DRAW;
    this.beginRound(pos.fen);
  }

  // Start (or restart) a round from a given position.
  beginRound(fen) {
    clearTimeout(this.timer);
    if (this.board) this.board.destroy();

    this.live = this.target;     // the result still available from here
    this.turningPoint = null;
    this.played = 0;
    this.helped = false;
    this.finished = false;
    this.startStm = fen.split(' ')[1] === 'w' ? 0 : 1;

    this.board = new TrainingBoard(this.el.board, this.userColor, m => this.onUserMove(m), fen);
    const stats = getModuleProgress(this.module.id).endgames[this.drill.id];
    this.el.eyebrow.textContent =
      `You play ${this.userColor === 'white' ? 'White' : 'Black'} · streak ${stats ? stats.streak : 0}`;
    this.el.finish.hidden = true;
    this.hideNote();
    this.renderMoves();
    this.afterChange();
  }

  state() {
    return readBoard(this.board.game);
  }

  // Moves from here that still reach `result`.
  optionsFor(result) {
    return scoredMoves(this.board.game, Chess).filter(m => m.result === result);
  }

  myTurn() {
    return (this.board.game.turn() === 'w') === (this.userColor === 'white');
  }

  afterChange() {
    this.renderMoves();
    if (this.finished) return;

    const st = this.state();
    const game = this.board.game;
    const defending = this.userColor === 'black';

    if (st.q >= 0) {
      // A pawn can queen and still not win, if the new queen drops straight off.
      if (scoreState(st).result === WIN) {
        return defending
          ? this.finish(false, 'The pawn queened.')
          : this.finish(true, 'The pawn queened.');
      }
      if (!defending) return this.finish(false, 'You queened, but the queen falls at once. Draw.');
      // Defending: let them take the queen themselves.
    }
    if (st.p < 0 && st.q < 0) {
      return defending
        ? this.finish(true, 'Pawn captured — bare kings, dead draw.')
        : this.finish(false, 'Your pawn is gone. Draw.');
    }
    if (game.isStalemate()) {
      return defending
        ? this.finish(true, 'Stalemate — the draw is safe.')
        : this.finish(false, 'Stalemate. Draw.');
    }
    // In the race drill, getting in front of the pawn settles it.
    if (this.sourceId === 'square' && this.live === DRAW
        && file(st.bk) === file(st.p) && rank(st.bk) > rank(st.p)) {
      return this.finish(true, 'Caught it — your king is in front of the pawn.');
    }
    if (defending && this.live === DRAW && this.played >= HOLD_TARGET) {
      return this.finish(true, 'You have held it long enough — this is a book draw.');
    }
    // Once the win is gone, show the draw being sealed and then stop; there is
    // nothing more to learn from shuffling around a dead position.
    if (!defending && this.turningPoint) {
      const blockaded = st.p >= 0 && file(st.bk) === file(st.p) && rank(st.bk) > rank(st.p);
      if (blockaded) return this.finish(false, 'Their king is parked in front of the pawn. Dead draw.');
      if (this.played - this.turningPoint.playedAt >= DEAD_DRAW_MOVES) {
        return this.finish(false, 'This is a dead draw now.');
      }
    }
    if (this.played >= MOVE_LIMIT) {
      return this.finish(false, defending
        ? 'Time called on this one.'
        : `Still winning after ${MOVE_LIMIT} moves, but the pawn is no closer to queening.`);
    }

    if (this.myTurn()) {
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
    const fenBefore = this.board.game.fen();
    const copy = new Chess(fenBefore);
    copy.move({ from: move.from, to: move.to, promotion: move.promotion });
    const after = readBoard(copy);
    const { result } = scoreState(after);

    // The result just slipped. Remember where it happened and say nothing.
    if (result !== this.live && !this.turningPoint) {
      const correct = this.optionsFor(this.live);
      const best = this.live === WIN && correct.length
        ? correct.reduce((a, b) => (b.depth < a.depth ? b : a))
        : correct[0];
      this.turningPoint = {
        number: Math.floor((this.startStm + this.board.sanHistory().length) / 2) + 1,
        playedAt: this.played,
        san: move.san,
        fenBefore,
        bestSan: best ? best.move.san : null,
        diagnosis: diagnose({ drillId: this.sourceId, before, after, move, correct }),
      };
      this.live = result;
    }

    this.played += 1;
    this.hideNote();
    this.board.play(move);
    this.afterChange();
  }

  hint() {
    if (this.finished || !this.myTurn()) return;
    this.helped = true;
    const correct = this.optionsFor(this.live);
    const slip = scoredMoves(this.board.game, Chess).find(m => m.result !== this.live);
    if (!correct.length) return;
    const ref = slip || correct[0];
    this.showNote(diagnose({
      drillId: this.sourceId,
      before: this.state(),
      after: ref.state,
      move: ref.move,
      correct,
    }));
  }

  showMove() {
    if (this.finished || !this.myTurn()) return;
    this.helped = true;
    const correct = this.optionsFor(this.live);
    if (!correct.length) return;
    const best = this.live === WIN
      ? correct.reduce((a, b) => (b.depth < a.depth ? b : a))
      : correct[0];
    this.board.showArrow(best.move.from, best.move.to);
    this.showNote({
      principle: 'One move that works',
      text: `${best.move.san} keeps ${this.live === WIN ? 'the win' : 'the draw'}. Usually more than one move does.`,
    });
  }

  stepBack() {
    if (this.finished || this.board.sanHistory().length === 0) return;
    clearTimeout(this.timer);
    this.board.clearArrows();
    while (this.board.sanHistory().length > 0) {
      this.board.undo();
      if (this.myTurn()) break;
    }
    // Taking the move back un-does the slip too, if that is where we are.
    if (this.turningPoint && this.board.game.fen() === this.turningPoint.fenBefore) {
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

    const reveal = this.drill.id === 'random'
      ? `<p class="meta">This one was: ${escapeHtml(this.source.name)}.</p>` : '';

    let body;
    if (this.turningPoint) {
      const tp = this.turningPoint;
      const kept = this.target === WIN ? 'the win' : 'the draw';
      body = `
        <p class="label">Where it went wrong</p>
        <p class="turning">Move ${tp.number}, ${escapeHtml(tp.san)} — that is where ${kept} slipped away.</p>
        <p class="note-title">${escapeHtml(tp.diagnosis.principle)}</p>
        <p>${escapeHtml(tp.diagnosis.text)}</p>
        ${tp.bestSan ? `<p class="meta">${escapeHtml(tp.bestSan)} was one move that kept ${kept}. Everything after that was already lost ground.</p>` : ''}
        ${reveal}`;
    } else {
      body = `<p class="label">${won ? 'The principle' : 'What happened'}</p>
              <p>${escapeHtml(this.source.idea)}</p>${reveal}`;
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

  showNote({ principle, text }) {
    this.el.note.innerHTML = `<p class="note-title">${escapeHtml(principle)}</p><p>${escapeHtml(text)}</p>`;
    this.el.note.hidden = false;
  }

  hideNote() {
    this.el.note.hidden = true;
  }

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
