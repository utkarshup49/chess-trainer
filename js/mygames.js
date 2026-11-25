// My games: fetch your recent games from Lichess or Chess.com (or paste a
// PGN), and check each one against your opening repertoire: where you left
// your lines, where your opponents did, and which openings you meet that your
// repertoire doesn't cover yet.
import { Chess } from './board.js';
import { openInAnalysis } from './handoff.js';
import { getEngine } from './engine.js';

const KEY = 'chess-gym-imports-v1';
const MAX_KEEP = 200;
const FETCH_GAMES = 40;
const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { games: [], users: {} }; } catch (e) { return { games: [], users: {} }; }
}
function save(data) {
  data.games = data.games.sort((a, b) => b.date - a.date).slice(0, MAX_KEEP);
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* not kept */ }
}
function addGames(games) {
  const data = load();
  const known = new Set(data.games.map(g => g.id));
  const fresh = games.filter(g => !known.has(g.id));
  data.games.push(...fresh);
  save(data);
  return fresh.length;
}

// ---------- Fetching ----------
async function fetchLichess(user) {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=${FETCH_GAMES}&moves=true&opening=true`;
  const res = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });
  if (res.status === 404) throw new Error(`Lichess has no player called ${user}.`);
  if (!res.ok) throw new Error(`Lichess answered ${res.status}. Try again in a minute.`);
  const text = await res.text();
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(g => g.variant === 'standard' && g.moves)
    .map(g => {
      const w = (g.players.white.user || {}).name || 'Anonymous';
      const b = (g.players.black.user || {}).name || 'Anonymous';
      const you = w.toLowerCase() === user.toLowerCase() ? 'white' : b.toLowerCase() === user.toLowerCase() ? 'black' : null;
      return {
        id: 'li-' + g.id, source: 'Lichess', url: `https://lichess.org/${g.id}`, date: g.createdAt,
        white: w, black: b, you, speed: g.speed,
        result: g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '½-½',
        moves: g.moves.split(' '),
      };
    });
}

async function fetchChessCom(user) {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games`;
  const res = await fetch(`${base}/archives`);
  if (res.status === 404) throw new Error(`Chess.com has no player called ${user}.`);
  if (!res.ok) throw new Error(`Chess.com answered ${res.status}. Try again later, or paste a PGN instead.`);
  const { archives } = await res.json();
  const games = [];
  // Newest months first, until we have enough games.
  for (const url of archives.slice().reverse().slice(0, 3)) {
    const month = await fetch(url).then(r => (r.ok ? r.json() : { games: [] }));
    games.push(...month.games.slice().reverse());
    if (games.length >= FETCH_GAMES) break;
  }
  return games.filter(g => g.rules === 'chess' && g.pgn).slice(0, FETCH_GAMES).map(g => {
    const moves = movesFromPgn(g.pgn);
    const w = g.white.username, b = g.black.username;
    const res = g.white.result === 'win' ? '1-0' : g.black.result === 'win' ? '0-1' : '½-½';
    return {
      id: 'cc-' + (g.uuid || g.url), source: 'Chess.com', url: g.url, date: g.end_time * 1000,
      white: w, black: b, you: w.toLowerCase() === user.toLowerCase() ? 'white' : 'black',
      speed: g.time_class, result: res, moves,
    };
  }).filter(g => g.moves.length);
}

function movesFromPgn(pgn) {
  try {
    const g = new Chess();
    g.loadPgn(pgn);
    return g.history();
  } catch (e) {
    return [];
  }
}

// Several games pasted at once: split before each [Event tag, or on blank
// lines between move texts.
function parsePastedPgn(text, yourName) {
  const chunks = text.includes('[Event') ? text.split(/(?=\[Event )/) : [text];
  return chunks.map((chunk, i) => {
    if (!chunk.trim()) return null;
    const moves = movesFromPgn(chunk);
    if (!moves.length) return null;
    const tag = name => ((chunk.match(new RegExp(`\\[${name} "([^"]*)"\\]`)) || [])[1] || '');
    const white = tag('White') || 'White', black = tag('Black') || 'Black';
    const name = (yourName || '').toLowerCase();
    const you = name && white.toLowerCase() === name ? 'white' : name && black.toLowerCase() === name ? 'black' : null;
    const date = Date.parse((tag('UTCDate') || tag('Date') || '').replace(/\./g, '-')) || Date.now() - i;
    return { id: 'pgn-' + hash(chunk), source: 'PGN', url: '', date, white, black, you, speed: '', result: tag('Result') || '*', moves };
  }).filter(Boolean);
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------- Checking a game against the repertoire ----------
// Walk the game through every opening module you play with that colour and
// keep the one that follows the game furthest.
export function checkGame(game, modules) {
  if (!game.you) return { status: 'unknown' };
  let best = null;
  for (const m of modules) {
    const lines = m.lines.filter(l => l.side === game.you).map(l => ({ ...l, list: l.moves.split(' ') }));
    if (!lines.length) continue;
    let ply = 0;
    let result = null;
    while (true) {
      const still = lines.filter(l => l.list.length >= ply && game.moves.slice(0, ply).every((mv, i) => l.list[i] === mv));
      const going = still.filter(l => l.list.length > ply);
      if (!going.length) { result = { status: 'complete', module: m, line: still[0] || lines[0], ply }; break; }
      if (ply >= game.moves.length) { result = { status: 'short', module: m, line: going[0], ply }; break; }
      const expected = [...new Set(going.map(l => l.list[ply]))];
      if (!expected.includes(game.moves[ply])) {
        const mover = ply % 2 === 0 ? 'white' : 'black';
        result = { status: mover === game.you ? 'you' : 'them', module: m, line: going[0], ply, played: game.moves[ply], expected };
        break;
      }
      ply += 1;
    }
    if (!best || result.ply > best.ply) best = result;
  }
  if (!best) return { status: 'none' };
  // Left on the very first move: this game isn't in your repertoire at all.
  if (best.ply === 0 || (best.ply === 1 && best.status === 'you' && game.you === 'black')) {
    return { ...best, status: best.status === 'you' ? 'other' : 'uncovered' };
  }
  return best;
}

