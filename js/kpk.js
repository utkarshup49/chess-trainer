// Perfect solver for King + Pawn vs King (White owns the pawn).
// Every position with 3 pieces is solved once, up front, by working backwards
// from promotions and captures. Solving takes well under a second, so the
// trainer can judge any move instantly and generate random positions offline.
//
// Squares are 0..63 with 0 = a1 and 63 = h8.

export const WIN = 1;   // White (the pawn's side) wins
export const DRAW = 0;

const file = s => s & 7;
const rank = s => s >> 3;

export function squareName(s) {
  return 'abcdefgh'[file(s)] + (rank(s) + 1);
}

export function squareFromName(name) {
  return 'abcdefgh'.indexOf(name[0]) + (Number(name[1]) - 1) * 8;
}

// Precompute king moves and king-adjacency for every square.
const kingMoves = [];
const adjacent = [];
for (let s = 0; s < 64; s++) {
  const list = [];
  const adj = new Uint8Array(64);
  for (const df of [-1, 0, 1]) {
    for (const dr of [-1, 0, 1]) {
      if (df === 0 && dr === 0) continue;
      const f = file(s) + df;
      const r = rank(s) + dr;
      if (f < 0 || f > 7 || r < 0 || r > 7) continue;
      const t = r * 8 + f;
      list.push(t);
      adj[t] = 1;
    }
  }
  kingMoves.push(list);
  adjacent.push(adj);
}

export function kingsTouch(a, b) {
  return a === b || adjacent[a][b] === 1;
}

// Squares a white pawn on `p` attacks.
function pawnAttacks(p) {
  const out = [];
  const r = rank(p) + 1;
  if (r > 7) return out;
  if (file(p) > 0) out.push(r * 8 + file(p) - 1);
  if (file(p) < 7) out.push(r * 8 + file(p) + 1);
  return out;
}

// --- Position index -------------------------------------------------------
// stm: 0 = White to move, 1 = Black to move.
const SIZE = 64 * 64 * 64 * 2;
export const index = (wk, bk, p, stm) => ((wk * 64 + bk) * 64 + p) * 2 + stm;

export function isLegal(wk, bk, p, stm) {
  if (wk === bk || wk === p || bk === p) return false;
  if (rank(p) < 1 || rank(p) > 6) return false;      // pawn lives on ranks 2..7
  if (kingsTouch(wk, bk)) return false;
  // If White is to move, Black must not have left its king attacked by the pawn.
  if (stm === 0 && pawnAttacks(p).includes(bk)) return false;
  return true;
}

// --- Terminal positions ---------------------------------------------------
// After White promotes to a queen on `q`, with Black to move.
// Exported so the trainer can score a position where the pawn has just queened.
export function promotionResult(wk, bk, q) {
  // Black simply takes an undefended new queen.
  if (adjacent[bk][q] && !adjacent[wk][q]) return DRAW;

  // Squares the queen attacks. The black king is NOT a blocker here, so a king
  // fleeing backwards along a checking line is still seen as in check.
  const attacked = new Uint8Array(64);
  for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    let f = file(q) + df;
    let r = rank(q) + dr;
    while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
      const t = r * 8 + f;
      attacked[t] = 1;
      if (t === wk) break;
      f += df;
      r += dr;
    }
  }

  let hasMove = false;
  for (const t of kingMoves[bk]) {
    if (t === wk || adjacent[wk][t]) continue;
    if (t === q) {
      if (!adjacent[wk][q]) hasMove = true;           // capture the queen
      continue;
    }
    if (!attacked[t]) hasMove = true;
  }
  if (hasMove) return WIN;                            // K+Q vs K is always won
  return attacked[bk] ? WIN : DRAW;                   // checkmate, else stalemate
}

// --- Move generation ------------------------------------------------------
// Each successor is either another position [wk, bk, p] or a terminal result.
function whiteMoves(wk, bk, p) {
  const out = [];
  for (const t of kingMoves[wk]) {
    if (t === p || kingsTouch(t, bk)) continue;
    out.push({ wk: t, bk, p });
  }
  const one = p + 8;
  if (one !== wk && one !== bk) {
    if (rank(one) === 7) out.push({ terminal: promotionResult(wk, bk, one) });
    else out.push({ wk, bk, p: one });
    // Double step from the second rank.
    const two = p + 16;
    if (rank(p) === 1 && two !== wk && two !== bk) out.push({ wk, bk, p: two });
  }
  return out;
}

function blackMoves(wk, bk, p) {
  const out = [];
  for (const t of kingMoves[bk]) {
    if (kingsTouch(t, wk)) continue;
    if (t === p) out.push({ terminal: DRAW });        // king takes the pawn
    else if (!pawnAttacks(p).includes(t)) out.push({ wk, bk: t, p });
  }
  return out;
}

export function movesFrom(wk, bk, p, stm) {
  return stm === 0 ? whiteMoves(wk, bk, p) : blackMoves(wk, bk, p);
}

// --- Solve everything -----------------------------------------------------
const result = new Uint8Array(SIZE);                  // WIN or DRAW
const depth = new Uint16Array(SIZE).fill(9999);       // plies until the pawn queens
let solved = false;

// pawnHitsKing[p * 64 + k] = 1 when a white pawn on p attacks square k.
const pawnHitsKing = new Uint8Array(64 * 64);
for (let p = 0; p < 64; p++) {
  for (const t of pawnAttacks(p)) pawnHitsKing[p * 64 + t] = 1;
}

