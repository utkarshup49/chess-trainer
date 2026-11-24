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
const moveNo = ply => `${Math.floor(ply / 2) + 1}${ply % 2 ? '…' : '.'}`;

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

function describe(c, game) {
  const at = ply => moveNo(ply);
  switch (c.status) {
    case 'complete': return `Followed "${c.line.name}" to the end.`;
    case 'short': return `Game ended while still in "${c.line.name}".`;
    case 'you': return `You left "${c.line.name}" at ${at(c.ply)} ${c.played}; your line plays ${c.expected.join(' or ')}.`;
    case 'them': return `Opponent left "${c.line.name}" at ${at(c.ply)} ${c.played}.`;
    case 'other': return `You played ${at(c.ply)} ${game.moves[c.ply]}, which isn't in any of your repertoires.`;
    case 'uncovered': return `Opponent played ${at(c.ply)} ${game.moves[c.ply]}: no ${game.you === 'white' ? 'White' : 'Black'} repertoire covers it yet.`;
    case 'unknown': return 'Which side were you? Set your name above to match.';
    default: return 'No repertoire for this colour yet.';
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
    // Per opening: how far you usually get.
    const perModule = this.modules.map(m => {
      const rows = relevant.filter(x => x.c.module && x.c.module.id === m.id && !['other', 'uncovered'].includes(x.c.status));
      if (!rows.length) return '';
      const n = s => rows.filter(x => x.c.status === s).length;
      const avg = rows.reduce((a, x) => a + x.c.ply, 0) / rows.length / 2;
      return `<tr><td>${escapeHtml(m.title)}</td><td>${rows.length}</td><td>${avg.toFixed(1)}</td><td>${n('you')}</td><td>${n('them')}</td><td>${n('complete') + n('short')}</td></tr>`;
    }).join('');

    // Where YOU leave the lines, most common first.
    const yours = group(relevant.filter(x => x.c.status === 'you'), x => `${x.c.module.id}|${x.c.ply}|${x.c.played}`);
    const yourHtml = yours.map(list => {
      const { c, g } = list[0];
      const idx = this.checked.indexOf(list[0]);
      return `<li><p><b>${moveNo(c.ply)} ${escapeHtml(c.played)}</b> instead of <b>${escapeHtml(c.expected.join(' or '))}</b> in ${escapeHtml(c.module.title)}: "${escapeHtml(c.line.name)}" · ${list.length} game${list.length > 1 ? 's' : ''}</p>
        <div class="actions"><a class="button" href="#/m/${c.module.id}/study/${c.line.id}">Relearn the line</a><button type="button" data-analyse="${idx}" data-ply="${c.ply}">See the position</button></div></li>`;
    }).join('');

    // Where opponents leave the lines.
    const theirs = group(relevant.filter(x => x.c.status === 'them'), x => `${x.c.module.id}|${x.g.moves.slice(0, x.c.ply + 1).join(' ')}`);
    const theirHtml = theirs.map(list => {
      const { c, g } = list[0];
      const idx = this.checked.indexOf(list[0]);
      const prefix = g.moves.slice(0, c.ply + 1).join(' ');
      const puzzle = (this.traps[c.module.id] || []).find(p => p.moves === prefix);
      return `<li><p><b>${moveNo(c.ply)} ${escapeHtml(c.played)}</b> in ${escapeHtml(c.module.title)}: "${escapeHtml(c.line.name)}" · ${list.length} game${list.length > 1 ? 's' : ''}</p>
        <div class="actions">
          ${puzzle ? `<a class="button primary" href="#/traps/${c.module.id}/${puzzle.id}">It's a known mistake: solve the puzzle</a>` : ''}
          <button type="button" data-engine="${idx}">Was it a mistake? Did I punish it?</button>
          <button type="button" data-analyse="${idx}" data-ply="${c.ply + 1}">See the position</button>
        </div><p class="meta" id="engine-${idx}"></p></li>`;
    }).join('');

    // Openings you meet that your repertoire doesn't cover.
    const gaps = group(relevant.filter(x => x.c.status === 'uncovered' || x.c.status === 'other'),
      x => `${x.g.you}|${x.c.status}|${x.g.moves.slice(0, x.c.ply + 1).join(' ')}`);
    const gapHtml = gaps.map(list => {
      const { c, g } = list[0];
      const moves = g.moves.slice(0, c.ply + 1).map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}.${m}` : m)).join(' ');
      return `<li>${c.status === 'other' ? 'You played' : 'Facing'} <b>${escapeHtml(moves)}</b> as ${g.you === 'white' ? 'White' : 'Black'} · ${list.length} game${list.length > 1 ? 's' : ''}</li>`;
    }).join('');

    const rows = checked.slice(0, 60).map((x, i) => {
      const { g, c } = x;
      const when = new Date(g.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const opp = g.you === 'white' ? g.black : g.you === 'black' ? g.white : `${g.white} vs ${g.black}`;
      const won = (g.result === '1-0' && g.you === 'white') || (g.result === '0-1' && g.you === 'black');
      const lost = (g.result === '0-1' && g.you === 'white') || (g.result === '1-0' && g.you === 'black');
      const tone = won ? 'good' : lost ? 'bad' : 'idle';
      const ply = c.ply !== undefined ? c.ply : 0;
      return `<li class="game-row">
        <div><p><b>vs ${escapeHtml(opp)}</b> <span class="meta">${when} · ${escapeHtml(g.source)}${g.speed ? ' · ' + escapeHtml(g.speed) : ''}</span>
          <span class="chip" data-tone="${tone}">${won ? 'Won' : lost ? 'Lost' : g.result === '½-½' ? 'Draw' : g.result}</span></p>
          <p class="meta">${escapeHtml(describe(c, g))}</p></div>
        <button type="button" data-analyse="${i}" data-ply="${Math.min(g.moves.length, ply + 1)}">Analyse</button>
      </li>`;
    }).join('');

    return `
      ${perModule ? `<section class="portal"><h2>Your repertoire in real games</h2>
        <div class="table-scroll"><table class="review-table">
          <thead><tr><th>Opening</th><th>Games</th><th>Moves in book</th><th>You left it</th><th>They left it</th><th>To the end</th></tr></thead>
          <tbody>${perModule}</tbody></table></div></section>` : ''}
      ${yourHtml ? `<section class="portal"><h2>Where you leave your lines</h2><p class="meta">These are the moves to fix first.</p><ol class="insight-list">${yourHtml}</ol></section>` : ''}
      ${theirHtml ? `<section class="portal"><h2>Where opponents leave your lines</h2><p class="meta">Check whether their move was a mistake, and whether you punished it.</p><ol class="insight-list">${theirHtml}</ol></section>` : ''}
      ${gapHtml ? `<section class="portal"><h2>Openings your repertoire doesn't cover</h2><ol class="insight-list">${gapHtml}</ol></section>` : ''}
      <section class="portal"><h2>Games</h2><ol class="line-list games-list">${rows}</ol>
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
