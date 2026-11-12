// Position recipes for the tablebase-judged drills.
//
// Every recipe describes a family of positions from the attacker's side, as if
// the attacker were White playing up the board. The dealer then mirrors it
// left-to-right and swaps colours at random, asks the tablebase what the
// position is worth, and keeps it only if it is the right result AND at least
// one natural move throws that result away.
import { scoreFen, PositionRejected } from './oracle.js';

const sq = (f, r) => r * 8 + f;
const file = s => s & 7;
const rank = s => s >> 3;
const cheb = (a, b) => Math.max(Math.abs(file(a) - file(b)), Math.abs(rank(a) - rank(b)));
const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pick = list => list[Math.floor(Math.random() * list.length)];
const anySquare = () => rnd(0, 63);
const onBoard = (f, r) => f >= 0 && f <= 7 && r >= 0 && r <= 7;

function neighbour(s) {
  for (let tries = 0; tries < 20; tries++) {
    const f = file(s) + rnd(-1, 1), r = rank(s) + rnd(-1, 1);
    if (onBoard(f, r) && sq(f, r) !== s) return sq(f, r);
  }
  return s;
}

// A random square within a distance band of another.
function near(s, lo, hi) {
  for (let tries = 0; tries < 60; tries++) {
    const t = anySquare();
    const d = cheb(s, t);
    if (d >= lo && d <= hi) return t;
  }
  return anySquare();
}

const dark = s => (file(s) + rank(s)) % 2 === 0;
function squareOfColour(wantDark) {
  for (;;) { const s = anySquare(); if (dark(s) === wantDark) return s; }
}

