// Turning solved King + Pawn vs King positions into training material:
// reading a position off the board, scoring it, choosing the opponent's reply,
// and dealing out fresh random positions for each drill.
import { solve, probe, isLegal, movesFrom, promotionResult, WIN, DRAW } from './kpk.js';

export { WIN, DRAW };

export const file = s => s & 7;
export const rank = s => s >> 3;
export const chebyshev = (a, b) => Math.max(Math.abs(file(a) - file(b)), Math.abs(rank(a) - rank(b)));
export const squareName = s => 'abcdefgh'[file(s)] + (rank(s) + 1);
export const frontSquare = p => p + 8;
export const promoSquare = p => 56 + file(p);
export const isRookPawn = p => file(p) === 0 || file(p) === 7;

// Both kings hold the opposition when the gaps between them are odd, which is
// the same as both coordinate differences being even. The player who does NOT
// have to move is the one holding it.
export function inOpposition(a, b) {
  return Math.abs(file(a) - file(b)) % 2 === 0 && Math.abs(rank(a) - rank(b)) % 2 === 0;
}

export function toFen(wk, bk, p, stm) {
  const board = Array(64).fill('');
  board[wk] = 'K';
  board[bk] = 'k';
  if (p >= 0) board[p] = 'P';
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '', gap = 0;
    for (let f = 0; f < 8; f++) {
      const c = board[r * 8 + f];
      if (c) { if (gap) { row += gap; gap = 0; } row += c; } else gap++;
    }
    if (gap) row += gap;
    rows.push(row);
  }
  return `${rows.join('/')} ${stm === 0 ? 'w' : 'b'} - - 0 1`;
}

// Read a position straight off a chess.js board.
export function readBoard(game) {
  const state = { wk: -1, bk: -1, p: -1, q: -1, stm: game.turn() === 'w' ? 0 : 1 };
  for (const row of game.board()) {
    for (const sq of row) {
      if (!sq) continue;
      const s = 'abcdefgh'.indexOf(sq.square[0]) + (Number(sq.square[1]) - 1) * 8;
      if (sq.type === 'k') state[sq.color === 'w' ? 'wk' : 'bk'] = s;
      else if (sq.type === 'p') state.p = s;
      else if (sq.type === 'q') state.q = s;
    }
  }
  return state;
}

// Who wins from here, always from White's point of view.
export function scoreState(st) {
  if (st.q >= 0) return { result: promotionResult(st.wk, st.bk, st.q), depth: 0 };
  if (st.p < 0) return { result: DRAW, depth: Infinity };       // bare kings
  return probe(st.wk, st.bk, st.p, st.stm);
}

// Every legal move from here, each scored. `game` is a chess.js instance.
export function scoredMoves(game, Chess) {
  return game.moves({ verbose: true }).map(m => {
    const copy = new Chess(game.fen());
    copy.move(m);
    const st = readBoard(copy);
    const { result, depth } = scoreState(st);
    return { move: m, state: st, result, depth, fen: copy.fen() };
  });
}

// What the side to move can achieve with best play.
function bestResultFor(moves, color) {
  if (color === 'w') return moves.some(m => m.result === WIN) ? WIN : DRAW;
  return moves.some(m => m.result === DRAW) ? DRAW : WIN;
}

// The opponent's reply: never spoils its own result, resists as long as it can,
// and among equal moves prefers the one that gives the learner most chances to
// go wrong — so the same position does not play out the same way twice.
export function chooseReply(game, Chess) {
  const color = game.turn();
  const moves = scoredMoves(game, Chess);
  if (!moves.length) return null;

  const best = bestResultFor(moves, color);
  let pool = moves.filter(m => m.result === best);

  if (color === 'b' && best === WIN) {
    // Black is lost, so drag it out as long as possible.
    const longest = Math.max(...pool.map(m => m.depth));
    pool = pool.filter(m => m.depth === longest);
  } else if (color === 'w' && best === WIN) {
    const quickest = Math.min(...pool.map(m => m.depth));
    pool = pool.filter(m => m.depth === quickest);
  }

  // Count how many replies would throw the learner's result away.
  const traps = pool.map(m => {
    const copy = new Chess(m.fen);
    const replies = scoredMoves(copy, Chess);
    const want = copy.turn() === 'w' ? WIN : DRAW;
    const good = copy.turn() === 'w'
      ? replies.filter(r => r.result === WIN)
      : replies.filter(r => r.result === DRAW);
    return { entry: m, traps: good.length ? replies.length - good.length : 0 };
  });
  const most = Math.max(...traps.map(t => t.traps));
  const sharpest = traps.filter(t => t.traps === most).map(t => t.entry);
  return sharpest[Math.floor(Math.random() * sharpest.length)].move;
}

