// Daily review: the opening moves that spaced repetition says are due today.
//
// Due moves are grouped by line. Each line is played from the start: the
// opponent's moves and your moves that are not due yet are played for you,
// and the board stops at each due move for you to find. Found first time,
// without help: the next review moves further away. Missed: it comes back
// tomorrow, and once more at the end of this session.
import { TrainingBoard } from './board.js';
import { dueKeys, review, summary } from './srs.js';
import { markActive } from './activity.js';

const AUTO_MS = 380;
const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Cover the due keys of a module with as few lines as possible.
function planRounds(module, keys) {
  const lines = module.lines.map(l => ({ ...l, list: l.moves.split(' ') }));
  const left = new Set(keys);
  const rounds = [];
  const contains = (line, key) => {
    const [prefix, move] = key.split('|');
    const pre = prefix ? prefix.split(' ') : [];
    return pre.every((m, i) => line.list[i] === m) && line.list[pre.length] === move;
  };
  while (left.size) {
    let best = null, bestKeys = [];
    for (const line of lines) {
      const covered = [...left].filter(k => contains(line, k));
      if (covered.length > bestKeys.length) { best = line; bestKeys = covered; }
    }
    if (!best) break;            // a key from a line that no longer exists
    bestKeys.forEach(k => left.delete(k));
    rounds.push({ module, line: best, due: new Set(bestKeys) });
  }
  return rounds;
}

export class DueReview {
  constructor(container, modules, { moduleId } = {}) {
    this.container = container;
    this.modules = moduleId ? modules.filter(m => m.id === moduleId) : modules;
    this.alive = true;
    this.rounds = this.modules.flatMap(m => planRounds(m, dueKeys(m.id)));
    this.total = this.rounds.reduce((n, r) => n + r.due.size, 0);
    this.done = 0;
    this.remembered = 0;
    this.missed = [];          // { module, key } to go over once more at the end
    this.renderShell();
    this.backHref = moduleId ? `#/m/${moduleId}` : '#/';
    this.el.back.href = this.backHref;
    if (!this.total) return this.finishSession(true);
    this.nextRound();
  }

  renderShell() {
    this.container.innerHTML = `
      <section class="train">
        <div class="board-col"><div class="board-wrap" id="board"></div></div>
        <aside class="panel">
          <a class="crumb" id="back" href="#/">← Back</a>
          <p class="eyebrow" id="eyebrow">Daily review</p>
          <h1 class="line-title" id="title">Opening review</h1>
          <div class="status" id="status" data-tone="neutral"></div>
          <div class="teach" id="note" hidden></div>
          <div class="actions">
            <button type="button" id="btn-show">Show move</button>
          </div>
          <div class="finish" id="finish" hidden></div>
          <div class="meter" aria-hidden="true"><span id="meter" style="width:0%"></span></div>
          <p class="meta" id="count"></p>
        </aside>
      </section>`;
    const $ = id => this.container.querySelector('#' + id);
    this.el = { board: $('board'), back: $('back'), eyebrow: $('eyebrow'), title: $('title'), status: $('status'), note: $('note'), finish: $('finish'), meter: $('meter'), count: $('count') };
    $('btn-show').onclick = () => this.showMove();
  }

  destroy() {
    this.alive = false;
    if (this.board) this.board.destroy();
  }

  updateCount() {
    const pct = this.total ? Math.round((this.done / this.total) * 100) : 100;
    this.el.meter.style.width = pct + '%';
    this.el.count.textContent = `${this.done} of ${this.total} due moves reviewed · ${this.remembered} remembered`;
  }

  async nextRound() {
    const round = this.rounds.shift();
    if (!round) return this.finishSession(false);
    this.round = round;
    this.ply = 0;
    this.el.note.hidden = true;
    this.el.finish.hidden = true;
    this.el.eyebrow.textContent = `${round.relearn ? 'Once more' : 'Daily review'} · ${round.module.title}`;
    this.el.title.textContent = round.line.name;
    if (this.board) this.board.destroy();
    this.board = new TrainingBoard(this.el.board, round.line.side, m => this.onUserMove(m));
    this.updateCount();
    await this.advance();
  }

  keyAt(ply) {
    return this.round.line.list.slice(0, ply).join(' ') + '|' + this.round.line.list[ply];
  }