// "4.Nf3" for White's 4th move, "4...Nf6" for Black's.
const withNo = (ply, san) => `${Math.floor(ply / 2) + 1}${ply % 2 ? '...' : '.'}${san}`;
// "1.d4 d5 2.Bf4 c5 3.e3": the moves before a point in the game.
function movesText(moves, upto) {
  return moves.slice(0, upto).map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}.${m}` : m)).join(' ');
}

function describe(c, game) {
  const yourSide = game.you === 'white' ? 'White' : 'Black';
  switch (c.status) {
    case 'complete': return `You both followed "${c.line.name}" to the end of your preparation.`;
    case 'short': return `The game ended while you were still in "${c.line.name}".`;
    case 'you': return `On move ${Math.floor(c.ply / 2) + 1} you played ${withNo(c.ply, c.played)}, but your line plays ${c.expected.map(e => withNo(c.ply, e)).join(' or ')}.`;
    case 'them': return `On move ${Math.floor(c.ply / 2) + 1} your opponent played ${withNo(c.ply, c.played)}, a move your lines don't cover.`;
    case 'other': return `You played ${withNo(c.ply, game.moves[c.ply])}, which isn't in any of your ${yourSide} repertoires.`;
    case 'uncovered': return `Your opponent played ${withNo(c.ply, game.moves[c.ply])}: none of your ${yourSide} repertoires cover it yet.`;
    case 'unknown': return 'Which side were you? Put your name in the box above so it matches the PGN.';
    default: return `You have no ${yourSide} repertoire yet.`;
  }
}

export class MyGames {
  constructor(container, modules, trapsByModule) {
    this.container = container;
    this.modules = modules;
    this.traps = trapsByModule; // { moduleId: [puzzles] }
    this.render();
  }

  destroy() {}

