// Spaced repetition for opening moves.
//
// Every move you have to find in a line is a "card", named by the same key as
// its explanation ("d4 d5 Bf4|Nf6"... "moves so far|your move"). A card joins
// your reviews once you have walked through or tested its line. Each review
// you get right pushes the next one further away (1 day, then about 3, 7, 16,
// 35 days...); a miss brings it back tomorrow. Stored per browser.

const KEY = 'chess-gym-srs-v1';
const FIRST_INTERVAL = 1;   // days after a card is first learned or missed
const START_EASE = 2.5;     // how fast intervals grow
const MIN_EASE = 1.3;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
}
function save(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* not kept */ }
}

// Dates are local calendar days, written YYYY-MM-DD so they sort as text.
export function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The cards of one line: every move of the learner's side, with its key.
export function lineCards(line) {
  const moves = line.moves.split(' ');
  const first = line.side === 'white' ? 0 : 1;
  const cards = [];
  for (let i = first; i < moves.length; i += 2) {
    cards.push({ key: moves.slice(0, i).join(' ') + '|' + moves[i], ply: i });
  }
  return cards;
}

// Add a line's cards to the reviews (cards already there keep their schedule).
export function addLine(moduleId, line, dueInDays = FIRST_INTERVAL) {
  const data = load();
  const deck = data[moduleId] || (data[moduleId] = {});
  for (const c of lineCards(line)) {
    if (!deck[c.key]) deck[c.key] = { due: today(dueInDays), interval: 0, ease: START_EASE, reps: 0, lapses: 0 };
  }
  save(data);
}

// Record one review. remembered: found first time, without help.
export function review(moduleId, key, remembered) {
  const data = load();
  const deck = data[moduleId] || (data[moduleId] = {});
  const c = deck[key] || { interval: 0, ease: START_EASE, reps: 0, lapses: 0 };
  if (remembered) {
    c.interval = c.interval === 0 ? FIRST_INTERVAL
      : c.interval === 1 ? 3
      : Math.round(c.interval * c.ease);
    c.reps += 1;
  } else {
    c.interval = FIRST_INTERVAL;
    c.ease = Math.max(MIN_EASE, c.ease - 0.2);
    c.lapses += 1;
  }
  c.due = today(c.interval);
  c.last = today();
  deck[key] = c;
  save(data);
  return c;
}

export function deckOf(moduleId) {
  return load()[moduleId] || {};
}

// Keys due today (or overdue) in a module.
export function dueKeys(moduleId) {
  const now = today();
  return Object.entries(deckOf(moduleId)).filter(([, c]) => c.due <= now).map(([k]) => k);
}

// For a module page: how many cards, how many due, when the next one comes.
export function summary(moduleId) {
  const deck = Object.values(deckOf(moduleId));
  const now = today();
  const due = deck.filter(c => c.due <= now).length;
  const upcoming = deck.filter(c => c.due > now).map(c => c.due).sort();
  return { cards: deck.length, due, next: upcoming[0] || null };
}

// Cards for lines you had already learned or tested before reviews existed:
// add them once, due today, so your first review session covers them.
export function adoptExisting(module, progress) {
  const data = load();
  data._adopted = data._adopted || {};
  if (data._adopted[module.id]) return;
  save(data);
  for (const line of module.lines) {
    const p = progress.lines[line.id] || {};
    if (p.studied || p.done) addLine(module.id, line, 0);
  }
  const after = load();
  after._adopted = { ...(after._adopted || {}), [module.id]: true };
  save(after);
}

export function resetDeck(moduleId) {
  const data = load();
  delete data[moduleId];
  save(data);
}
