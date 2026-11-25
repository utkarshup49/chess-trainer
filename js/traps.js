// Punish their mistakes: puzzles from your own openings.
//
// Each puzzle starts in one of your lines; the opponent leaves the line with
// a move that looks natural but loses, and you have to find the punishment.
// The puzzles were made offline: every one was checked with Stockfish 17.1
// (the mistake costs at least 1.5 pawns and you have one clear way to cash in),
// and any move within half a pawn of the best one also counts.
import { TrainingBoard, Chess } from './board.js';
import { markActive } from './activity.js';
import { openInAnalysis } from './handoff.js';

const KEY = 'chess-gym-traps-v1';
const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadStats() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
}
function saveStat(id, solvedFirstTry) {
  const all = loadStats();
  const s = all[id] || { tries: 0, clean: 0 };
  s.tries += 1;
  if (solvedFirstTry) s.clean += 1;
  s.last = solvedFirstTry ? 'clean' : 'missed';
  all[id] = s;
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) { /* not kept */ }
}

// How many of a module's puzzles you have solved cleanly at least once.
export function trapProgress(puzzles) {
  const all = loadStats();
  return { total: puzzles.length, solved: puzzles.filter(p => (all[p.id] || {}).clean).length };
}

// New puzzles first, then the ones you last missed, then the rest.
function choose(puzzles, previousId) {
  const all = loadStats();
  const pool = puzzles.filter(p => p.id !== previousId);
  const fresh = pool.filter(p => !all[p.id]);
  const missed = pool.filter(p => all[p.id] && all[p.id].last === 'missed');
  const list = fresh.length ? fresh : missed.length ? missed : pool;
  return list[Math.floor(Math.random() * list.length)] || puzzles[0];
}

export class TrapTrainer {
  constructor(container, module, puzzles, { puzzleId } = {}) {
    this.container = container;
    this.module = module;
    this.puzzles = puzzles;
    this.alive = true;
    this.renderShell();
    const first = puzzleId && puzzles.find(p => p.id === puzzleId);
    this.start(first || choose(puzzles, null));
  }

  renderShell() {
    this.container.innerHTML = `
      <section class="train">
        <div class="board-col"><div class="board-wrap" id="board"></div></div>
        <aside class="panel">
          <a class="crumb" href="#/m/${this.module.id}">← ${escapeHtml(this.module.title)}</a>
          <p class="eyebrow" id="eyebrow">Punish their mistakes</p>
          <h1 class="line-title" id="title"></h1>
          <div class="status" id="status" data-tone="neutral"></div>
          <div class="teach" id="note" hidden></div>
          <div class="actions nav">
            <button type="button" id="btn-hint">Hint</button>
            <button type="button" id="btn-show">Show solution</button>
            <button type="button" class="primary" id="btn-next">Next puzzle</button>
          </div>
          <div class="actions" id="after" hidden>
            <a class="button" id="btn-analyse" href="#/analysis">Analyse this position</a>
          </div>
          <p class="meta" id="progress"></p>
          <div class="moves-box">
            <p class="label">How you got here</p>
            <ol class="moves" id="moves"></ol>
          </div>
        </aside>
      </section>`;
    const $ = id => this.container.querySelector('#' + id);
    this.el = { board: $('board'), eyebrow: $('eyebrow'), title: $('title'), status: $('status'), note: $('note'), progress: $('progress'), moves: $('moves'), after: $('after'), analyse: $('btn-analyse') };
    $('btn-hint').onclick = () => this.hint();
    $('btn-show').onclick = () => this.showSolution();
    $('btn-next').onclick = () => this.start(choose(this.puzzles, this.puzzle && this.puzzle.id));
    this.el.analyse.onclick = e => {
      e.preventDefault();
      openInAnalysis(this.puzzle.moves.split(' ').concat(this.playedSolution || []), this.puzzle.side);
    };
  }

  destroy() {
    this.alive = false;
    if (this.board) this.board.destroy();
  }

