// Builds modules/banks.json: a bank of positions per drill that have been
// played out the way the trainer runs them and found hard enough.
//
// Not loaded by the site. Run it from the browser console on the live page,
// where the tablebase is reachable:
//
//   const { Chess } = await import('https://cdn.jsdelivr.net/npm/chess.js@1.0.0/+esm');
//   const b = await import('/chess-trainer/js/bankbuild.js');
//   const result = await b.build(Chess, { perRecipe: 16, lookupBudget: 200 });
//   copy(JSON.stringify(result.bank, null, 1));   // then save as modules/banks.json
//
// It goes through the same polite one-at-a-time queue as the drills, so a
// full build takes a while. Keep the budget modest; Lichess runs this for free.
import { RECIPES, deal, canonical } from './tbgen.js';

const MODULES = ['rook-endgames', 'queen-vs-pawn', 'fortresses', 'pawn-endgames-2'];

// How long each drill counts a draw as held, from the module files.
async function holdLengths() {
  const holds = {};
  for (const id of MODULES) {
    try {
      const m = await fetch(new URL(`../modules/${id}.json`, import.meta.url)).then(r => r.json());
      for (const d of m.drills) if (d.recipe && d.hold) holds[d.recipe] = d.hold;
    } catch (e) { /* default applies */ }
  }
  return holds;
}

export async function build(Chess, {
  recipes = Object.keys(RECIPES), perRecipe = 16, lookupBudget = 200, existing = {}, log = () => {},
} = {}) {
  const holds = await holdLengths();
  const bank = {}, stats = {};
  for (const id of recipes) {
    const list = [...(existing[id] || [])];
    const seen = new Set(list.map(canonical));
    let spent = 0;
    while (list.length < perRecipe && spent < lookupBudget) {
      const budget = Math.min(40, lookupBudget - spent);
      const pos = await deal(id, Chess, { useBank: false, deep: true, budget, hold: holds[id] || 12 });
      if (!pos) { spent += budget; continue; }
      spent += pos.lookups;
      const key = canonical(pos.fen);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(pos.fen);
      log(`${id}: ${list.length}/${perRecipe} after ${spent} lookups`);
    }
    bank[id] = list;
    stats[id] = { found: list.length, lookups: spent };
  }
  return { bank, stats };
}
