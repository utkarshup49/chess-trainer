// One place to ask "who is winning, and what does each move do?".
//
// Three pieces or fewer are answered by the built-in solver: instant, offline,
// and already verified. Anything bigger goes to Lichess's endgame tablebase,
// which is perfect up to seven pieces. Every answer is cached, so a position
// is only ever looked up once.
import { probe as probeKpk, promotionResult, WIN, DRAW } from './kpk.js';

export const WHITE_WINS = 1;
export const DRAWN = 0;
export const BLACK_WINS = -1;

const TABLEBASE = 'https://tablebase.lichess.ovh/standard';
const cache = new Map();

export class OracleOffline extends Error {}
// The tablebase rejected the position itself (illegal, or too many pieces).
export class PositionRejected extends Error {}

// --- Reading a FEN --------------------------------------------------------
export function readFen(fen) {
  const [placement, turn] = fen.split(' ');
  const pieces = [];
  let sq = 56;                                   // a8
  for (const ch of placement) {
    if (ch === '/') { sq -= 16; continue; }
    if (ch >= '1' && ch <= '8') { sq += Number(ch); continue; }
    pieces.push({ type: ch.toLowerCase(), white: ch === ch.toUpperCase(), square: sq });
    sq += 1;
  }
  return { pieces, stm: turn === 'w' ? 0 : 1 };
}

export function census(fen) {
  const { pieces } = readFen(fen);
  const c = { total: pieces.length, wp: 0, bp: 0, wq: 0, bq: 0, other: 0 };
  for (const p of pieces) {
    if (p.type === 'k') continue;
    if (p.type === 'p') p.white ? c.wp++ : c.bp++;
    else if (p.type === 'q') p.white ? c.wq++ : c.bq++;
    else c.other++;
  }
  return c;
}

// Positions the built-in solver already covers.
function localAnswer(fen) {
  const { pieces, stm } = readFen(fen);
  if (pieces.length > 3) return null;
  const kings = pieces.filter(p => p.type === 'k');
  if (kings.length !== 2) return null;
  const wk = kings.find(p => p.white).square;
  const bk = kings.find(p => !p.white).square;
  const rest = pieces.filter(p => p.type !== 'k');

  if (rest.length === 0) return { wdl: DRAWN, depth: Infinity };
  const odd = rest[0];
  if (!odd.white) return null;                   // Black's extra piece: not ours
  if (odd.type === 'p') {
    const r = probeKpk(wk, bk, odd.square, stm);
    return { wdl: r.result === WIN ? WHITE_WINS : DRAWN, depth: r.depth };
  }
  // A queen that has only just appeared, with Black to move.
  if (odd.type === 'q' && stm === 1) {
    return { wdl: promotionResult(wk, bk, odd.square) === WIN ? WHITE_WINS : DRAWN, depth: 0 };
  }
  return null;
}

// --- Lichess tablebase ----------------------------------------------------
const CATEGORY = {
  win: 1, 'cursed-win': 1, 'maybe-win': 1,
  draw: 0, unknown: 0,
  loss: -1, 'blessed-loss': -1, 'maybe-loss': -1,
};

async function askTablebase(fen) {
  let res;
  try {
    res = await fetch(`${TABLEBASE}?fen=${encodeURIComponent(fen)}`);
  } catch (e) {
    throw new OracleOffline(e.message);
  }
  // A 4xx is the tablebase refusing this position, which is a different
  // problem from not being able to reach it at all.
  if (res.status >= 400 && res.status < 500) {
    throw new PositionRejected(`${res.status}: ${(await res.text()).slice(0, 80)}`);
  }
  if (!res.ok) throw new OracleOffline('tablebase ' + res.status);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new OracleOffline('bad response from the tablebase');
  }
  const stm = fen.split(' ')[1] === 'w' ? 0 : 1;
  const sign = stm === 0 ? 1 : -1;
  const depthOf = m => Math.abs(m.dtm ?? m.dtz ?? 0);
  return {
    // The API answers from the side to move's point of view; flip it to White's.
    wdl: sign * (CATEGORY[data.category] ?? 0),
    depth: depthOf(data),
    // A move's category is reported for whoever is to move *after* it, so the
    // sign flips once more.
    moves: (data.moves || []).map(m => ({
      uci: m.uci,
      san: m.san,
      wdl: -sign * (CATEGORY[m.category] ?? 0),
      depth: depthOf(m),
    })),
  };
}

