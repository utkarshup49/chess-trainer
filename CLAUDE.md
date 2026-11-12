# Working on Chess Gym

Personal chess trainer, static site on GitHub Pages: https://utkarshup49.github.io/chess-trainer/

## The rule that shapes everything

Nothing may be learnable by memorising squares. A move is judged by whether it
keeps the result, so several moves are usually right, and positions are dealt
fresh rather than replayed. Openings are the one exception: a trap line is a
fixed sequence, so openings are taught first and tested second.

## Every opening module ships both portals

An opening module always has two ways in, and a new one is not finished until
both work:

1. **Learn the lines** (`js/study.js`) - walk through a line move by move. The
   move to play is drawn on the board, each move carries its explanation, and
   the learner can press Next or play the move themselves. Nothing can be got
   wrong here.
2. **Test yourself** (`js/opening.js`) - find the moves unaided, either one
   chosen line or a random one. Wrong moves are rejected with the principle.

Both are driven entirely by the module JSON, so adding a new opening needs no
new code - but it does need the data below. Never add only the test half.

### What a new opening module must supply

```json
{
  "id": "...", "type": "opening", "title": "...", "description": "...",
  "lines": [
    { "id": "...", "name": "...", "side": "white",
      "moves": "d4 d5 c4 ...",          // SAN from the start, space separated
      "idea": "Shown at the end of both the walkthrough and the test." }
  ],
  "explain": {
    "d4 d5|c4": "Why c4 is the move here.",
    "d4 d5 c4|*": "Used when more than one move is correct at this point."
  }
}
```

An `explain` key is the moves played so far, then `|`, then the correct move
(or `*` where several are). **Every move the learner has to find needs one** -
it is the teaching text in the walkthrough and the correction in the test.
Check coverage before shipping:

```bash
python3 -I - <<'PY'
import json
m = json.load(open('modules/<file>.json')); ex = m['explain']; missing = []
for side in ('white', 'black'):
    lines = [l['moves'].split() for l in m['lines'] if l['side'] == side]
    par = 0 if side == 'white' else 1
    for L in lines:
        for i, mv in enumerate(L):
            if i % 2 != par: continue
            pre = ' '.join(L[:i])
            nxt = {x[i] for x in lines if len(x) > i and x[:i] == L[:i]}
            if f'{pre}|{mv}' not in ex: missing.append((pre, mv))
            if len(nxt) > 1 and f'{pre}|*' not in ex: missing.append((pre, '*'))
print(len(missing), missing[:10])
PY
```

Finally add the module to `modules/index.json`.

## Endgames

`js/oracle.js` is the only way to ask who is winning: three pieces or fewer go
to the built-in solver in `js/kpk.js` (instant, offline), anything larger to
Lichess's tablebase (perfect to seven pieces), and every answer is cached.
Generators reject any position where no move throws the result away.

There are two endgame engines, chosen per module:

- `kp-endgames` uses `js/endgame.js` with the built-in solver.
- Any module with `"engine": "tablebase"` uses `js/tbdrill.js`. A drill there is
  data plus a recipe: the module JSON carries `name`, `goal`, `idea`, a
  four-step `method`, and optionally a `demo` (start FEN, moves and a note per
  move) that becomes the "Learn the method" walkthrough. The drill's `recipe`
  names an entry in `js/tbgen.js`, which describes the family of positions from
  the attacker's side; the dealer mirrors it, swaps colours, and keeps only
  positions the tablebase says are the right result and sharp.

Adding a tablebase drill: write the recipe, add the drill to a module, and if
it has a demo, check every move of the demo against the tablebase first. A
hand-written textbook position can simply be wrong (the first Vancura start
was a loss for the defender).

### Positions must be hard, not just correct

"Some move throws the result away" is true of almost any position, because
the learner can always walk the king away, so it says nothing about whether
the right move is hard. A dealt position has to clear a real bar:

- A **real decision** is one where at most two moves keep the result (or a
  quarter of the legal moves, when there are many), and none of them is a
  capture or a promotion. Taking a hanging pawn is not a skill.
- The position is played out the way the trainer runs the drill: the learner
  takes the quickest correct move, the opponent defends as the trainer's
  opponent does, and the drill's own finishing rules apply. The first move
  must be a real decision, there must be at least two of them, and the drill
  must not be finishable in one or two moves.

King + Pawn drills check this at deal time with the built-in solver
(`difficulty` and `isHardEnough` in `js/kpgen.js`). Tablebase drills cannot
afford a full play-out per deal, so they deal from `modules/banks.json`,
positions vetted ahead of time with `js/bankbuild.js` and dealt mirrored and
colour-swapped at random. When a drill has no bank, live dealing still insists
on a real first decision, and falls back to the most demanding candidate it
saw rather than fail. Rebuild the bank whenever a recipe changes.

### Be polite to the tablebase

Lichess allows one request at a time and wants a full minute's pause after a
429. All lookups go through one queue in `oracle.js` with a gap between them.
Never fire lookups in parallel, and keep test scripts to a few hundred requests.

## Testing

The sandbox cannot reach the CDN or the tablebase, so:

- Logic that only needs the solver is tested in Node against the real modules.
- Anything needing chess.js or the tablebase is tested in the browser against
  the deployed site.
- Prefer checking a new solver against a second implementation over trusting
  one. That is how the King + Pawn solver was verified, and how the missing
  `piece` field on board moves was eventually caught - a test that fabricates
  its inputs will not catch an integration gap.

GitHub Pages takes roughly two to three minutes to deploy after a push.
