// Training days, for the daily streak on the home page.
import { today } from './srs.js';

const KEY = 'chess-gym-activity-v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
}

// Call whenever a piece of training is finished (a review, a puzzle, a round).
export function markActive() {
  const data = load();
  const day = today();
  data[day] = (data[day] || 0) + 1;
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* not kept */ }
}

// Days in a row with some training, counting today if you have trained, or
// up to yesterday if you haven't yet (so the streak isn't lost until midnight).
export function streak() {
  const data = load();
  let n = 0;
  let offset = data[today()] ? 0 : -1;
  while (data[today(offset)]) { n += 1; offset -= 1; }
  return { days: n, today: data[today()] || 0 };
}
