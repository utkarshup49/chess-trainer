// Games played against the bot, saved in this browser (localStorage).
const KEY = 'chess-gym-games-v1';
const MAX_GAMES = 200;

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function writeAll(games) {
  try {
    localStorage.setItem(KEY, JSON.stringify(games.slice(-MAX_GAMES)));
  } catch (e) {
    // Storage full or blocked: the game still shows, it just isn't kept.
  }
}

// Newest first.
export function listGames(moduleId) {
  const all = readAll();
  return (moduleId ? all.filter(g => g.module === moduleId) : all).slice().reverse();
}

export function getGame(id) {
  return readAll().find(g => g.id === id) || null;
}

export function saveGame(game) {
  const games = readAll();
  const id = game.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const record = { ...game, id };
  const at = games.findIndex(g => g.id === id);
  if (at >= 0) games[at] = record; else games.push(record);
  writeAll(games);
  return record;
}

export function updateGame(id, patch) {
  const game = getGame(id);
  if (game) saveGame({ ...game, ...patch });
}

export function deleteGames(moduleId) {
  writeAll(readAll().filter(g => g.module !== moduleId));
}

// How each line of an opening has gone: games, your score, and the average
// engine evaluation (from your side, in pawns) when the book ran out.
export function lineSummary(moduleId) {
  const rows = new Map();
  for (const g of listGames(moduleId)) {
    const key = g.lineName || 'Left the book early';
    const r = rows.get(key) || { name: key, games: 0, points: 0, wins: 0, draws: 0, losses: 0, evals: [] };
    r.games += 1;
    if (g.outcome === 'win') { r.wins += 1; r.points += 1; }
    else if (g.outcome === 'draw') { r.draws += 1; r.points += 0.5; }
    else r.losses += 1;
    if (typeof g.bookEval === 'number') r.evals.push(g.bookEval);
    rows.set(key, r);
  }
  return [...rows.values()].map(r => ({
    ...r,
    avgEval: r.evals.length ? r.evals.reduce((a, b) => a + b, 0) / r.evals.length / 100 : null,
  })).sort((a, b) => b.games - a.games);
}