  render() {
    const data = load();
    const users = data.users || {};
    const games = data.games;
    const checked = games.map(g => ({ g, c: checkGame(g, this.modules) }));
    this.checked = checked;
    this.container.innerHTML = `
      <section class="module">
        <a class="crumb" href="#/">← Home</a>
        <header class="module-head">
          <p class="eyebrow">My games</p>
          <h1>Your games against your repertoire</h1>
          <p class="lede">Fetch your recent games and see where you left your lines, where opponents did, and which openings you meet that you haven't prepared.</p>
        </header>
        <section class="portal">
          <h2>Fetch games</h2>
          <div class="import-row">
            <label>Lichess username <input id="li-user" value="${escapeHtml(users.lichess || '')}" autocomplete="off" spellcheck="false"></label>
            <button type="button" class="primary" id="btn-li">Fetch from Lichess</button>
          </div>
          <div class="import-row">
            <label>Chess.com username <input id="cc-user" value="${escapeHtml(users.chesscom || '')}" autocomplete="off" spellcheck="false"></label>
            <button type="button" class="primary" id="btn-cc">Fetch from Chess.com</button>
          </div>
          <details class="line-picker">
            <summary>Or paste a PGN</summary>
            <textarea id="pgn" rows="6" placeholder="Paste one or more games in PGN"></textarea>
            <div class="import-row">
              <label>Your name in the PGN <input id="pgn-name" value="${escapeHtml(users.pgn || users.lichess || users.chesscom || '')}" autocomplete="off"></label>
              <button type="button" id="btn-pgn">Add games</button>
            </div>
          </details>
          <p class="meta" id="import-msg">${games.length ? `${games.length} games saved in this browser.` : 'Your games stay in this browser; nothing is uploaded.'}</p>
        </section>
        ${games.length ? this.reportHtml(checked) : ''}
      </section>`;
    const $ = id => this.container.querySelector('#' + id);
    $('btn-li').onclick = () => this.fetch('lichess', $('li-user').value.trim());
    $('btn-cc').onclick = () => this.fetch('chesscom', $('cc-user').value.trim());
    $('btn-pgn').onclick = () => this.paste($('pgn').value, $('pgn-name').value.trim());
    this.container.querySelectorAll('[data-analyse]').forEach(b => {
      b.onclick = () => {
        const { g } = this.checked[Number(b.dataset.analyse)];
        openInAnalysis(g.moves, g.you || 'white', Number(b.dataset.ply));
      };
    });
    this.container.querySelectorAll('[data-engine]').forEach(b => { b.onclick = () => this.engineCheck(Number(b.dataset.engine), b); });
    const clear = $('btn-clear');
    if (clear) clear.onclick = () => { const d = load(); d.games = []; save(d); this.render(); };
  }

  async fetch(source, user) {
    const msg = this.container.querySelector('#import-msg');
    if (!user) { msg.textContent = 'Type your username first.'; return; }
    msg.textContent = `Fetching your last ${FETCH_GAMES} games…`;
    try {
      const games = source === 'lichess' ? await fetchLichess(user) : await fetchChessCom(user);
      const data = load();
      data.users = { ...(data.users || {}), [source]: user };
      save(data);
      const added = addGames(games);
      this.render();
      this.container.querySelector('#import-msg').textContent = `${games.length} games fetched, ${added} new.`;
    } catch (e) {
      msg.textContent = e instanceof TypeError
        ? `Couldn't reach ${source === 'lichess' ? 'Lichess' : 'Chess.com'} (offline, or the site blocked the request). You can paste a PGN instead.`
        : e.message;
    }
  }

  paste(text, name) {
    const games = parsePastedPgn(text, name);
    const data = load();
    data.users = { ...(data.users || {}), pgn: name };
    save(data);
    const added = addGames(games);
    this.render();
    this.container.querySelector('#import-msg').textContent = games.length ? `${games.length} games read, ${added} new.` : 'No games found in that text.';
  }