// Upper case = attacker, lower case = defender. `user` says which side you play.
export const RECIPES = {
  // ---------------- Rook endgames ----------------
  lucena: {
    user: 'attacker', minDepth: 16,
    make() {
      const f = rnd(1, 5);
      return [['K', sq(f, 7)], ['P', sq(f, 6)], ['R', sq(f + 1, rnd(0, 2))],
              ['k', sq(f + 2, pick([6, 7]))], ['r', sq(f - 1, rnd(0, 3))]];
    },
  },
  philidor: {
    user: 'defender',
    make() {
      const f = rnd(2, 5);
      const far = [0, 1, 2, 3, 4, 5, 6, 7].filter(x => Math.abs(x - f) >= 2);
      return [['P', sq(f, 4)], ['K', sq(f + pick([-1, 1]), 4)], ['R', sq(pick(far), 6)],
              ['k', sq(f, 7)], ['r', sq(pick(far), rnd(0, 5))]];
    },
  },
  rookdefence: {
    user: 'defender', maxKeepFrac: 0.45,
    make() {
      const f = rnd(1, 6), r = pick([4, 5]);
      const kingSpot = pick([[f - 1, r], [f + 1, r], [f - 1, r + 1], [f + 1, r + 1]]);
      return [['P', sq(f, r)], ['K', sq(kingSpot[0], kingSpot[1])], ['R', anySquare()],
              ['k', sq(Math.min(7, Math.max(0, f + rnd(-1, 1))), 7)], ['r', anySquare()]];
    },
  },
  vancura: {
    user: 'defender', maxKeepFrac: 0.5,
    make() {
      const rook = pick([sq(5, rnd(0, 5)), sq(0, rnd(0, 2)), sq(rnd(3, 7), rnd(0, 5))]);
      return [['P', sq(0, 5)], ['R', sq(0, 7)], ['K', sq(rnd(1, 4), rnd(2, 4))],
              ['k', sq(pick([6, 7]), 6)], ['r', rook]];
    },
  },
  rookvpawn: {
    user: 'attacker', minDepth: 14, maxKeepFrac: 0.5,
    make() {
      const p = sq(rnd(0, 7), rnd(2, 4));
      return [['p', p], ['k', neighbour(p)], ['K', near(p, 3, 5)], ['R', anySquare()]];
    },
  },
  extrapawn: {
    user: 'attacker', minDepth: 24, maxKeepFrac: 0.4,
    make() {
      const f = rnd(1, 6), r = rnd(3, 5);
      const p = sq(f, r);
      const cut = [0, 1, 2, 3, 4, 5, 6, 7].filter(x => Math.abs(x - f) >= 2);
      return [['P', p], ['K', neighbour(p)], ['R', anySquare()],
              ['k', sq(pick(cut), rnd(r, 7))], ['r', anySquare()]];
    },
  },

  // ---------------- Queen against a pawn ----------------
  qvpwin: {
    user: 'attacker', minDepth: 14, maxKeepFrac: 0.5,
    make() {
      const p = sq(pick([1, 3, 4, 6]), 1);
      return [['p', p], ['k', neighbour(p)], ['K', near(p, 4, 7)], ['Q', anySquare()]];
    },
  },
  qvpdraw: {
    user: 'defender',
    make() {
      const p = sq(pick([0, 2, 5, 7]), 1);
      return [['p', p], ['k', neighbour(p)], ['K', near(p, 4, 7)], ['Q', anySquare()]];
    },
  },

  // ---------------- Fortresses ----------------
  wrongbishop: {
    user: 'defender',
    make() {
      const p = sq(0, rnd(2, 5));
      return [['P', p], ['B', squareOfColour(true)], ['K', near(p, 1, 2)],
              ['k', near(sq(0, 7), 2, 5)]];
    },
  },
  oppbishops: {
    user: 'defender', maxKeepFrac: 0.6,
    make() {
      const f = rnd(1, 5), r = rnd(3, 5);
      const p1 = sq(f, r), p2 = sq(f + pick([1, 2]), rnd(3, 5));
      return [['P', p1], ['P', p2], ['K', near(p1, 1, 2)], ['B', squareOfColour(false)],
              ['k', sq(f + rnd(0, 1), rnd(r + 1, 7))], ['b', squareOfColour(true)]];
    },
  },
  knightvpawn: {
    user: 'defender', maxKeepFrac: 0.5,
    make() {
      const p = sq(0, rnd(4, 6));
      return [['P', p], ['K', near(p, 1, 2)], ['n', anySquare()], ['k', near(p, 3, 7)]];
    },
  },
  rookvbishop: {
    user: 'defender', maxKeepFrac: 0.5,
    make() {
      const k = sq(rnd(6, 7), rnd(6, 7));
      return [['k', k], ['b', anySquare()], ['K', near(k, 2, 3)], ['R', anySquare()]];
    },
  },

  // ---------------- Pawn endings ----------------
  blockedpawns: {
    user: 'attacker', minDepth: 12, maxKeepFrac: 0.5,
    make() {
      const f = rnd(0, 7), r = rnd(2, 4);
      const p = sq(f, r);
      return [['P', p], ['p', sq(f, r + 1)], ['K', near(p, 1, 3)], ['k', near(sq(f, r + 1), 1, 3)]];
    },
  },
  outsidepawn: {
    user: 'attacker', minDepth: 12, maxKeepFrac: 0.6,
    make() {
      // A blocked pair on one wing, a passed pawn on the other, kings between.
      const g = rnd(5, 7), r = rnd(2, 4), c = rnd(3, 4);
      return [['P', sq(rnd(0, 1), rnd(2, 4))], ['P', sq(g, r)], ['p', sq(g, r + 1)],
              ['K', sq(c, rnd(2, 3))], ['k', sq(c + rnd(-1, 1), rnd(5, 6))]];
    },
  },
  pawndown: {
    user: 'defender', maxKeepFrac: 0.5,
    make() {
      const f = rnd(0, 6), r = rnd(2, 4);
      const p1 = sq(f, r);
      return [['P', p1], ['P', sq(f + 1, rnd(2, 4))], ['p', sq(f + rnd(0, 1), rnd(r + 1, 6))],
              ['K', near(p1, 1, 3)], ['k', near(p1, 2, 4)]];
    },
  },
};

// --- From a recipe to a FEN ------------------------------------------------
function validPlacement(pieces) {
  const seen = new Set();
  for (const [ch, s] of pieces) {
    if (!(s >= 0 && s <= 63) || seen.has(s)) return false;
    seen.add(s);
    if (ch.toLowerCase() === 'p' && (rank(s) === 0 || rank(s) === 7)) return false;
  }
  const kings = pieces.filter(([ch]) => ch.toLowerCase() === 'k').map(([, s]) => s);
  return kings.length === 2 && cheb(kings[0], kings[1]) > 1;
}

function toFen(pieces, whiteToMove) {
  const board = Array(64).fill('');
  for (const [ch, s] of pieces) board[s] = ch;
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
  return `${rows.join('/')} ${whiteToMove ? 'w' : 'b'} - - 0 1`;
}

