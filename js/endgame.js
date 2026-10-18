// Endgame drills. Positions are dealt at random and judged by a solver, never
// from a stored line.
//
// Nothing is said while you play. If a move throws the result away the game
// carries on to its real conclusion, and only then does the post-mortem point
// back at the move that did it.
import { TrainingBoard, Chess } from './board.js';
import { generate, readBoard, file, rank } from './kpgen.js';
import { generateRace } from './race.js';
import { scoreFen, scoreMoves, chooseReply, census, OracleOffline, WHITE_WINS, DRAWN } from './oracle.js';
import { diagnose, diagnoseRace } from './coach.js';
import { recordEndgame, getModuleProgress } from './progress.js';

const REPLY_DELAY = 480;
const HOLD_TARGET = 16;        // defensive moves that count as holding the draw
const DEAD_MOVES = 10;         // how long to play on once the result is gone
const MOVE_LIMIT = 60;

const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class EndgameTrainer {
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

  async newPosition() {
    clearTimeout(this.timer);
    this.setStatus('Dealing a position…', 'neutral');
    this.el.finish.hidden = true;
    this.hideNote();

    let pos;
    const wantsRace = this.drill.id === 'race'
      || (this.drill.id === 'random' && Math.random() < 0.25);
    try {
      if (wantsRace) {
        pos = await generateRace();
        if (!pos) pos = await generateRace({ budget: 60 });   // unlucky run of candidates
      } else {
        pos = generate(this.drill.id);
      }
      if (!pos) {
        this.setStatus('Could not find a race position just now. Try again.', 'bad');
        return;
      }
    } catch (e) {
      if (e instanceof OracleOffline) return this.offline();
      throw e;
    }

    this.sourceId = pos.sourceDrill || this.drill.id;
    this.source = this.module.drills.find(d => d.id === this.sourceId) || this.drill;
    this.isRace = this.sourceId === 'race';
    this.userColor = pos.userColor === 'w' ? 'white' : 'black';
    this.target = pos.userColor === 'w' ? WHITE_WINS : DRAWN;
    this.beginRound(pos.fen);
  }

  offline() {
    this.setStatus('Cannot reach the endgame database.', 'bad');
    this.showNote({
      principle: 'Offline',
      text: 'The race drill looks positions up in Lichess’s endgame tablebase, so it needs a connection. The other four drills are solved inside the page and work offline.',
    });
    this.el.finish.innerHTML = `<div class="actions">
      <button type="button" class="primary" id="btn-next">Try again</button>
      <a class="button" href="#/m/${this.module.id}">Back</a></div>`;
    this.el.finish.hidden = false;
    this.el.finish.querySelector('#btn-next').onclick = () => this.newPosition();
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

  fen() { return this.board.game.fen(); }

  myTurn() {
    return (this.board.game.turn() === 'w') === (this.userColor === 'white');
  }

  // Moves from here that still reach `wdl`.
  async optionsFor(wdl) {
    return (await scoreMoves(this.board.game, Chess)).filter(m => m.wdl === wdl);
  }

  async afterChange() {
    this.renderMoves();
    if (this.finished) return;

    const fen = this.fen();
    const game = this.board.game;
    const defending = this.userColor === 'black';
    const c = census(fen);

    let wdl;
    try {
      ({ wdl } = await scoreFen(fen));
    } catch (e) {
      if (e instanceof OracleOffline) return this.offline();
      throw e;
    }

    if (game.isStalemate()) {
      return defending
        ? this.finish(true, 'Stalemate — the draw is safe.')
        : this.finish(false, 'Stalemate. Draw.');
    }

    if (this.isRace) {
      if (c.wq > 0 && wdl === this.target) return this.finish(true, 'You queened and the race is won.');
      if (c.bq > 0 && wdl !== this.target) {
        return this.finish(false, c.wq > 0
          ? 'Both queened \u2014 that is only a draw.'
          : 'They queened first.');
      }
    } else {
      const st = readBoard(game);
      if (st.q >= 0) {
        if (wdl === WHITE_WINS) {
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
      if (this.sourceId === 'square' && this.live === DRAWN
          && st.p >= 0 && file(st.bk) === file(st.p) && rank(st.bk) > rank(st.p)) {
        return this.finish(true, 'Caught it — your king is in front of the pawn.');
      }
      if (!defending && this.turningPoint && st.p >= 0
          && file(st.bk) === file(st.p) && rank(st.bk) > rank(st.p)) {
        return this.finish(false, 'Their king is parked in front of the pawn. Dead draw.');
      }
    }

    if (defending && this.live === this.target && this.played >= HOLD_TARGET) {
      return this.finish(true, 'You have held it long enough — this is a book draw.');
    }
    if (this.turningPoint && this.played - this.turningPoint.playedAt >= DEAD_MOVES) {
      return this.finish(false, this.target === WHITE_WINS
        ? 'The win is gone for good now.' : 'They are through.');
    }
    if (this.played >= MOVE_LIMIT) {
      return this.finish(false, defending
        ? 'Time called on this one.'
        : `Still winning after ${MOVE_LIMIT} moves, but no closer to queening.`);
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

  async opponentMove() {
    let reply;
    try {
      reply = await chooseReply(this.board.game, Chess);
    } catch (e) {
      if (e instanceof OracleOffline) return this.offline();
      throw e;
    }
    if (!reply) return this.afterChange();
    this.board.setLocked(false);
    this.board.play({ from: reply.from, to: reply.to, promotion: reply.promotion });
    this.afterChange();
  }

  async onUserMove(move) {
    if (this.finished || this.busy) return;
    this.busy = true;
    this.board.clearArrows();
    try {
      const beforeFen = this.fen();
      const copy = new Chess(beforeFen);
      copy.move({ from: move.from, to: move.to, promotion: move.promotion });
      const afterFen = copy.fen();
      const { wdl } = await scoreFen(afterFen);

      // The result just slipped. Remember where, and say nothing.
      if (wdl !== this.live && !this.turningPoint) {
        const correct = await this.optionsFor(this.live);
        const best = this.pickBest(correct);
        this.turningPoint = {
          number: Math.floor((this.startStm + this.board.sanHistory().length) / 2) + 1,
          playedAt: this.played,
          san: move.san,
          fenBefore: beforeFen,
          bestSan: best ? best.move.san : null,
          diagnosis: this.isRace
            ? diagnoseRace({ beforeFen, afterFen, move, correct })
            : diagnose({
                drillId: this.sourceId,
                before: readBoard(new Chess(beforeFen)),
                after: readBoard(copy),
                move,
                correct: correct.map(o => ({ ...o, state: readBoard(new Chess(o.fen)) })),
              }),
        };
        this.live = wdl;
      }

      this.played += 1;
      this.hideNote();
      this.board.play(move);
      await this.afterChange();
    } catch (e) {
      if (e instanceof OracleOffline) this.offline();
      else throw e;
    } finally {
      this.busy = false;
    }
  }

  // Of several good moves, the one that gets on with it.
  pickBest(options) {
    if (!options.length) return null;
    if (this.target === WHITE_WINS) {
      return options.reduce((a, b) => (b.depth < a.depth ? b : a));
    }
    return options[0];
  }

  async hint() {
    if (this.finished || !this.myTurn() || this.busy) return;
    this.helped = true;
    const correct = await this.optionsFor(this.live);
    if (!correct.length) return;
    const all = await scoreMoves(this.board.game, Chess);
    const slip = all.find(m => m.wdl !== this.live) || correct[0];
    const beforeFen = this.fen();
    this.showNote(this.isRace
      ? diagnoseRace({ beforeFen, afterFen: slip.fen, move: slip.move, correct })
      : diagnose({
          drillId: this.sourceId,
          before: readBoard(this.board.game),
          after: readBoard(new Chess(slip.fen)),
          move: slip.move,
          correct: correct.map(o => ({ ...o, state: readBoard(new Chess(o.fen)) })),
        }));
  }

  async showMove() {
    if (this.finished || !this.myTurn() || this.busy) return;
    this.helped = true;
    const correct = await this.optionsFor(this.live);
    if (!correct.length) return;
    const best = this.pickBest(correct);
    this.board.showArrow(best.move.from, best.move.to);
    this.showNote({
      principle: 'One move that works',
      text: `${best.move.san} keeps ${this.live === WHITE_WINS ? 'the win' : 'the draw'}. Usually more than one move does.`,
    });
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

    const reveal = this.drill.id === 'random'
      ? `<p class="meta">This one was: ${escapeHtml(this.source.name)}.</p>` : '';

    let body;
    if (this.turningPoint) {
      const tp = this.turningPoint;
      const kept = this.target === WHITE_WINS ? 'the win' : 'the draw';
      body = `
        <p class="label">Where it went wrong</p>
        <p class="turning">Move ${tp.number}, ${escapeHtml(tp.san)} — that is where ${kept} slipped away.</p>
        <p class="note-title">${escapeHtml(tp.diagnosis.principle)}</p>
        <p>${escapeHtml(tp.diagnosis.text)}</p>
        ${tp.bestSan ? `<p class="meta">${escapeHtml(tp.bestSan)} was one move that kept ${kept}.</p>` : ''}
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
