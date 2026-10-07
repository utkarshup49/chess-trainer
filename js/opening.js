// Opening trainer: learn one line, or drill random lines from a move tree.
import { TrainingBoard } from './board.js';
import { recordLine, recordDrill, getModuleProgress } from './progress.js';

const OPPONENT_DELAY = 550;

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function startsWith(moves, played) {
  if (played.length > moves.length) return false;
  for (let i = 0; i < played.length; i++) {
    if (moves[i] !== played[i]) return false;
  }
  return true;
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export class OpeningTrainer {
  // mode: 'learn' or 'drill'. For learn, lineId is the line. For drill, side is 'white', 'black' or 'mixed'.
  constructor(container, module, { mode, lineId, side }) {
    this.container = container;
    this.module = module;
    this.mode = mode;
    this.lineId = lineId;
    this.side = side;
    this.lastLineId = null;
    this.timer = null;
    this.board = null;

    // Split each line's move string once.
    this.lines = module.lines.map(l => ({ ...l, list: l.moves.split(' ') }));

    this.renderShell();
    this.bindKeys();
    this.newRound();
  }

  renderShell() {
    const backHref = '#/m/' + this.module.id;
    this.container.innerHTML = `
      <section class="train">
        <div class="board-col">
          <div class="board-wrap" id="board"></div>
        </div>
        <aside class="panel">
          <a class="crumb" href="${backHref}">← ${escapeHtml(this.module.title)}</a>
          <p class="eyebrow" id="eyebrow"></p>
          <h1 class="line-title" id="title"></h1>
          <div class="status" id="status" data-tone="neutral"></div>
          <p class="note" id="note" hidden></p>
          <div class="actions">
            <button type="button" id="btn-back" title="Shortcut: left arrow">Step back</button>
            <button type="button" id="btn-hint">Hint</button>
            <button type="button" id="btn-show">Show move</button>
            <button type="button" id="btn-restart">Restart</button>
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
      title: this.container.querySelector('#title'),
      status: this.container.querySelector('#status'),
      note: this.container.querySelector('#note'),
      moves: this.container.querySelector('#moves'),
      finish: this.container.querySelector('#finish'),
    };
    this.container.querySelector('#btn-back').onclick = () => this.stepBack();
    this.container.querySelector('#btn-hint').onclick = () => this.hint();
    this.container.querySelector('#btn-show').onclick = () => this.showMove();
    this.container.querySelector('#btn-restart').onclick = () => this.startRound(this.target, this.roundSide);
  }

  bindKeys() {
    this.keyHandler = e => {
      if (e.key === 'ArrowLeft') this.stepBack();
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  destroy() {
    clearTimeout(this.timer);
    window.removeEventListener('keydown', this.keyHandler);
    if (this.board) this.board.destroy();
  }

  // Choose the next line (random in drill mode) and start it.
  newRound() {
    if (this.mode === 'learn') {
      const line = this.lines.find(l => l.id === this.lineId);
      this.startRound(line, line.side);
      return;
    }
    const roundSide = this.side === 'mixed' ? pick(['white', 'black']) : this.side;
    let pool = this.lines.filter(l => l.side === roundSide);
    if (pool.length > 1) pool = pool.filter(l => l.id !== this.lastLineId);
    this.startRound(pick(pool), roundSide);
  }

  startRound(target, roundSide) {
    clearTimeout(this.timer);
    if (this.board) this.board.destroy();

    this.target = target;
    this.roundSide = roundSide;
    this.pool = this.lines.filter(l => l.side === roundSide);
    if (this.mode === 'learn') this.pool = [target];
    this.mistakes = 0;
    this.helped = false;
    this.finished = false;

    this.board = new TrainingBoard(this.el.board, roundSide, move => this.onUserMove(move));

    const sideText = roundSide === 'white' ? 'You play White' : 'You play Black';
    if (this.mode === 'learn') {
      this.el.eyebrow.textContent = 'Learn · ' + sideText;
      this.el.title.textContent = target.name;
    } else {
      const stats = getModuleProgress(this.module.id).drill;
      this.el.eyebrow.textContent = 'Random drill · ' + sideText + ' · streak ' + stats.streak;
      this.el.title.textContent = 'Which line is coming?';
    }
    this.el.finish.hidden = true;
    this.hideNote();
    this.afterChange();
  }

  played() {
    return this.board.sanHistory();
  }

  candidates() {
    const played = this.played();
    return this.pool.filter(l => startsWith(l.list, played));
  }

  // Correct next moves for the user right now.
  expectedMoves() {
    const n = this.played().length;
    const set = new Set();
    for (const l of this.candidates()) {
      if (l.list.length > n) set.add(l.list[n]);
    }
    return [...set];
  }

  afterChange() {
    this.renderMoves();
    const played = this.played();
    const cands = this.candidates();

    const done = cands.find(l => l.list.length === played.length);
    if (done) {
      this.finish(done);
      return;
    }
    if (!cands.some(l => l.id === this.target.id)) this.target = pick(cands);

    if (this.board.sideToMove() === this.roundSide) {
      this.setStatus('Your move', 'neutral');
      this.board.setLocked(false);
    } else {
      this.setStatus('Opponent is thinking…', 'neutral');
      this.board.setLocked(true);
      this.timer = setTimeout(() => this.opponentMove(), OPPONENT_DELAY);
    }
  }

  opponentMove() {
    const n = this.played().length;
    let options = this.candidates().filter(l => l.list.length > n);
    if (!options.some(l => l.id === this.target.id)) this.target = pick(options);
    this.board.setLocked(false);
    this.board.play(this.target.list[n]);
    this.afterChange();
  }

  onUserMove(move) {
    if (this.finished) return;
    this.board.clearArrows();
    const expected = this.expectedMoves();
    if (expected.includes(move.san)) {
      this.hideNote();
      this.board.play(move);
      this.afterChange();
      if (!this.finished && this.board.sideToMove() !== this.roundSide) this.setStatus('Correct: ' + move.san, 'good');
      return;
    }
    this.mistakes += 1;
    this.board.reject(move.from, move.to);
    this.setStatus(move.san + ' is not the move here. Try again.', 'bad');
    this.showNote(this.explanation());
  }

  // Explanation text for the position where the user has to move.
  explanation() {
    const played = this.played();
    const prefix = played.join(' ');
    const expected = this.expectedMoves();
    const ex = this.module.explain || {};
    let text;
    if (expected.length > 1) text = ex[prefix + '|*'];
    if (!text) {
      const main = this.target.list[played.length];
      text = ex[prefix + '|' + main] || ex[prefix + '|' + expected[0]];
    }
    return text || 'Look again at what your opponent just allowed.';
  }

  hint() {
    if (this.finished || this.board.sideToMove() !== this.roundSide) return;
    this.helped = true;
    this.showNote(this.explanation());
  }

  showMove() {
    if (this.finished || this.board.sideToMove() !== this.roundSide) return;
    this.helped = true;
    const san = this.target.list[this.played().length];
    const m = this.board.preview(san);
    this.board.showArrow(m.from, m.to);
    this.showNote(this.explanation());
  }

  // Undo back to your previous move, so you can play it again.
  stepBack() {
    if (this.board.sanHistory().length === 0) return;
    clearTimeout(this.timer);
    this.finished = false;
    this.el.finish.hidden = true;
    this.board.clearArrows();
    while (this.board.sanHistory().length > 0) {
      this.board.undo();
      if (this.board.sideToMove() === this.roundSide) break;
    }
    this.hideNote();
    this.afterChange();
  }

  finish(line) {
    this.finished = true;
    this.board.setLocked(true);
    const clean = this.mistakes === 0 && !this.helped;
    const summary = clean ? 'No mistakes.' : this.mistakes + (this.mistakes === 1 ? ' mistake' : ' mistakes') + (this.helped ? ', with help.' : '.');

    let buttons;
    if (this.mode === 'learn') {
      recordLine(this.module.id, line.id, clean);
      const sameSide = this.lines.filter(l => l.side === line.side);
      const idx = sameSide.findIndex(l => l.id === line.id);
      const next = sameSide[idx + 1];
      buttons = `<button type="button" class="primary" id="btn-again">Play it again</button>` +
        (next ? `<a class="button" href="#/m/${this.module.id}/learn/${next.id}">Next line</a>` : '') +
        `<a class="button" href="#/m/${this.module.id}">All lines</a>`;
    } else {
      const stats = recordDrill(this.module.id, line.id, clean);
      this.lastLineId = line.id;
      this.el.title.textContent = line.name;
      this.el.eyebrow.textContent = 'Random drill · streak ' + stats.streak + ' · best ' + stats.best;
      buttons = `<button type="button" class="primary" id="btn-next">Next random line</button>` +
        `<a class="button" href="#/m/${this.module.id}">Stop</a>`;
    }

    this.setStatus('Line complete. ' + summary, clean ? 'good' : 'neutral');
    this.hideNote();
    this.el.finish.innerHTML = `<p class="label">The idea</p><p>${escapeHtml(line.idea || '')}</p><div class="actions">${buttons}</div>`;
    this.el.finish.hidden = false;
    const again = this.el.finish.querySelector('#btn-again');
    if (again) again.onclick = () => this.startRound(line, line.side);
    const nextBtn = this.el.finish.querySelector('#btn-next');
    if (nextBtn) nextBtn.onclick = () => this.newRound();
  }

  setStatus(text, tone) {
    this.el.status.textContent = text;
    this.el.status.dataset.tone = tone;
  }

  showNote(text) {
    this.el.note.textContent = text;
    this.el.note.hidden = false;
  }

  hideNote() {
    this.el.note.hidden = true;
  }

  renderMoves() {
    const sans = this.played();
    let html = '';
    for (let i = 0; i < sans.length; i += 2) {
      html += `<li><span class="num">${i / 2 + 1}.</span><span>${sans[i]}</span><span>${sans[i + 1] || ''}</span></li>`;
    }
    this.el.moves.innerHTML = html || '<li class="empty">No moves yet</li>';
  }
}
