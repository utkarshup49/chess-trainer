// Play a full game against the bot, starting with one of your openings.
//
// While the game is still in your repertoire, the bot answers with moves from
// the opening's lines (picked at random, so you meet every branch) and the
// coach explains its replies. If you leave your repertoire, the coach shows
// the move you prepared and lets you take yours back. When the lines run out,
// the coach shows the plan for the position and the engine takes over at the
// rating you picked.
//
// Two bot styles:
//   book      plays your lines for as long as they go.
//   surprise  follows your lines for a few moves, then (at a random moment, or
//             never) leaves them with a move of its own: sometimes a sound
//             sideline, sometimes a mistake or a blunder you should punish.
import { TrainingBoard } from './board.js';
import { getEngine } from './engine.js';
import { levelFor, chooseMove } from './bot.js';
import { saveGame } from './games.js';

const MIN_THINK_MS = 450;   // so the bot doesn't reply instantly
const BOOK_REPLY_MS = 600;

const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// When the surprise bot leaves the book: its 4th to 9th move, or never.
const LEAVE_AT = [4, 5, 6, 7, 8, 9, Infinity];
// What kind of move it leaves with, how often, and how much it may lose
// (centipawns compared with the best move).
const SURPRISES = [
  { kind: 'sound', weight: 0.4, min: 0, max: 60 },
  { kind: 'mistake', weight: 0.35, min: 80, max: 250 },
  { kind: 'blunder', weight: 0.25, min: 251, max: 900 },
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = list => list[Math.floor(Math.random() * list.length)];
const startsWith = (list, played) => played.length <= list.length && played.every((m, i) => list[i] === m);

export class BotGame {
  constructor(container, module, { side, rating, mode }) {
    this.container = container;
    this.module = module;
    this.side = side;
    this.mode = mode === 'surprise' ? 'surprise' : 'book';
    this.leaveAt = this.mode === 'surprise' ? pick(LEAVE_AT) : Infinity;
    this.surprise = null;    // { ply, san, kind, loss, evalAfter, reply }
    this.level = levelFor(rating);
    this.book = module.lines.filter(l => l.side === side).map(l => ({ ...l, list: l.moves.split(' ') }));
    this.inBook = true;
    this.bookPly = 0;        // plies played inside the repertoire
    this.lastLine = null;    // the line we were following when the book ended
    this.bookEval = null;    // engine score (your side) when the book ended
    this.deviated = false;
    this.over = false;
    this.alive = true;       // false once the page is left
    this.engine = null;

    this.renderShell();
    this.board = new TrainingBoard(this.el.board, side, m => this.onUserMove(m));
    this.loadEngine();
    const surpriseNote = this.mode === 'surprise'
      ? ' Careful: this bot may leave your lines at any moment, with a good move or a bad one.' : '';
    this.setCoach('Your repertoire', (side === 'white'
      ? 'You have White. Play your first move: the bot will answer from your repertoire.'
      : 'You have Black. The bot opens with one of the moves your repertoire covers.') + surpriseNote);
    this.renderMoves();
    if (this.board.sideToMove() !== side) this.botMove();
  }

  renderShell() {
    const sideName = this.side === 'white' ? 'White' : 'Black';
    this.container.innerHTML = `
      <section class="train">
        <div class="board-col"><div class="board-wrap" id="board"></div></div>
        <aside class="panel">
          <a class="crumb" href="#/play">← Play the bot</a>
          <p class="eyebrow">You play ${sideName} · ${this.mode === 'surprise' ? 'surprise' : 'book'} bot rated about ${this.level.rating}</p>
          <h1 class="line-title">${escapeHtml(this.module.title)}</h1>
          <div class="status" id="status" data-tone="neutral"></div>
          <div class="teach" id="coach"></div>
          <div class="actions" id="choice" hidden></div>
          <div class="actions">
            <button type="button" id="btn-hint">Hint</button>
            <button type="button" id="btn-takeback">Take back</button>
            <button type="button" id="btn-resign">Resign</button>
            <a class="button" href="#/play/${this.module.id}/${this.side}/${this.level.rating}/${this.mode}?new=${Date.now()}" id="btn-new">New game</a>
          </div>
          <div class="finish" id="finish" hidden></div>
          <div class="moves-box">
            <p class="label">Moves</p>
            <ol class="moves" id="moves"></ol>
          </div>
        </aside>
      </section>`;
    const $ = id => this.container.querySelector('#' + id);
    this.el = { board: $('board'), status: $('status'), coach: $('coach'), choice: $('choice'), moves: $('moves'), finish: $('finish') };
    $('btn-takeback').onclick = () => this.takeBack();
    $('btn-hint').onclick = () => this.hint();
    $('btn-resign').onclick = () => this.finish('resign');
  }

  destroy() {
    this.alive = false;
    if (this.board) this.board.destroy();
  }

  async loadEngine() {
    this.setStatus('Loading the engine…');
    try {
      this.engine = await getEngine();
      if (!this.alive) return;
      this.setStatus(this.turnText());
      if (this.waitingForEngine) { this.waitingForEngine = false; this.botMove(); }
    } catch (e) {
      this.engineError = e.message;
      this.setStatus(e.message, 'bad');
    }
  }

  // ---------- Your moves ----------
  onUserMove(move) {
    if (this.over || this.board.sideToMove() !== this.side) return;
    const before = this.board.sanHistory();
    if (this.inBook) {
      const expected = this.nextBookMoves(before);
      if (expected.length && !expected.includes(move.san)) {
        this.board.play(move);
        this.renderMoves();
        return this.offerBookMove(move.san, expected, before);
      }
    }
    this.board.play(move);
    this.afterMove();
  }

  // You played something your repertoire doesn't. Show what it plays and why.
  offerBookMove(played, expected, before) {
    const prefix = before.join(' ');
    const notes = this.module.explain || {};
    const san = expected[0];
    const why = notes[`${prefix}|${san}`] || notes[`${prefix}|*`] || '';
    this.board.setLocked(true);
    this.setCoach(`Your repertoire plays ${expected.join(' or ')} here`,
      `You played ${played}. ${why}`);
    const last = this.board.game.history({ verbose: true }).pop();
    this.board.showShapes([{ orig: last.from, dest: last.to, brush: 'red' }]);
    this.el.choice.innerHTML = `
      <button type="button" class="primary" id="btn-redo">Take it back, play ${escapeHtml(san)}</button>
      <button type="button" id="btn-keep">Keep my move</button>`;
    this.el.choice.hidden = false;
    this.setStatus('Take it back, or keep your move and carry on.');
    this.el.choice.querySelector('#btn-redo').onclick = () => {
      this.el.choice.hidden = true;
      this.board.undo();
      this.board.setLocked(false);
      this.board.showArrow(...this.squaresOf(san), 'green');
      this.renderMoves();
      this.setStatus(this.turnText());
      this.setCoach(`Play ${san}`, why);
    };
    this.el.choice.querySelector('#btn-keep').onclick = () => {
      this.el.choice.hidden = true;
      this.board.setLocked(false);
      this.deviated = true;
      this.leaveBook(before.length, `You left your repertoire with ${played}. From here the bot plays at full ${this.level.rating} strength.`);
      this.afterMove();
    };
  }

  // While in the book, show your prepared move; after it, say so.
  hint() {
    if (this.over || this.board.sideToMove() !== this.side) return;
    const played = this.board.sanHistory();
    const next = this.inBook ? this.nextBookMoves(played) : [];
    if (!next.length) {
      this.setCoach('No hint here', 'You are past your prepared moves, so this one is yours to find. Think about the plan for the position.');
      return;
    }
    const why = (this.module.explain || {})[`${played.join(' ')}|${next[0]}`] || '';
    this.board.showArrow(...this.squaresOf(next[0]), 'green');
    this.setCoach(`Your repertoire plays ${next[0]}`, why);
  }

  squaresOf(san) {
    const m = this.board.preview(san);
    return [m.from, m.to];
  }

  // ---------- The bot's moves ----------
  async botMove() {
    if (this.over || !this.alive) return;
    const played = this.board.sanHistory();
    if (this.inBook) {
      const options = this.nextBookMoves(played);
      if (options.length && this.botMovesSoFar() + 1 >= this.leaveAt && this.engine) {
        return this.surpriseMove(options);
      }
      if (options.length) {
        await sleep(BOOK_REPLY_MS);
        if (!this.alive || this.board.sanHistory().length !== played.length) return;
        const san = pick(options);
        const why = (this.module.replies || {})[`${played.join(' ')}|${san}`];
        this.board.play(san);
        this.setCoach(`The bot plays ${san}`, why || 'A move your repertoire is ready for.');
        return this.afterMove();
      }
    }
    if (!this.engine) {
      if (this.engineError) return this.setStatus(this.engineError, 'bad');
      this.waitingForEngine = true;
      return this.setStatus('Waiting for the engine to load…');
    }
    this.setStatus('The bot is thinking…');
    const fen = this.board.game.fen();
    const started = Date.now();
    const lines = await this.engine.analyse(fen, { depth: this.level.depth, multipv: this.level.lines });
    const wait = MIN_THINK_MS - (Date.now() - started);
    if (wait > 0) await sleep(wait);
    if (!this.alive || this.board.game.fen() !== fen) return; // taken back meanwhile
    const legal = this.board.game.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
    const uci = chooseMove(lines, legal, this.level);
    this.board.play({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    this.afterMove();
  }

  botMovesSoFar() {
    const botIsWhite = this.side === 'black';
    const plies = this.board.sanHistory().length;
    return botIsWhite ? Math.ceil(plies / 2) : Math.floor(plies / 2);
  }

  // The surprise bot leaves your lines: a sound sideline, a mistake or a
  // blunder, chosen from the engine's scores of (nearly) every legal move.
  async surpriseMove(bookSans) {
    const fen = this.board.game.fen();
    const played = this.board.sanHistory();
    const legal = this.board.game.moves({ verbose: true });
    const bookUci = new Set(bookSans.map(san => {
      const m = this.board.preview(san);
      return m.from + m.to + (m.promotion || '');
    }));
    this.setStatus('The bot is thinking…');
    const started = Date.now();
    const lines = await this.engine.analyse(fen, { depth: 9, multipv: Math.min(legal.length, 40) });
    const wait = MIN_THINK_MS - (Date.now() - started);
    if (wait > 0) await sleep(wait);
    if (!this.alive || this.board.game.fen() !== fen) return;

    const best = lines.length ? lines[0].score : 0;
    const offBook = lines.filter(l => !bookUci.has(l.move)).map(l => ({ ...l, loss: best - l.score }));
    const buckets = SURPRISES
      .map(t => ({ ...t, moves: offBook.filter(l => l.loss >= t.min && l.loss <= t.max) }))
      .filter(t => t.moves.length);
    if (!buckets.length) { this.leaveAt = Infinity; return this.botMove(); } // nothing sensible: stay in book
    let r = Math.random() * buckets.reduce((a, t) => a + t.weight, 0);
    const type = buckets.find(t => (r -= t.weight) <= 0) || buckets[0];
    const choice = pick(type.moves);
    const move = this.board.play({ from: choice.move.slice(0, 2), to: choice.move.slice(2, 4), promotion: choice.move[4] });
    this.surprise = { ply: played.length, san: move.san, kind: type.kind, loss: choice.loss };
    this.inBook = false;
    this.bookPly = played.length;
    this.board.setLocked(true); // wait for the engine's verdict before you reply
    await this.leaveBook(played.length, `Surprise! The bot played ${move.san}, which is not in your lines. ` +
      'Before you reply, ask: what does this move attack, what did it leave undefended, and does it change your plan? ' +
      'It might be a good move or a bad one.', true);
    this.surprise.evalAfter = this.bookEval;
    if (!this.alive) return;
    this.board.setLocked(false);
    this.afterMove();
  }

  // After your answer to a surprise, say whether you made the most of it.
  async judgeSurprise(fen, replySan) {
    const s = this.surprise;
    const { score } = await this.engine.evaluate(fen, 12);
    const now = this.side === 'white' ? score : -score;
    const pawns = cp => (cp > 0 ? '+' : '') + (cp / 100).toFixed(1);
    const before = s.evalAfter;
    s.reply = { san: replySan, eval: now };
    if (typeof before !== 'number') return;
    const kept = now >= before - 60;
    s.punished = s.kind !== 'sound' && kept;
    if (!this.alive) return;
    let text;
    if (s.kind === 'sound') {
      text = `The bot's ${s.san} was a reasonable move, not a mistake. ` + (kept
        ? `Your ${replySan} kept things in order (${pawns(now)} for you).`
        : `Your ${replySan} gave a little away (${pawns(before)} became ${pawns(now)}). The review shows a better answer.`);
    } else {
      const what = s.kind === 'blunder' ? 'a blunder' : 'a mistake';
      text = kept
        ? `The bot's ${s.san} was ${what}, and ${replySan} punished it: you are ${pawns(now)}.`
        : `The bot's ${s.san} was ${what}, and there was a stronger answer than ${replySan}: you could have been ${pawns(before)}, now it's ${pawns(now)}. The review shows the punishing move.`;
    }
    this.setCoach('How you handled the surprise', text);
  }

  // ---------- Bookkeeping after every move ----------
  afterMove() {
    this.board.clearArrows(); // a hint arrow is only for the move it was shown for
    this.renderMoves();
    const played = this.board.sanHistory();
    if (this.inBook) {
      const still = this.book.filter(l => startsWith(l.list, played));
      if (still.length) {
        this.lastLine = still[0];
        this.bookPly = played.length;
        if (still.every(l => l.list.length === played.length)) {
          this.leaveBook(played.length, `That's the end of your prepared line, "${this.lastLine.name}". The plan from here: ${this.lastLine.idea}`);
        }
      } else {
        this.leaveBook(this.bookPly, 'The bot has left your repertoire. You are on your own now: use the ideas you learned.');
      }
    }
    if (this.surprise && !this.surprise.reply && played.length === this.surprise.ply + 2 && this.engine) {
      this.surprise.reply = { san: played[played.length - 1] }; // judged below
      this.judgeSurprise(this.board.game.fen(), played[played.length - 1]);
    }
    if (this.checkGameOver()) return;
    if (this.board.sideToMove() !== this.side) this.botMove();
    else this.setStatus(this.turnText());
  }

  nextBookMoves(played) {
    const next = this.book.filter(l => l.list.length > played.length && startsWith(l.list, played)).map(l => l.list[played.length]);
    return [...new Set(next)];
  }

  async leaveBook(plies, message, surprised = false) {
    this.inBook = false;
    this.bookPly = plies;
    this.board.clearArrows();
    this.setCoach(surprised ? 'Surprise!' : 'Out of the book', message);
    // Note how good the position was when the preparation ran out.
    const fen = this.board.game.fen();
    const engine = this.engine || await getEngine().catch(() => null);
    if (!engine) return;
    const { score } = await engine.evaluate(fen, 12);
    this.bookEval = this.side === 'white' ? score : -score;
  }

  takeBack() {
    if (this.over) return;
    this.el.choice.hidden = true;
    this.board.setLocked(false);
    const history = this.board.sanHistory();
    if (!history.length) return;
    // Undo back to your move: one ply if it's the bot's turn, two if it's yours.
    this.board.undo();
    if (this.board.sideToMove() !== this.side && this.board.sanHistory().length) this.board.undo();
    this.takebacks = (this.takebacks || 0) + 1;
    const now = this.board.sanHistory();
    if (!this.inBook && !this.deviated && now.length < this.bookPly) this.inBook = true;
    this.board.clearArrows();
    this.renderMoves();
    if (this.board.sideToMove() !== this.side) this.botMove();
    else this.setStatus(this.turnText());
  }

  checkGameOver() {
    const g = this.board.game;
    if (!g.isGameOver()) return false;
    if (g.isCheckmate()) this.finish('mate');
    else this.finish('draw');
    return true;
  }

  finish(reason) {
    if (this.over) return;
    this.over = true;
    this.board.setLocked(true);
    const g = this.board.game;
    let outcome;
    if (reason === 'resign') outcome = 'loss';
    else if (reason === 'mate') outcome = g.turn() === (this.side === 'white' ? 'w' : 'b') ? 'loss' : 'win';
    else outcome = 'draw';
    const why = reason === 'resign' ? 'You resigned.'
      : reason === 'mate' ? (outcome === 'win' ? 'Checkmate. You win!' : 'Checkmate. The bot wins.')
      : g.isStalemate() ? 'Stalemate: a draw.'
      : g.isThreefoldRepetition() ? 'Draw by repetition.'
      : g.isInsufficientMaterial() ? 'Draw: neither side can mate.'
      : 'Draw by the fifty-move rule.';
    if (g.history().length < 2) {
      this.setStatus(why);
      return;
    }
    const record = saveGame({
      module: this.module.id,
      moduleTitle: this.module.title,
      side: this.side,
      rating: this.level.rating,
      mode: this.mode,
      surprise: this.surprise,
      moves: g.history(),
      outcome,
      reason: why,
      bookPly: this.bookPly,
      lineName: this.lastLine ? this.lastLine.name : null,
      bookEval: this.bookEval,
      deviated: this.deviated,
      takebacks: this.takebacks || 0,
      date: new Date().toISOString(),
    });
    this.setStatus(why, outcome === 'win' ? 'good' : outcome === 'loss' ? 'bad' : 'neutral');
    this.el.finish.innerHTML = `
      <div class="actions">
        <a class="button primary" href="#/review/${record.id}">Review this game</a>
        <a class="button" href="#/play/${this.module.id}/${this.side}/${this.level.rating}/${this.mode}?new=${Date.now()}">Play again</a>
      </div>`;
    this.el.finish.hidden = false;
  }

  // ---------- Display ----------
  turnText() {
    return this.board.game.inCheck() ? 'Your move. You are in check.' : 'Your move.';
  }

  setStatus(text, tone = 'neutral') {
    this.el.status.textContent = text;
    this.el.status.dataset.tone = tone;
  }

  setCoach(title, text) {
    this.el.coach.innerHTML = `<p class="note-title">${escapeHtml(title)}</p><p>${escapeHtml(text)}</p>`;
  }

  renderMoves() {
    const h = this.board.sanHistory();
    if (!h.length) { this.el.moves.innerHTML = '<li><span class="empty">No moves yet.</span></li>'; return; }
    let html = '';
    for (let i = 0; i < h.length; i += 2) {
      const cls = j => (j < this.bookPly || (this.inBook && j < h.length) ? ' class="book"' : '');
      html += `<li><span class="num">${i / 2 + 1}.</span><span${cls(i)}>${h[i]}</span><span${cls(i + 1)}>${h[i + 1] || ''}</span></li>`;
    }
    this.el.moves.innerHTML = html;
    this.el.moves.scrollTop = this.el.moves.scrollHeight;
  }
}
