// Passing a game or position to the analysis board from another page.
const KEY = 'chess-gym-analysis';

// moves: SAN from the start position; ply: where to open (default: the end).
export function openInAnalysis(moves, orientation = 'white', ply) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ moves, orientation, ply })); } catch (e) { /* start empty */ }
  location.hash = '#/analysis?from=' + Date.now();
}

export function takeHandoff() {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