// Promotions repeat constantly, so each one is worked out only once.
const promoCache = new Int8Array(64 * 64 * 8).fill(-1);
function promotion(wk, bk, q) {
  const key = (wk * 64 + bk) * 8 + (q - 56);
  let v = promoCache[key];
  if (v < 0) {
    v = promotionResult(wk, bk, q);
    promoCache[key] = v;
  }
  return v;
}

// Pawn squares on files a-d. A pawn never changes file, so these positions
// only ever lead to each other; files e-h are reached by mirroring.
const halfPawns = [];
for (let p = 8; p < 56; p++) if (file(p) <= 3) halfPawns.push(p);

const mirror = s => rank(s) * 8 + (7 - file(s));

export function solve() {
  if (solved) return;

  // Pass 1: who wins. Repeat until nothing new is found.
  let changed = true;
  while (changed) {
    changed = false;
    for (let wk = 0; wk < 64; wk++) {
      for (let bk = 0; bk < 64; bk++) {
        if (kingsTouch(wk, bk)) continue;
        for (const p of halfPawns) {
          if (p === wk || p === bk) continue;

          // White to move.
          let i = index(wk, bk, p, 0);
          if (result[i] !== WIN && !pawnHitsKing[p * 64 + bk]) {
            if (whiteCanWin(wk, bk, p)) { result[i] = WIN; changed = true; }
          }
          // Black to move.
          i = index(wk, bk, p, 1);
          if (result[i] !== WIN && blackIsLost(wk, bk, p)) { result[i] = WIN; changed = true; }
        }
      }
    }
  }

  // Pass 2: exact distance to promotion. Only winning positions have one, so
  // collect those first and then pull the values down until they stop moving.
  const won = [];
  for (let wk = 0; wk < 64; wk++) {
    for (let bk = 0; bk < 64; bk++) {
      if (kingsTouch(wk, bk)) continue;
      for (const p of halfPawns) {
        if (p === wk || p === bk) continue;
        for (let stm = 0; stm < 2; stm++) {
          const i = index(wk, bk, p, stm);
          if (result[i] === WIN) won.push(i);
        }
      }
    }
  }

  changed = true;
  while (changed) {
    changed = false;
    for (const i of won) {
      const stm = i & 1;
      const rest = i >> 1;
      const p = rest & 63;
      const bk = (rest >> 6) & 63;
      const wk = (rest >> 12) & 63;
      const d = stm === 0 ? whiteDepth(wk, bk, p) : blackDepth(wk, bk, p);
      if (d < depth[i]) { depth[i] = d; changed = true; }
    }
  }
  solved = true;
}

// White wins if any single move reaches a won position.
function whiteCanWin(wk, bk, p) {
  for (const t of kingMoves[wk]) {
    if (t === p || kingsTouch(t, bk)) continue;
    if (result[index(t, bk, p, 1)] === WIN) return true;
  }
  const one = p + 8;
  if (one !== wk && one !== bk) {
    if (one >= 56) {
      if (promotion(wk, bk, one) === WIN) return true;
    } else if (result[index(wk, bk, one, 1)] === WIN) return true;
    const two = p + 16;
    if (p < 16 && two !== wk && two !== bk && result[index(wk, bk, two, 1)] === WIN) return true;
  }
  return false;
}

// Black is lost only when every reply loses.
function blackIsLost(wk, bk, p) {
  let hasMove = false;
  for (const t of kingMoves[bk]) {
    if (kingsTouch(t, wk)) continue;
    if (t === p) return false;                        // the king just takes the pawn
    if (pawnHitsKing[p * 64 + t]) continue;
    hasMove = true;
    if (result[index(wk, t, p, 0)] !== WIN) return false;
  }
  // No legal move: mate if the pawn is giving check, otherwise stalemate.
  if (!hasMove) return pawnHitsKing[p * 64 + bk] === 1;
  return true;
}

// White picks the quickest win.
function whiteDepth(wk, bk, p) {
  let best = 9999;
  for (const t of kingMoves[wk]) {
    if (t === p || kingsTouch(t, bk)) continue;
    const j = index(t, bk, p, 1);
    if (result[j] === WIN && depth[j] + 1 < best) best = depth[j] + 1;
  }
  const one = p + 8;
  if (one !== wk && one !== bk) {
    if (one >= 56) {
      if (promotion(wk, bk, one) === WIN && best > 1) best = 1;
    } else {
      const j = index(wk, bk, one, 1);
      if (result[j] === WIN && depth[j] + 1 < best) best = depth[j] + 1;
    }
    const two = p + 16;
    if (p < 16 && two !== wk && two !== bk) {
      const j = index(wk, bk, two, 1);
      if (result[j] === WIN && depth[j] + 1 < best) best = depth[j] + 1;
    }
  }
  return best;
}

// Black holds out as long as possible, so the slowest reply sets the distance.
function blackDepth(wk, bk, p) {
  let worst = 0;
  let hasMove = false;
  for (const t of kingMoves[bk]) {
    if (kingsTouch(t, wk) || t === p || pawnHitsKing[p * 64 + t]) continue;
    hasMove = true;
    const j = index(wk, t, p, 0);
    if (depth[j] + 1 > worst) worst = depth[j] + 1;
  }
  return hasMove ? worst : 0;                         // 0 = already checkmate
}

export function probe(wk, bk, p, stm) {
  solve();
  if (file(p) > 3) { wk = mirror(wk); bk = mirror(bk); p = mirror(p); }
  const i = index(wk, bk, p, stm);
  return { result: result[i], depth: result[i] === WIN ? depth[i] : Infinity };
}