  async start(puzzle) {
    this.puzzle = puzzle;
    this.step = 0;
    this.failed = false;
    this.done = false;
    this.playedSolution = [];
    this.el.note.hidden = true;
    this.el.after.hidden = true;
    const moves = puzzle.moves.split(' ');
    this.el.title.textContent = puzzle.line;
    this.el.eyebrow.textContent = `Punish their mistakes · you play ${puzzle.side === 'white' ? 'White' : 'Black'}`;
    const p = trapProgress(this.puzzles);
    this.el.progress.textContent = `${p.solved} of ${p.total} puzzles in this opening solved first time.`;
    this.renderMoves(moves, moves.length - 1);
    // Set up the position before their mistake, then let them play it.
    const before = new Chess();
    moves.slice(0, -1).forEach(m => before.move(m));
    if (this.board) this.board.destroy();
    this.board = new TrainingBoard(this.el.board, puzzle.side, m => this.onUserMove(m), before.fen());
    this.board.setLocked(true);
    this.setStatus('Watch their move…');
    await sleep(700);
    if (!this.alive || this.puzzle !== puzzle) return;
    this.board.play(puzzle.mistake);
    this.renderMoves(moves, moves.length);
    this.board.setLocked(false);
    this.setStatus(`They played ${puzzle.mistake}, leaving your line. Find the move that punishes it.`);
  }

  onUserMove(move) {
    if (this.done) return;
    const step = this.puzzle.steps[this.step];
    if (!step.accept.includes(move.san)) {
      this.failed = true;
      this.board.reject(move.from, move.to);
      this.setStatus(`${move.san} lets them off the hook. Look again: checks, captures, threats.`, 'bad');
      return;
    }
    this.board.play(move);
    this.playedSolution.push(move.san);
    this.board.clearArrows();
    this.advance(step);
  }

  async advance(step) {
    this.step += 1;
    if (this.step >= this.puzzle.steps.length) return this.solved();
    this.setStatus('Good. Keep going…', 'good');
    this.board.setLocked(true);
    await sleep(500);
    if (!this.alive) return;
    // Their best defence (the main line's reply).
    this.board.play(step.reply);
    this.playedSolution.push(step.reply);
    this.board.setLocked(false);
    this.setStatus(`They reply ${step.reply}. What now?`);
  }

  solved() {
    this.done = true;
    this.board.setLocked(true);
    saveStat(this.puzzle.id, !this.failed);
    markActive();
    const line = this.puzzle.steps.map(s => s.play + (s.reply ? ' ' + s.reply : '')).join(' ');
    const ev = this.puzzle.steps[this.puzzle.steps.length - 1].eval;
    const evalText = Math.abs(ev) >= 9000 ? 'a forced mate' : `about ${(ev / 100).toFixed(1)} pawns`;
    this.setStatus(this.failed ? 'Solved, with a slip on the way. It will come up again.' : 'Solved first time!', this.failed ? 'neutral' : 'good');
    this.showNote(`${this.puzzle.theme}. Their ${this.puzzle.mistake} looked natural, but after ${line} you are ${evalText} up. Remember the pattern: when an opponent leaves your line, check whether the new move left something loose.`);
    this.el.after.hidden = false;
  }

  hint() {
    if (this.done) return;
    this.failed = true;
    const step = this.puzzle.steps[this.step];
    const m = this.board.preview(step.play);
    const piece = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[m.piece];
    this.board.showShapes([{ orig: m.from, brush: 'yellow' }]);
    this.setStatus(`Hint: it's a ${piece} move${m.san.includes('+') ? ', with check' : m.captured ? ', a capture' : ''}.`);
  }

  async showSolution() {
    if (this.done) return;
    this.failed = true;
    const step = this.puzzle.steps[this.step];
    const m = this.board.preview(step.play);
    this.board.showArrow(m.from, m.to, 'green');
    this.setStatus(`The move is ${step.play}. Play it on the board.`);
  }

  renderMoves(moves, upto) {
    let html = '';
    for (let i = 0; i < upto; i += 2) {
      const mark = j => (j === moves.length - 1 && upto === moves.length ? ' class="blunder"' : '');
      html += `<li><span class="num">${i / 2 + 1}.</span><span${mark(i)}>${moves[i]}${mark(i) ? '?' : ''}</span><span${mark(i + 1)}>${i + 1 < upto ? moves[i + 1] + (mark(i + 1) ? '?' : '') : ''}</span></li>`;
    }
    this.el.moves.innerHTML = html;
  }

  setStatus(text, tone = 'neutral') {
    this.el.status.textContent = text;
    this.el.status.dataset.tone = tone;
  }

  showNote(text) {
    this.el.note.innerHTML = `<p>${escapeHtml(text)}</p>`;
    this.el.note.hidden = false;
  }
}
