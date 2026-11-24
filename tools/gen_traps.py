# Generate "punish the mistake" puzzles for each opening module.
#
# A trap is a move by the opponent, early in one of your lines, that LOOKS
# fine (a shallow search rates it close to the best move) but LOSES (a deep
# search says it gives you a big advantage), and where you have one clear way
# to cash in. The puzzle is: here is the position after their mistake, find
# the punishment.
#
# Usage: STOCKFISH=/path/to/stockfish python3 tools/gen_traps.py modules/london.json raw.json
# then: python3 tools/finish_traps.py raw.json modules/traps/london.json
import sys, json, chess, chess.engine

import os
SF = os.environ.get('STOCKFISH', 'stockfish')   # path to a Stockfish binary
MAX_PLY = 16          # only mistakes within the first 8 moves of each side
SHALLOW = 1           # "looks fine" to a quick glance (captures still checked)
DEEP = 15             # the truth
MEDIUM = 10           # a quick filter before the deep look
LOOKS_FINE = 120      # shallow loss at most this (centipawns)
GIVES_AWAY = 150      # deep loss at least this
YOU_GET = 150         # and you end up at least this much better
UNIQUE_GAP = 120      # best move beats the second best by this much
ACCEPT_WITHIN = 50    # other moves this close to the best also count
MAX_STEPS = 3         # at most three moves of yours per puzzle
SIDELINES = 2         # sound alternatives followed one move deeper
SOUND = 40            # an alternative this close to the best is a sideline, not a mistake

eng = chess.engine.SimpleEngine.popen_uci(SF)
eng.configure({'Threads': 2, 'Hash': 256})

def scores(board, depth, multipv=1, moves=None):
    kw = {'multipv': multipv}
    if moves: kw['root_moves'] = moves
    infos = eng.analyse(board, chess.engine.Limit(depth=depth), **kw)
    if isinstance(infos, dict): infos = [infos]
    return [(x['pv'][0], x['score'].pov(board.turn).score(mate_score=10000), x['pv']) for x in infos]

def values(board):
    v = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}
    return sum(v.get(p.piece_type, 0) * (1 if p.color == chess.WHITE else -1) for p in board.piece_map().values())

def solve(board, me):
    """Your moves for the puzzle: keep going while there is one clear move."""
    steps = []
    b = board.copy()
    while len(steps) < MAX_STEPS and not b.is_game_over():
        top = scores(b, DEEP, multipv=4)
        best_mv, best, pv = top[0]
        second = top[1][1] if len(top) > 1 else -10000
        if steps and best - second < UNIQUE_GAP:
            break                       # the rest is no longer forced: stop here
        accept = [b.san(m) for m, s, _ in top if s >= best - ACCEPT_WITHIN and s >= YOU_GET]
        step = {'play': b.san(best_mv), 'accept': accept, 'eval': best}
        b.push(best_mv)
        if b.is_game_over() or len(pv) < 2:
            steps.append(step); break
        reply = scores(b, DEEP)[0][0]
        step['reply'] = b.san(reply)
        b.push(reply)
        steps.append(step)
    # Drop a trailing reply: the puzzle ends on your move.
    if steps and 'reply' in steps[-1]:
        steps[-1] = {k: v for k, v in steps[-1].items() if k != 'reply'}
    return steps

def label(board, steps, me):
    b = board.copy()
    start = values(b)
    mate = any(abs(s['eval']) >= 9000 for s in steps)
    for s in steps:
        b.push_san(s['play'])
        if 'reply' in s: b.push_san(s['reply'])
    # Let the engine finish the exchanges, then count material from your side.
    if not b.is_game_over():
        pv = scores(b, MEDIUM)[0][2][:4]
        for m in pv:
            if b.is_legal(m): b.push(m)
    gain = (values(b) - start) * (1 if me == chess.WHITE else -1)
    if mate: return 'Checkmate'
    if gain >= 8: return 'Wins the queen'
    if gain >= 4: return 'Wins a rook'
    if gain >= 2: return 'Wins a piece'
    if gain >= 1: return 'Wins a pawn'
    return 'Big advantage'

module = json.load(open(sys.argv[1]))
puzzles, seen = [], set()
for side in ('white', 'black'):
    lines = [l for l in module['lines'] if l['side'] == side]
    if not lines: continue
    me = chess.WHITE if side == 'white' else chess.BLACK
    # Every position in these lines where the OPPONENT is to move.
    nodes = {}
    for l in lines:
        mv = l['moves'].split()
        for i in range(min(len(mv), MAX_PLY)):
            b = chess.Board()
            for s in mv[:i]: b.push_san(s)
            if b.turn != me:
                key = ' '.join(mv[:i])
                nodes.setdefault(key, {'board': b, 'book': set(), 'line': l['name']})
                nodes[key]['book'].add(mv[i])
    # Realistic sidelines: where the opponent leaves the book with a sound
    # move and you answer well, they can still go wrong a move later.
    for key, node in list(nodes.items()):
        b = node['board']
        alts = [(m, sc) for m, sc, _ in scores(b, MEDIUM, multipv=6) if b.san(m) not in node['book']]
        best_here = scores(b, MEDIUM)[0][1]
        for m, sc in alts[:SIDELINES]:
            if best_here - sc > SOUND: continue
            after = b.copy(); after.push(m)
            if after.is_game_over(): continue
            reply = scores(after, MEDIUM)[0][0]
            side_key = (key + ' ' + b.san(m) + ' ' + after.san(reply)).strip()
            after.push(reply)
            if after.is_game_over() or side_key in nodes: continue
            nodes[side_key] = {'board': after, 'book': set(), 'line': node['line'] + ' (sideline)'}
    print(side, len(nodes), 'positions to search', flush=True)
    for key, node in nodes.items():
        b = node['board']
        legal = list(b.legal_moves)
        quick = {m: s for m, s, _ in scores(b, SHALLOW, multipv=len(legal))}
        quick_best = max(quick.values())
        deep_best = scores(b, DEEP)[0][1]
        for m in legal:
            san = b.san(m)
            if san in node['book'] or quick_best - quick.get(m, -10000) > LOOKS_FINE:
                continue
            after = b.copy(); after.push(m)
            if after.fen() in seen: continue
            # Cheap first look: most moves are simply fine.
            if scores(after, MEDIUM)[0][1] < YOU_GET - 60:
                continue
            top = scores(after, DEEP, multipv=2)
            yours = top[0][1]
            if deep_best + yours < GIVES_AWAY or yours < YOU_GET:   # their loss = deep_best - (-yours)
                continue
            if len(top) > 1 and yours - top[1][1] < UNIQUE_GAP:
                continue
            steps = solve(after, me)
            if not steps: continue
            seen.add(after.fen())
            prefix = (key + ' ' + san).strip().split()
            puzzles.append({
                'id': f"{module['id']}-{len(puzzles) + 1}",
                'side': side,
                'line': node['line'],
                'moves': ' '.join(prefix),       # up to and including their mistake
                'mistake': san,
                'steps': steps,
                'theme': label(after, steps, me),
            })
            print(f"  {' '.join(prefix)}?  ->  {' '.join(s['play'] for s in steps)}  [{puzzles[-1]['theme']}]", flush=True)

json.dump({'module': module['id'], 'puzzles': puzzles}, open(sys.argv[2], 'w'), indent=1)
print(len(puzzles), 'puzzles')
eng.quit()