// --- Shared helpers ----------------------------------------------------------
// Non-king material for each colour, read straight off a FEN.
export function material(fen) {
  const out = { w: { all: 0, pawns: 0, queens: 0 }, b: { all: 0, pawns: 0, queens: 0 } };
  for (const ch of fen.split(' ')[0]) {
    if (!/[a-zA-Z]/.test(ch) || ch.toLowerCase() === 'k') continue;
    const side = ch === ch.toUpperCase() ? out.w : out.b;
    side.all += 1;
    if (ch.toLowerCase() === 'p') side.pawns += 1;
    if (ch.toLowerCase() === 'q') side.queens += 1;
  }
  return out;
}

// Mirror left-to-right and/or swap colours (flipping the board top to bottom).
// Neither changes what a position is worth, so one vetted position is four.
export function transformFen(fen, mirror, swap) {
  const [placement, turn] = fen.split(' ');
  const board = Array(64).fill('');
  let s = 56;
  for (const ch of placement) {
    if (ch === '/') { s -= 16; continue; }
    if (ch >= '1' && ch <= '8') { s += Number(ch); continue; }
    board[s++] = ch;
  }
  const out = Array(64).fill('');
  for (let i = 0; i < 64; i++) {
    if (!board[i]) continue;
    let f = i & 7, r = i >> 3, ch = board[i];
    if (mirror) f = 7 - f;
    if (swap) { r = 7 - r; ch = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(); }
    out[r * 8 + f] = ch;
  }
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '', gap = 0;
    for (let f = 0; f < 8; f++) {
      const c = out[r * 8 + f];
      if (c) { if (gap) { row += gap; gap = 0; } row += c; } else gap++;
    }
    if (gap) row += gap;
    rows.push(row);
  }
  const side = swap ? (turn === 'w' ? 'b' : 'w') : turn;
  return `${rows.join('/')} ${side} - - 0 1`;
}

// One spelling for all four versions of a position, to spot duplicates.
export function canonical(fen) {
  return [[0, 0], [1, 0], [0, 1], [1, 1]].map(([m, w]) => transformFen(fen, m, w)).sort()[0];
}

// Positions vetted ahead of time (see js/bankbuild.js). Dealing from here costs
// no lookups and every position has already been played out and found hard.
let bankPromise = null;
function loadBank() {
  if (!bankPromise) {
    bankPromise = (typeof fetch === 'function'
      ? fetch(new URL('../modules/banks.json', import.meta.url)).then(r => (r.ok ? r.json() : {}))
      : Promise.resolve({})
    ).catch(() => ({}));
  }
  return bankPromise;
}

// --- How hard is a position? ----------------------------------------------
// A decision is real when few moves keep the result (at most two, or a quarter
// of the legal moves when there are many, as in rook endings) and none of them
// is a capture or a promotion: taking what is hanging is not a skill.
export function isRealDecision(keep, total) {
  if (!keep.length || keep.length >= total) return false;
  if (keep.length > Math.max(2, Math.floor(total * 0.25))) return false;
  return !keep.some(m => m.san.includes('x') || m.san.includes('='));
}

// Plays a position out the way the trainer runs the drill, for up to
// `lookAhead` of the learner's moves: the learner takes the quickest correct
// move, the opponent defends as the trainer's opponent does, and the drill's
// own finishing rules apply. Costs one lookup per move played.
export async function difficulty(fen, recipeId, Chess, { hold = 12, lookAhead = 4 } = {}) {
  const recipe = RECIPES[recipeId];
  const game = new Chess(fen);
  const userWhite = game.turn() === 'w';
  const sign = userWhite ? 1 : -1;
  const target = recipe.user === 'attacker' ? 1 : 0;
  const me = userWhite ? 'w' : 'b', them = userWhite ? 'b' : 'w';
  const start = material(fen);
  let moves = 0, real = 0, firstReal = false, lookups = 0;

  for (let ply = 0; ply < 2 * lookAhead + 2; ply++) {
    if (game.isGameOver()) break;
    const now = material(game.fen());
    if (moves > 0) {
      if (target === 1 && (now[me].queens > start[me].queens || now[them].all < start[them].all)) break;
      if (target === 0 && start[them].pawns > 0 && now[them].pawns === 0
          && now[them].queens === start[them].queens) break;
      if (target === 0 && moves >= hold) break;
    }
    const answer = await scoreFen(game.fen());
    lookups++;
    const list = answer.moves || [];
    if (!list.length) break;

    let choice;
    if ((game.turn() === 'w') === userWhite) {
      const keep = list.filter(m => m.wdl * sign === target);
      if (!keep.length) break;
      const isReal = isRealDecision(keep, list.length);
      if (moves === 0) firstReal = isReal;
      if (isReal) real++;
      moves++;
      if (!firstReal || moves >= lookAhead) break;
      choice = target === 1
        ? keep.reduce((a, b) => (b.depth < a.depth ? b : a))
        : (keep.find(m => m.san.includes('x')) || keep[0]);
    } else {
      const theirs = m => -m.wdl * sign;
      const best = Math.max(...list.map(theirs));
      let pool = list.filter(m => theirs(m) === best);
      if (best < 0) { const l = Math.max(...pool.map(m => m.depth)); pool = pool.filter(m => m.depth === l); }
      else if (best > 0) { const q = Math.min(...pool.map(m => m.depth)); pool = pool.filter(m => m.depth === q); }
      choice = pool[0];
    }
    game.move({ from: choice.uci.slice(0, 2), to: choice.uci.slice(2, 4), promotion: choice.uci[4] });
  }
  return { moves, real, firstReal, lookups };
}

