// A chess board that only lets the trainer decide which moves count.
// chessground draws the board, chess.js knows the rules.
import { Chessground } from 'https://cdn.jsdelivr.net/npm/chessground@9.2.1/+esm';
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.0.0/+esm';

export { Chess };

const PROMO_PIECES = [
  { letter: 'q', name: 'Queen', white: '♕', black: '♛' },
  { letter: 'r', name: 'Rook', white: '♖', black: '♜' },
  { letter: 'b', name: 'Bishop', white: '♗', black: '♝' },
  { letter: 'n', name: 'Knight', white: '♘', black: '♞' },
];

export class TrainingBoard {
  // wrapper: element that holds the board. onUserMove(move) gets {from, to, promotion, san}.
  constructor(wrapper, orientation, onUserMove, startFen) {
    this.wrapper = wrapper;
    this.onUserMove = onUserMove;
    this.userColor = orientation;
    this.startFen = startFen || undefined;
    this.game = startFen ? new Chess(startFen) : new Chess();
    this.locked = false;

    wrapper.innerHTML = '';
    const boardEl = document.createElement('div');
    boardEl.className = 'board-surface';
    wrapper.appendChild(boardEl);

    this.cg = Chessground(boardEl, {
      orientation: orientation,
      coordinates: true,
      animation: { enabled: true, duration: 220 },
      highlight: { lastMove: true, check: true },
      premovable: { enabled: false },
      draggable: { enabled: true, showGhost: true },
      movable: {
        free: false,
        showDests: true,
        events: { after: (orig, dest) => this.handleBoardMove(orig, dest) },
      },
    });
    this.sync();
  }

  // Redraw the board from the chess.js position.
  sync() {
    const turn = this.game.turn() === 'w' ? 'white' : 'black';
    const userCanMove = !this.locked && turn === this.userColor && !this.game.isGameOver();
    const history = this.game.history({ verbose: true });
    const last = history[history.length - 1];

    this.cg.set({
      fen: this.game.fen(),
      turnColor: turn,
      check: this.game.inCheck(),
      lastMove: last ? [last.from, last.to] : undefined,
      movable: {
        color: userCanMove ? this.userColor : undefined,
        dests: userCanMove ? this.legalDests() : new Map(),
      },
    });
  }

  legalDests() {
    const dests = new Map();
    for (const m of this.game.moves({ verbose: true })) {
      if (!dests.has(m.from)) dests.set(m.from, []);
      dests.get(m.from).push(m.to);
    }
    return dests;
  }

  async handleBoardMove(orig, dest) {
    const options = this.game.moves({ verbose: true }).filter(m => m.from === orig && m.to === dest);
    if (options.length === 0) {
      this.sync();
      return;
    }
    let promotion;
    if (options[0].promotion) {
      promotion = await this.askPromotion(dest);
      if (!promotion) {
        this.sync();
        return;
      }
    }
    const chosen = options.find(m => !m.promotion || m.promotion === promotion);
    this.onUserMove({ from: orig, to: dest, promotion: promotion, san: chosen.san });
  }

  askPromotion(square) {
    const color = this.userColor;
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.className = 'promo';
      box.innerHTML = '<p>Promote to</p>';
      const row = document.createElement('div');
      row.className = 'promo-row';
      for (const p of PROMO_PIECES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'promo-piece';
        btn.title = p.name;
        btn.setAttribute('aria-label', p.name);
        btn.textContent = color === 'white' ? p.white : p.black;
        btn.onclick = () => { box.remove(); resolve(p.letter); };
        row.appendChild(btn);
      }
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'promo-cancel';
      cancel.textContent = 'Cancel';
      cancel.onclick = () => { box.remove(); resolve(null); };
      box.appendChild(row);
      box.appendChild(cancel);
      this.wrapper.appendChild(box);
    });
  }

  // Apply a move (object or SAN) to the position, with animation.
  play(move) {
    const result = this.game.move(move);
    this.cg.move(result.from, result.to);
    this.sync();
    return result;
  }

  // Put the pieces back where chess.js says they are (used after a wrong move).
  reject(from, to) {
    this.cg.setAutoShapes([{ orig: from, dest: to, brush: 'red' }]);
    this.sync();
    setTimeout(() => this.cg.setAutoShapes([]), 900);
  }

  showArrow(from, to) {
    this.cg.setAutoShapes([{ orig: from, dest: to, brush: 'green' }]);
  }

  clearArrows() {
    this.cg.setAutoShapes([]);
  }

  undo() {
    const m = this.game.undo();
    this.sync();
    return m;
  }

  sideToMove() {
    return this.game.turn() === 'w' ? 'white' : 'black';
  }

  sanHistory() {
    return this.game.history();
  }

  setLocked(value) {
    this.locked = value;
    this.sync();
  }

  // Work out the SAN and squares of a SAN move without playing it.
  preview(san) {
    const copy = new Chess(this.game.fen());
    return copy.move(san);
  }

  destroy() {
    this.cg.destroy();
    this.wrapper.innerHTML = '';
  }
}