  // Play moves for you until the next due move (or the end of what's due).
  async advance() {
    const { line, due } = this.round;
    this.board.setLocked(true);
    while (this.alive && this.ply < line.list.length) {
      const key = this.keyAt(this.ply);
      const mine = this.board.sideToMove() === line.side;
      if (mine && due.has(key)) {
        this.failed = false;
        this.board.setLocked(false);
        this.setStatus('Your move: what does your repertoire play here?');
        return;
      }
      if (![...due].some(k => !this.reviewed(k))) break; // nothing left in this line
      await sleep(AUTO_MS);
      if (!this.alive) return;
      this.board.play(line.list[this.ply]);
      this.ply += 1;
    }
    if (this.alive) this.nextRound();
  }

  reviewed(key) {
    return this.round.reviewedKeys && this.round.reviewedKeys.has(key);
  }

  onUserMove(move) {
    const { line, module } = this.round;
    const expected = line.list[this.ply];
    const key = this.keyAt(this.ply);
    if (move.san !== expected) {
      this.failed = true;
      this.board.reject(move.from, move.to);
      const why = (module.explain || {})[key] || '';
      this.setStatus(`Not ${move.san}. Try again, or press Show move.`, 'bad');
      this.showNote(why ? `Hint: ${why}` : 'That is not the move in your repertoire.');
      return;
    }
    this.board.play(move);
    this.board.clearArrows();
    this.ply += 1;
    this.round.reviewedKeys = this.round.reviewedKeys || new Set();
    this.round.reviewedKeys.add(key);
    if (!this.round.relearn) {
      const card = review(module.id, key, !this.failed);
      markActive();
      this.done += 1;
      if (!this.failed) this.remembered += 1;
      else this.missed.push({ module, key });
      this.setStatus(this.failed
        ? `${expected} it is. You'll see this one again tomorrow.`
        : `Remembered. Next review in ${card.interval} day${card.interval === 1 ? '' : 's'}.`, this.failed ? 'neutral' : 'good');
    } else {
      this.setStatus(`${expected}. Got it.`, 'good');
    }
    this.el.note.hidden = true;
    this.updateCount();
    this.advance();
  }

  showMove() {
    if (!this.round || this.board.sideToMove() !== this.round.line.side) return;
    this.failed = true;
    const m = this.board.preview(this.round.line.list[this.ply]);
    this.board.showArrow(m.from, m.to, 'green');
    const why = (this.round.module.explain || {})[this.keyAt(this.ply)] || '';
    this.showNote(why);
  }

  finishSession(empty) {
    // Missed moves get one more pass before the session ends.
    if (!empty && this.missed.length && !this.relearnQueued) {
      this.relearnQueued = true;
      for (const m of this.modules) {
        const keys = this.missed.filter(x => x.module.id === m.id).map(x => x.key);
        planRounds(m, keys).forEach(r => this.rounds.push({ ...r, relearn: true }));
      }
      return this.nextRound();
    }
    if (this.board) this.board.setLocked(true);
    const nexts = this.modules.map(m => summary(m.id).next).filter(Boolean).sort();
    const when = nexts[0] ? new Date(nexts[0] + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }) : null;
    this.el.eyebrow.textContent = 'Daily review';
    this.el.title.textContent = empty ? 'Nothing due today' : 'Review done';
    this.setStatus(empty
      ? 'All your opening moves are fresh. Learn or test a line to add it to your reviews.'
      : `${this.remembered} of ${this.total} remembered first time.`, empty ? 'neutral' : 'good');
    this.el.note.hidden = true;
    this.el.finish.innerHTML = `
      ${when ? `<p class="meta">Next moves due: ${escapeHtml(when)}.</p>` : ''}
      <div class="actions"><a class="button primary" href="${this.backHref}">Done</a></div>`;
    this.el.finish.hidden = false;
    this.updateCount();
  }

  setStatus(text, tone = 'neutral') {
    this.el.status.textContent = text;
    this.el.status.dataset.tone = tone;
  }

  showNote(text) {
    this.el.note.innerHTML = `<p>${escapeHtml(text)}</p>`;
    this.el.note.hidden = !text;
  }
}
