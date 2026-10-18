// The pawn-race drill: a pawn each, kings in the way.
//
// These are four-piece positions, so the built-in solver cannot reach them and
// they are judged by the Lichess tablebase instead. Candidates are filtered
// locally first, so dealing a position costs only a handful of lookups.
import { scoreFen, WHITE_WINS, PositionRejected } from './oracle.js';

const file = s => s & 7;
const rank = s => s >> 3;
const chebyshev = (a, b) => Math.max(Math.abs(file(a) - file(b)), Math.abs(rank(a) - rank(b)));
const rand = n => Math.floor(Math.random() * n);

function touching(a, b) {
  return a === b || chebyshev(a, b) <= 1;
}

export function toFen(wk, bk, wp, bp, stm) {
  const board = Array(64).fill('');
  board[wk] = 'K'; board[bk] = 'k'; board[wp] = 'P'; board[bp] = 'p';
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

// Moves to promotion, allowing for the double step from the starting rank.
export const whiteSteps = p => (7 - rank(p)) - (rank(p) === 1 ? 1 : 0);
export const blackSteps = p => rank(p) - (rank(p) === 6 ? 1 : 0);

function legal(wk, bk, wp, bp, stm) {
  const squares = new Set([wk, bk, wp, bp]);
  if (squares.size !== 4) return false;
  if (rank(wp) < 1 || rank(wp) > 6) return false;
  if (rank(bp) < 1 || rank(bp) > 6) return false;
  if (touching(wk, bk)) return false;
  // The side that just moved must not have left its king attacked by a pawn.
  if (stm === 0) {
    if (rank(bk) === rank(wp) + 1 && Math.abs(file(bk) - file(wp)) === 1) return false;
  } else if (rank(wk) === rank(bp) - 1 && Math.abs(file(wk) - file(bp)) === 1) {
    return false;
  }
  return true;
}

// A cheap filter so most candidates sent to the tablebase are worth asking about.
function plausible(wk, bk, wp, bp) {
  if (Math.abs(file(wp) - file(bp)) < 2) return false;      // keep the pawns out of each other's way
  const ws = whiteSteps(wp), bs = blackSteps(bp);
  if (ws > bs + 1) return false;                            // White must be in the race
  if (chebyshev(wk, wp) > 4 && chebyshev(wk, bp) > 4) return false;
  if (chebyshev(bk, bp) > 4 && chebyshev(bk, wp) > 4) return false;
  return true;
}

function candidate() {
  const wp = (1 + rand(4)) * 8 + rand(8);          // ranks 2-5
  const bp = (2 + rand(4)) * 8 + rand(8);          // ranks 3-6
  return { wk: rand(64), bk: rand(64), wp, bp, stm: 0 };
}

// Deals a position White wins, where at least one move throws it away.
// `budget` caps how many tablebase lookups one deal may cost.
export async function generateRace({ budget = 25 } = {}) {
  let rejected = 0;
  for (let asked = 0; asked < budget;) {
    const c = candidate();
    if (!legal(c.wk, c.bk, c.wp, c.bp, c.stm)) continue;
    if (!plausible(c.wk, c.bk, c.wp, c.bp)) continue;

    const fen = toFen(c.wk, c.bk, c.wp, c.bp, c.stm);
    let answer;
    try {
      answer = await scoreFen(fen);
      asked++;
    } catch (e) {
      if (e instanceof PositionRejected) { rejected++; continue; }
      throw e;                                      // offline: let the caller say so
    }
    if (answer.wdl !== WHITE_WINS) continue;
    const moves = answer.moves || [];
    const winning = moves.filter(m => m.wdl === WHITE_WINS);
    const throwing = moves.filter(m => m.wdl !== WHITE_WINS);
    if (!winning.length || !throwing.length) continue;

    return { ...c, fen, userColor: 'w', sourceDrill: 'race', lookups: asked, rejected };
  }
  return null;                                      // caller retries or reports
}
