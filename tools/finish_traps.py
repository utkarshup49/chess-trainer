# Tidy the raw puzzles from gen_traps.py into the file the site reads:
# replay every puzzle to make sure it is legal, keep at most two puzzles that
# share a position and a first move, name the prize from the final engine
# score, and number them.
# Usage: python3 tools/finish_traps.py raw.json modules/traps/<module>.json
import sys, json, chess

raw = json.load(open(sys.argv[1]))
out, per_pattern = [], {}
for p in raw['puzzles']:
    b = chess.Board()
    for m in p['moves'].split():
        b.push_san(m)
    ok = True
    for s in p['steps']:
        for a in s['accept']:
            b.parse_san(a)              # raises if illegal
        b.push_san(s['play'])
        if 'reply' in s:
            b.push_san(s['reply'])
    pattern = (' '.join(p['moves'].split()[:-1]), p['steps'][0]['play'])
    per_pattern[pattern] = per_pattern.get(pattern, 0) + 1
    if per_pattern[pattern] > 2:
        continue
    ev = p['steps'][-1]['eval']
    p['theme'] = ('Checkmate' if abs(ev) >= 9000 else
                  'Decisive advantage' if ev >= 600 else
                  'Wins material' if ev >= 250 else 'Clear advantage')
    p['id'] = f"{raw['module']}-{len(out) + 1}"
    out.append(p)
json.dump({'module': raw['module'], 'puzzles': out}, open(sys.argv[2], 'w'), indent=1)
print(len(raw['puzzles']), 'raw ->', len(out), 'puzzles')