// The bar a banked position has to clear.
export function hardEnough(d) {
  return d.firstReal && d.moves >= 3 && d.real >= 2;
}

// Deals one position for a drill, or null if the lookup budget runs out.
// Returns { fen, userColor: 'w'|'b', goal: 'win'|'draw', lookups }.
export async function deal(recipeId, Chess, { budget = 40, useBank = true, deep = false, hold = 12 } = {}) {
  const recipe = RECIPES[recipeId];

  if (useBank) {
    const bank = (await loadBank())[recipeId] || [];
    if (bank.length) {
      const fen = transformFen(bank[Math.floor(Math.random() * bank.length)],
        Math.random() < 0.5, Math.random() < 0.5);
      return { fen, userColor: fen.split(' ')[1], goal: recipe.user === 'attacker' ? 'win' : 'draw', lookups: 0, banked: true };
    }
  }

  const userAttacks = recipe.user === 'attacker';
  let asked = 0;

  for (let tries = 0; tries < 4000 && asked < budget; tries++) {
    let pieces = recipe.make();
    if (!validPlacement(pieces)) continue;

    // Mirror left-to-right, and swap colours, at random.
    if (Math.random() < 0.5) pieces = pieces.map(([ch, s]) => [ch, sq(7 - file(s), rank(s))]);
    const attackerIsWhite = Math.random() < 0.5;
    if (!attackerIsWhite) {
      pieces = pieces.map(([ch, s]) => [
        ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
        sq(file(s), 7 - rank(s)),
      ]);
    }
    const userIsWhite = userAttacks === attackerIsWhite;
    const fen = toFen(pieces, userIsWhite);

    // The side that is not to move must not be in check.
    let game;
    try {
      game = new Chess(fen);
      if (new Chess(toFen(pieces, !userIsWhite)).isCheck()) continue;
    } catch (e) { continue; }
    if (game.isGameOver()) continue;

    let answer;
    try {
      answer = await scoreFen(fen);
      asked++;
    } catch (e) {
      if (e instanceof PositionRejected) continue;
      throw e;
    }
    const mine = answer.wdl * (userIsWhite ? 1 : -1);          // from the user's side
    if (mine !== (userAttacks ? 1 : 0)) continue;
    if (userAttacks && recipe.minDepth && answer.depth < recipe.minDepth) continue;

    const moves = answer.moves || [];
    const keepers = moves.filter(m => m.wdl * (userIsWhite ? 1 : -1) === mine);
    const keep = keepers.length;
    const lose = moves.length - keep;
    if (!keep || lose < (recipe.minThrow || 1)) continue;
    if (recipe.maxKeepFrac && keep / moves.length > recipe.maxKeepFrac) continue;
    // The first move has to be a real decision, not a hanging pawn to take.
    if (!isRealDecision(keepers, moves.length)) continue;

    if (deep) {
      const d = await difficulty(fen, recipeId, Chess, { hold });
      asked += d.lookups;
      if (!hardEnough(d)) continue;
    }
    return { fen, userColor: userIsWhite ? 'w' : 'b', goal: userAttacks ? 'win' : 'draw', lookups: asked };
  }
  return null;
}
