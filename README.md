# Chess Gym

A personal chess trainer that runs on GitHub Pages. You play the moves; a wrong move is rejected and explained; drills pick a random line each round.

Live site: https://utkarshup49.github.io/chess-trainer/

## How it works

- `index.html` loads the board (chessground) and the rules engine (chess.js) from the jsDelivr CDN.
- `js/app.js` is the page router: home → module → learn or drill.
- `js/board.js` wraps the board. The trainer decides whether a move counts.
- `js/opening.js` is the opening trainer.
- `js/endgame.js` is the endgame trainer: random positions, silence while you play, and a post-mortem naming the move where the result slipped.
- `js/progress.js` saves progress in the browser (localStorage), so each device keeps its own.
- `modules/index.json` lists the modules; each module is one JSON file.

## How endgame moves are judged

A move counts if it keeps the result. Nothing is stored as a line, so nothing can be memorised.

- `js/kpk.js` solves every King + Pawn vs King position on load (about half a second) by working backwards from promotions and captures. Instant and offline.
- `js/oracle.js` is the single way to ask who is winning. Three pieces or fewer go to the solver above; anything larger goes to Lichess's endgame tablebase, which is perfect up to seven pieces. Every answer is cached.
- `js/kpgen.js` deals random King + Pawn vs King positions, rejecting any where no move throws the result away — if you cannot go wrong, there is nothing to learn.
- `js/race.js` deals four-piece pawn races, filtering candidates locally so a deal costs only a handful of lookups.
- `js/coach.js` turns "that move throws the result away" into the principle behind it.

The solver was checked three ways: against a second implementation written independently (165,676 positions, no disagreements), against Lichess's tablebase (70 random positions and a set of promotion edge cases), and against chess.js for move generation (600 positions).

## Opening module format

```json
{
  "id": "qg-traps",
  "type": "opening",
  "title": "Queen's Gambit Traps",
  "description": "...",
  "lines": [
    { "id": "qga-1", "name": "...", "side": "white", "moves": "d4 d5 c4 dxc4 ...", "idea": "Shown when the line is finished." }
  ],
  "explain": {
    "d4 d5|c4": "Shown when you play a wrong move in the position after 1.d4 d5, where the right move is c4.",
    "d4 d5 c4|*": "Used in drills when more than one move is correct in that position."
  }
}
```

- `moves` are SAN moves separated by spaces, from the starting position.
- `side` is the colour you play in that line.
- An `explain` key is the moves played so far, then `|`, then the correct move (or `*`).

## Run it locally

Any static server works, for example `python3 -m http.server` in this folder, then open http://localhost:8000.