// --- Random positions -----------------------------------------------------
const rand = n => Math.floor(Math.random() * n);

// Results of every move from a position, using the solver's own move list.
export function successorResults(wk, bk, p, stm) {
  return movesFrom(wk, bk, p, stm).map(m =>
    m.terminal !== undefined ? m.terminal : probe(m.wk, m.bk, m.p, 1 - stm).result);
}

// A position is only worth training on if at least one plausible move throws
// the result away. Otherwise the learner cannot go wrong and learns nothing.
function hasTrap(wk, bk, p, stm) {
  const want = stm === 0 ? WIN : DRAW;
  const results = successorResults(wk, bk, p, stm);
  return results.some(r => r !== want) && results.some(r => r === want);
}

const DRILLS = {
  // Catch the runaway pawn. The white king is parked far away, so it is a pure
  // race between the black king and the pawn.
  square: {
    userColor: 'b',
    want: DRAW,
    pick() {
      const p = 8 + rand(48);
      return { wk: rand(64), bk: rand(64), p, stm: 1 };
    },
    accept({ wk, bk, p }) {
      // The king must not already be sitting in the pawn's path, or the drill
      // would be over before a move is played.
      if (file(bk) === file(p) && rank(bk) > rank(p)) return false;
      return rank(p) >= 2 && rank(p) <= 5
        && chebyshev(wk, p) >= 4 && chebyshev(wk, promoSquare(p)) >= 4
        && chebyshev(bk, promoSquare(p)) >= 2;
    },
  },
  // Escort the pawn home.
  promote: {
    userColor: 'w',
    want: WIN,
    pick() {
      const p = 8 + rand(40);                       // ranks 2-6
      return { wk: rand(64), bk: rand(64), p, stm: 0 };
    },
    accept({ wk, bk, p }) {
      return !isRookPawn(p) && rank(p) <= 4
        && chebyshev(wk, p) <= 3 && chebyshev(bk, promoSquare(p)) <= 4;
    },
  },
  // Hold the draw a pawn down.
  hold: {
    userColor: 'b',
    want: DRAW,
    pick() {
      const p = 8 + rand(40);
      return { wk: rand(64), bk: rand(64), p, stm: 1 };
    },
    accept({ wk, bk, p }) {
      return !isRookPawn(p) && rank(p) >= 2
        && chebyshev(wk, p) <= 2 && chebyshev(bk, promoSquare(p)) <= 3;
    },
  },
  // The rook pawn that can never be escorted home.
  rookpawn: {
    userColor: 'b',
    want: DRAW,
    pick() {
      const f = Math.random() < 0.5 ? 0 : 7;
      const p = (1 + rand(5)) * 8 + f;              // ranks 2-6 on the a- or h-file
      return { wk: rand(64), bk: rand(64), p, stm: 1 };
    },
    accept({ wk, bk, p }) {
      return chebyshev(wk, p) <= 2 && chebyshev(bk, promoSquare(p)) <= 4;
    },
  },
};

export function drillIds() {
  return Object.keys(DRILLS);
}

// The mixed drill deals one of the four without saying which.
const RANDOM_POOL = Object.keys(DRILLS);

export function drillSpec(id) {
  return DRILLS[id];
}

export function generate(drillId) {
  solve();
  if (drillId === 'random') {
    const pick = RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)];
    return { ...generate(pick), sourceDrill: pick };
  }
  const spec = DRILLS[drillId];
  let fallback = null;
  for (let tries = 0; tries < 60000; tries++) {
    const cand = spec.pick();
    const { wk, bk, p, stm } = cand;
    if (!isLegal(wk, bk, p, stm)) continue;
    if (!spec.accept(cand)) continue;
    if (probe(wk, bk, p, stm).result !== spec.want) continue;
    if (!fallback) fallback = cand;
    if (!hasTrap(wk, bk, p, stm)) continue;
    return { ...cand, userColor: spec.userColor, sourceDrill: drillId, fen: toFen(wk, bk, p, stm) };
  }
  const c = fallback || { wk: 4, bk: 36, p: 28, stm: spec.userColor === 'w' ? 0 : 1 };
  return { ...c, userColor: spec.userColor, sourceDrill: drillId, fen: toFen(c.wk, c.bk, c.p, c.stm) };
}
