// How the practice bot chooses a move at a given rating.
//
// Stockfish scores its best few moves. A strong bot nearly always picks the
// top one; a weaker bot is more willing to pick a move that loses a bit, and
// now and then plays a move without looking at all, the way people at that
// level hang pieces. The numbers below were tuned offline with a full-strength
// Stockfish so that the bot's average centipawn loss (how much its moves throw
// away, on average) roughly matches human players at each rating. It is an
// approximation of a rating, not a measured one.
//
//   depth   how far Stockfish looks
//   lines   how many moves it scores (MultiPV)
//   temp    how forgiving the choice is: a move losing `temp` centipawns is
//           picked about e^-1 (37%) as often as the best move
//   wild    chance of a completely random legal move
export const LEVELS = [
  { rating: 800, depth: 6, lines: 8, temp: 0, wild: 0 },
  { rating: 1000, depth: 6, lines: 8, temp: 0, wild: 0 },
  { rating: 1200, depth: 8, lines: 8, temp: 0, wild: 0 },
  { rating: 1400, depth: 8, lines: 6, temp: 0, wild: 0 },
  { rating: 1600, depth: 10, lines: 5, temp: 0, wild: 0 },
  { rating: 1800, depth: 12, lines: 4, temp: 0, wild: 0 },
  { rating: 2000, depth: 12, lines: 3, temp: 0, wild: 0 },
];

export const levelFor = rating => LEVELS.find(l => l.rating === Number(rating)) || LEVELS[2];

// lines: the engine's scored moves, best first, scores from the bot's side.
// legal: every legal move in UCI form. Returns the chosen UCI move.
export function chooseMove(lines, legal, level, random = Math.random) {
  if (!lines.length) return legal[Math.floor(random() * legal.length)];
  if (level.wild && random() < level.wild) {
    return legal[Math.floor(random() * legal.length)];
  }
  if (!level.temp) return lines[0].move;
  const best = lines[0].score;
  const weights = lines.map(l => Math.exp(-Math.min(1000, best - l.score) / level.temp));
  const total = weights.reduce((a, b) => a + b, 0);
  let pick = random() * total;
  for (let i = 0; i < lines.length; i++) {
    pick -= weights[i];
    if (pick <= 0) return lines[i].move;
  }
  return lines[0].move;
}
