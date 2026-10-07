# Chess Gym

A personal chess trainer that runs on GitHub Pages. You play the moves; a wrong move is rejected and explained; drills pick a random line each round.

Live site: https://utkarshup49.github.io/chess-trainer/

## How it works

- `index.html` loads the board (chessground) and the rules engine (chess.js) from the jsDelivr CDN.
- `js/app.js` is the page router: home → module → learn or drill.
- `js/board.js` wraps the board. The trainer decides whether a move counts.
- `js/opening.js` is the opening trainer.
- `js/progress.js` saves progress in the browser (localStorage), so each device keeps its own.
- `modules/index.json` lists the modules; each module is one JSON file.

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
