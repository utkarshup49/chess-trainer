// Walk through a line before being tested on it.
//
// Every position is reachable with Next and Back, the move to play is drawn on
// the board, and the same note that the test would give as a correction is
// shown here as the teaching point. You can also just play the move yourself.
import { TrainingBoard } from './board.js';
import { recordStudy } from './progress.js';

const AUTOPLAY_MS = 1500;
const REPLY_MS = 550;

const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class LineStudy {
  constructor(container, module, { lineId }) {
    this.container = container;
    this.module = module;
    this.line = module.lines.find(l => l.id === lineId);
    this.moves = this.line.moves.split(' ');
    this.side = this.line.side;                   // the colour being taught
    this.ply = 0;
    this.timer = null;
    this.autoplay = false;

    this.renderShell();
    this.keyHandler = e => {
      if (e.key === 'ArrowRight') this.step(1);
      else if (e.key === 'ArrowLeft') this.step(-1);
    };
    window.addEventListener('keydown', this.keyHandler);

    this.board = new TrainingBoard(this.el.board, this.side, m => this.onUserMove(m));
    this.render();
  }

  renderShell() {
    this.container.innerHTML = `
      <section class="train">
        <div class="board-col"><div class="board-wrap" id="board"></div></div>
        <aside class="panel">
          <a class="crumb" href="#/m/${this.module.id}">← ${escapeHtml(this.module.title)}</a>
          <p class="eyebrow">Learn · you play ${this.side === 'white' ? 'White' : 'Black'}</p>
          <h1 class="line-title">${escapeHtml(this.line.name)}</h1>
          <div class="teach" id="teach"></div>
          <div class="actions">
            <button type="button" id="btn-prev" title="Shortcut: left arrow">Back</button>
            <button type="button" class="primary" id="btn-next" title="Shortcut: right arrow">Next move</button>
            <button type="button" id="btn-auto">Play it through</button>
            <button type="button" id="btn-restart">Restart</button>
          </div>
          <div class="finish" id="finish" hidden></div>
          <div class="moves-box">
            <p class="label">The line — click any move to jump there</p>
            <ol class="moves study-moves" id="moves"></ol>
          </div>
        </aside>
      </section>`;

    this.el = {
      board: this.container.querySelector('#board'),
      teach: this.container.querySelector('#teach'),
      moves: this.container.querySelector('#moves'),
      finish: this.container.querySelector('#finish'),
      auto: this.container.querySelector('#btn-auto'),
      next: this.container.querySelector('#btn-next'),
      prev: this.container.querySelector('#btn-prev'),
    };
    this.el.next.onclick = () => this.step(1);
    this.el.prev.onclick = () => this.step(-1);
    this.el.auto.onclick = () => this.toggleAutoplay();
    this.container.querySelector('#btn-restart').onclick = () => { this.stopAutoplay(); this.goto(0); };
    this.el.moves.onclick = e => {
      const target = e.target.closest('[data-ply]');
      if (!target) return;
      this.stopAutoplay();
      this.goto(Number(target.dataset.ply));
    };
  }

  destroy() {
    clearTimeout(this.timer);
    window.removeEventListener('keydown', this.keyHandler);
    if (this.board) this.board.destroy();
  }

  // Whose move is it at this point in the line?
  moverAt(ply) {
    return ply % 2 === 0 ? 'white' : 'black';
  }

  // The note attached to the move about to be played, if there is one.
  noteFor(ply) {
    const explain = this.module.explain || {};
    const prefix = this.moves.slice(0, ply).join(' ');
    return explain[`${prefix}|${this.moves[ply]}`] || explain[`${prefix}|*`] || null;
  }

  step(delta) {
    this.stopAutoplay();
    this.goto(this.ply + delta);
  }

  goto(target) {
    const clamped = Math.max(0, Math.min(this.moves.length, target));
    while (this.ply > clamped) { this.board.undo(); this.ply -= 1; }
    while (this.ply < clamped) { this.board.play(this.moves[this.ply]); this.ply += 1; }
    this.render();
  }

  onUserMove(move) {
    this.stopAutoplay();
    const expected = this.moves[this.ply];
    if (move.san !== expected) {
      this.board.reject(move.from, move.to);
      this.flash(`In this line the move is ${expected}. Play that one, or press Next.`);
      this.timer = setTimeout(() => this.render(), 1000);
      return;
    }
    this.board.play(move);
    this.ply += 1;
    this.render();
    // Play their reply straight away so you always land on your own move.
    if (this.ply < this.moves.length && this.moverAt(this.ply) !== this.side) {
      this.timer = setTimeout(() => {
        this.board.play(this.moves[this.ply]);
        this.ply += 1;
        this.render();
      }, REPLY_MS);
    }
  }

  toggleAutoplay() {
    if (this.autoplay) return this.stopAutoplay();
    if (this.ply >= this.moves.length) this.goto(0);
    this.autoplay = true;
    this.el.auto.textContent = 'Pause';
    const tick = () => {
      if (!this.autoplay) return;
      if (this.ply >= this.moves.length) return this.stopAutoplay();
      this.goto(this.ply + 1);
      if (this.ply < this.moves.length) this.timer = setTimeout(tick, AUTOPLAY_MS);
      else this.stopAutoplay();
    };
    this.timer = setTimeout(tick, AUTOPLAY_MS / 2);
  }

  stopAutoplay() {
    this.autoplay = false;
    clearTimeout(this.timer);
    this.el.auto.textContent = 'Play it through';
  }

  flash(text) {
    this.el.teach.innerHTML = `<p class="note-title">Not that one</p><p>${escapeHtml(text)}</p>`;
  }

  render() {
    this.renderMoves();
    const atEnd = this.ply >= this.moves.length;
    this.el.prev.disabled = this.ply === 0;
    this.el.next.disabled = atEnd;

    if (atEnd) {
      this.board.clearArrows();
      this.board.setLocked(true);
      this.el.teach.innerHTML =
        `<p class="note-title">That is the whole line</p><p>${escapeHtml(this.line.idea || '')}</p>`;
      this.showFinish();
      if (!this.recorded) {
        this.recorded = true;
        recordStudy(this.module.id, this.line.id);
      }
      return;
    }

    this.el.finish.hidden = true;
    this.board.setLocked(false);
    const san = this.moves[this.ply];
    const mine = this.moverAt(this.ply) === this.side;
    const shape = this.board.preview(san);
    this.board.showArrow(shape.from, shape.to, mine ? 'green' : 'blue');

    if (mine) {
      const note = this.noteFor(this.ply);
      this.el.teach.innerHTML =
        `<p class="note-title">Your move: ${escapeHtml(san)}</p>
         <p>${escapeHtml(note || 'Play the move shown on the board.')}</p>
         <p class="meta">Play it on the board, or press Next.</p>`;
    } else {
      this.el.teach.innerHTML =
        `<p class="note-title">They reply ${escapeHtml(san)}</p>
         <p class="meta">Shown in blue. Press Next to play it.</p>`;
    }
  }

  showFinish() {
    const sameSide = this.module.lines.filter(l => l.side === this.side);
    const idx = sameSide.findIndex(l => l.id === this.line.id);
    const next = sameSide[idx + 1];
    this.el.finish.innerHTML = `
      <div class="actions">
        <a class="button primary" href="#/m/${this.module.id}/practice/${this.line.id}">Now test me on it</a>
        ${next ? `<a class="button" href="#/m/${this.module.id}/study/${next.id}">Next line</a>` : ''}
        <a class="button" href="#/m/${this.module.id}">All lines</a>
      </div>`;
    this.el.finish.hidden = false;
  }

  renderMoves() {
    let html = '';
    for (let i = 0; i < this.moves.length; i += 2) {
      const cell = j => {
        if (j >= this.moves.length) return '<span></span>';
        const here = j + 1 === this.ply ? ' class="here"' : '';
        return `<span${here} data-ply="${j + 1}" role="button" tabindex="0">${this.moves[j]}</span>`;
      };
      html += `<li><span class="num">${i / 2 + 1}.</span>${cell(i)}${cell(i + 1)}</li>`;
    }
    this.el.moves.innerHTML = html;
  }
}