  reportHtml(checked) {
    const relevant = checked.filter(x => !['unknown', 'none'].includes(x.c.status));
    const games = n => `${n} game${n === 1 ? '' : 's'}`;
    const idxOf = x => this.checked.indexOf(x);

    // One card per opening: how far your preparation carried you.
    const perModule = this.modules.map(m => {
      const rows = relevant.filter(x => x.c.module && x.c.module.id === m.id && !['other', 'uncovered'].includes(x.c.status));
      if (!rows.length) return '';
      const n = s => rows.filter(x => x.c.status === s).length;
      const avg = rows.reduce((a, x) => a + x.c.ply, 0) / rows.length / 2;
      return `
        <article class="card">
          <div class="card-head"><h3>${escapeHtml(m.title)}</h3><span class="chip">${games(rows.length)}</span></div>
          <p class="meta">On average the game stayed in your prepared moves for <b>${avg.toFixed(1)} moves</b>.</p>
          <div class="tiles">
            <div class="tile bad"><b>${n('you')}</b><span>you left your moves first</span></div>
            <div class="tile warn"><b>${n('them')}</b><span>your opponent left them first</span></div>
            <div class="tile good"><b>${n('complete') + n('short')}</b><span>followed your line to the end</span></div>
          </div>
        </article>`;
    }).join('');

    // Your own slips, most frequent first.
    const yours = group(relevant.filter(x => x.c.status === 'you'), x => `${x.c.module.id}|${x.c.ply}|${x.c.played}`);
    const yourHtml = yours.map(list => {
      const x = list[0];
      const { c, g } = x;
      const before = movesText(g.moves, c.ply);
      return `
        <article class="card">
          <div class="card-head"><h3>Move ${Math.floor(c.ply / 2) + 1} as ${g.you === 'white' ? 'White' : 'Black'}</h3><span class="chip" data-tone="bad">${list.length === 1 ? 'once' : list.length + ' times'}</span></div>
          <p>${before ? `After <span class="mono">${escapeHtml(before)}</span>, you` : 'You'} played <b class="mono">${escapeHtml(withNo(c.ply, c.played))}</b>. Your line plays <b class="mono">${escapeHtml(c.expected.map(e => withNo(c.ply, e)).join(' or '))}</b>.</p>
          <p class="meta">${escapeHtml(c.module.title)} · ${escapeHtml(c.line.name)}</p>
          <div class="actions"><a class="button primary" href="#/m/${c.module.id}/study/${c.line.id}">Relearn the line</a><button type="button" data-analyse="${idxOf(x)}" data-ply="${c.ply}">See the position</button></div>
        </article>`;
    }).join('');

    // Where opponents leave your lines.
    const theirs = group(relevant.filter(x => x.c.status === 'them'), x => `${x.c.module.id}|${x.g.moves.slice(0, x.c.ply + 1).join(' ')}`);
    const theirHtml = theirs.map(list => {
      const x = list[0];
      const { c, g } = x;
      const idx = idxOf(x);
      const before = movesText(g.moves, c.ply);
      const prefix = g.moves.slice(0, c.ply + 1).join(' ');
      const puzzle = (this.traps[c.module.id] || []).find(p => p.moves === prefix);
      return `
        <article class="card">
          <div class="card-head"><h3>Move ${Math.floor(c.ply / 2) + 1}: they played ${escapeHtml(c.played)}</h3><span class="chip" data-tone="warn">${list.length === 1 ? 'once' : list.length + ' times'}</span></div>
          <p>${before ? `After <span class="mono">${escapeHtml(before)}</span>, your` : 'Your'} opponent played <b class="mono">${escapeHtml(withNo(c.ply, c.played))}</b>. Your lines expected <span class="mono">${escapeHtml(c.expected.map(e => withNo(c.ply, e)).join(' or '))}</span>.</p>
          <p class="meta">${escapeHtml(c.module.title)} · ${escapeHtml(c.line.name)}</p>
          <div class="actions">
            ${puzzle ? `<a class="button primary" href="#/traps/${c.module.id}/${puzzle.id}">Known mistake: solve the puzzle</a>` : ''}
            <button type="button" data-engine="${idx}">Was it a mistake? Did I punish it?</button>
            <button type="button" data-analyse="${idx}" data-ply="${c.ply + 1}">See the position</button>
          </div>
          <p class="meta engine-out" id="engine-${idx}"></p>
        </article>`;
    }).join('');

    // Openings you meet that your repertoire doesn't cover.
    const gaps = group(relevant.filter(x => x.c.status === 'uncovered' || x.c.status === 'other'),
      x => `${x.g.you}|${x.c.status}|${x.g.moves.slice(0, x.c.ply + 1).join(' ')}`);
    const gapHtml = gaps.map(list => {
      const { c, g } = list[0];
      return `
        <article class="card">
          <div class="card-head"><h3 class="mono">${escapeHtml(movesText(g.moves, c.ply + 1))}</h3><span class="chip">${list.length === 1 ? 'once' : list.length + ' times'}</span></div>
          <p class="meta">${c.status === 'other' ? 'You chose a different opening' : 'Your opponent chose an opening you have not prepared'} as ${g.you === 'white' ? 'White' : 'Black'}.</p>
        </article>`;
    }).join('');

    const rows = checked.slice(0, 60).map((x, i) => {
      const { g, c } = x;
      const when = new Date(g.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const opp = g.you === 'white' ? g.black : g.you === 'black' ? g.white : `${g.white} vs ${g.black}`;
      const won = (g.result === '1-0' && g.you === 'white') || (g.result === '0-1' && g.you === 'black');
      const lost = (g.result === '0-1' && g.you === 'white') || (g.result === '1-0' && g.you === 'black');
      const tone = won ? 'good' : lost ? 'bad' : 'idle';
      const ply = c.ply !== undefined ? c.ply : 0;
      return `
        <article class="card game-card ${tone}">
          <div class="card-head">
            <h3>vs ${escapeHtml(opp)} <span class="meta">as ${g.you === 'white' ? 'White' : g.you === 'black' ? 'Black' : '?'}</span></h3>
            <span class="chip" data-tone="${tone}">${won ? 'Won' : lost ? 'Lost' : g.result === '½-½' ? 'Draw' : escapeHtml(g.result)}</span>
          </div>
          <p class="meta">${when} · ${escapeHtml(g.source)}${g.speed ? ' · ' + escapeHtml(g.speed) : ''}${c.module && !['other', 'uncovered'].includes(c.status) ? ' · ' + escapeHtml(c.module.title) : ''}</p>
          <p>${escapeHtml(describe(c, g))}</p>
          <div class="actions"><button type="button" data-analyse="${i}" data-ply="${Math.min(g.moves.length, ply + 1)}">Analyse</button>${g.url ? `<a class="button" href="${escapeHtml(g.url)}" target="_blank" rel="noopener">Open on ${escapeHtml(g.source)}</a>` : ''}</div>
        </article>`;
    }).join('');

    return `
      ${perModule ? `<section class="portal"><h2>Your openings in real games</h2>
        <p class="meta">Each game is followed move by move through your prepared lines until someone plays a move that isn't in them.</p>
        <div class="cards">${perModule}</div></section>` : ''}
      ${yourHtml ? `<section class="portal"><h2>Your slips</h2><p class="meta">Moves where you left your own preparation. Fix these first.</p><div class="cards">${yourHtml}</div></section>` : ''}
      ${theirHtml ? `<section class="portal"><h2>Your opponents' surprises</h2><p class="meta">Moves where opponents left your lines. Check whether each was a mistake, and whether you punished it.</p><div class="cards">${theirHtml}</div></section>` : ''}
      ${gapHtml ? `<section class="portal"><h2>Openings you haven't prepared</h2><div class="cards">${gapHtml}</div></section>` : ''}
      <section class="portal"><h2>Games</h2><div class="cards">${rows}</div>
        <button type="button" class="small-link" id="btn-clear">Forget all saved games</button></section>`;
  }

  // Engine check of an opponent's departure: was it a mistake, and did your
  // next move make the most of it?
  async engineCheck(idx, button) {
    const { g, c } = this.checked[idx];
    const out = this.container.querySelector('#engine-' + idx);
    button.disabled = true;
    out.textContent = 'Thinking…';
    try {
      const engine = await getEngine();
      const fenAt = ply => { const x = new Chess(); g.moves.slice(0, ply).forEach(m => x.move(m)); return x.fen(); };
      const sign = g.you === 'white' ? 1 : -1;
      const before = sign * (await engine.evaluate(fenAt(c.ply), 14)).score;
      const afterTheirs = await engine.evaluate(fenAt(c.ply + 1), 14);
      const after = sign * afterTheirs.score;
      const gift = after - before;
      let text = gift >= 100
        ? `Yes: their ${c.played} handed you about ${(gift / 100).toFixed(1)} pawns (you went from ${pawns(before)} to ${pawns(after)}).`
        : gift >= 40 ? `A small inaccuracy (${pawns(before)} to ${pawns(after)} for you).`
          : `No, ${c.played} is a reasonable move (${pawns(after)} for you).`;
      if (g.moves.length > c.ply + 1) {
        const reply = sign * (await engine.evaluate(fenAt(c.ply + 2), 14)).score;
        const bestSan = afterTheirs.best ? new Chess(fenAt(c.ply + 1)).move({ from: afterTheirs.best.slice(0, 2), to: afterTheirs.best.slice(2, 4), promotion: afterTheirs.best[4] }).san : '';
        const yourMove = g.moves[c.ply + 1];
        if (reply >= after - 50) text += ` Your ${yourMove} kept it (${pawns(reply)}).`;
        else text += ` Your ${yourMove} let it slip to ${pawns(reply)}; best was ${bestSan}.`;
      }
      out.textContent = text;
    } catch (e) {
      out.textContent = e.message;
    }
    button.disabled = false;
  }
}

const pawns = cp => (Math.abs(cp) >= 9000 ? (cp > 0 ? 'a winning mate' : 'getting mated') : (cp > 0 ? '+' : '') + (cp / 100).toFixed(1));

function group(list, keyOf) {
  const map = new Map();
  for (const x of list) {
    const k = keyOf(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return [...map.values()].sort((a, b) => b.length - a.length).slice(0, 12);
}