// --- Public interface -----------------------------------------------------
// Returns { wdl, depth, moves? } with wdl always from White's point of view.
export async function scoreFen(fen) {
  const key = fen.split(' ').slice(0, 4).join(' ');
  if (cache.has(key)) return cache.get(key);

  const local = localAnswer(fen);
  const answer = local ? { ...local, moves: null } : await askTablebase(fen);
  cache.set(key, answer);
  return answer;
}

// True when this position needs the network.
export function needsNetwork(fen) {
  return localAnswer(fen) === null;
}

export function cacheSize() {
  return cache.size;
}

// --- Scoring every legal move --------------------------------------------
// Returns [{ move, wdl, depth, fen }] with wdl from White's point of view.
// A tablebase answer already grades every move, so this costs one lookup;
// locally solved positions are graded child by child, which is instant.
export async function scoreMoves(game, Chess) {
  const fen = game.fen();
  const answer = await scoreFen(fen);
  const legal = game.moves({ verbose: true });

  const withFen = legal.map(move => {
    const copy = new Chess(fen);
    copy.move(move);
    return { move, fen: copy.fen() };
  });

  if (answer.moves) {
    const byUci = new Map(answer.moves.map(m => [m.uci, m]));
    const out = [];
    for (const entry of withFen) {
      const uci = entry.move.from + entry.move.to + (entry.move.promotion || '');
      const hit = byUci.get(uci);
      if (hit) out.push({ ...entry, wdl: hit.wdl, depth: hit.depth });
      else {
        const s = await scoreFen(entry.fen);      // shouldn't happen, but stay correct
        out.push({ ...entry, wdl: s.wdl, depth: s.depth });
      }
    }
    return out;
  }

  const out = [];
  for (const entry of withFen) {
    const s = await scoreFen(entry.fen);
    out.push({ ...entry, wdl: s.wdl, depth: Number.isFinite(s.depth) ? s.depth : 0 });
  }
  return out;
}

// The opponent's reply. It never spoils its own result and resists as long as
// it can. Where the position is solved locally, it also prefers the move that
// leaves the learner the most ways to go wrong.
export async function chooseReply(game, Chess) {
  const white = game.turn() === 'w';
  const scored = await scoreMoves(game, Chess);
  if (!scored.length) return null;

  const best = white
    ? Math.max(...scored.map(m => m.wdl))
    : Math.min(...scored.map(m => m.wdl));
  let pool = scored.filter(m => m.wdl === best);

  const losing = white ? best < 0 : best > 0;
  if (losing) {
    const longest = Math.max(...pool.map(m => m.depth));
    pool = pool.filter(m => m.depth === longest);
  } else if (white ? best > 0 : best < 0) {
    const quickest = Math.min(...pool.map(m => m.depth));
    pool = pool.filter(m => m.depth === quickest);
  }

  if (pool.length > 1 && !needsNetwork(game.fen())) {
    const want = white ? 1 : -1;                  // what the learner is chasing
    let mostTraps = -1, sharpest = pool;
    for (const entry of pool) {
      const next = new Chess(entry.fen);
      const replies = await scoreMoves(next, Chess);
      const good = replies.filter(r => (next.turn() === 'w' ? r.wdl >= want : r.wdl <= want));
      const traps = good.length && good.length < replies.length ? replies.length - good.length : 0;
      if (traps > mostTraps) { mostTraps = traps; sharpest = [entry]; }
      else if (traps === mostTraps) sharpest.push(entry);
    }
    pool = sharpest;
  }
  return pool[Math.floor(Math.random() * pool.length)].move;
}
