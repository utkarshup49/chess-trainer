// Service worker: makes Chess Gym installable and lets it run offline.
//
// - Our own files: network first, so a new version shows up as soon as you
//   are online; the saved copy is used when the network is down or slow.
// - Library files from the CDNs (board, rules, engine, fonts): saved once and
//   served from the cache, because their URLs carry exact versions and never
//   change.
// - Anything else (the Lichess tablebase) goes straight to the network.
//
// Everything listed below is saved when the app is installed, so the openings,
// the bot, the game review and the King + Pawn drills work with no connection
// even before you have opened them. Add new files to APP_FILES.

const CACHE = 'chess-gym-v1';
const NETWORK_TIMEOUT_MS = 4000;
const CDN_TIMEOUT_MS = 30000;

const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'js/app.js', 'js/bankbuild.js', 'js/board.js', 'js/bot.js', 'js/coach.js',
  'js/endgame.js', 'js/engine.js', 'js/games.js', 'js/kpgen.js', 'js/kpk.js',
  'js/opening.js', 'js/oracle.js', 'js/play.js', 'js/progress.js', 'js/race.js',
  'js/review.js', 'js/study.js', 'js/tbdrill.js', 'js/tbgen.js',
  'modules/index.json', 'modules/banks.json',
  'modules/qg-traps.json', 'modules/london.json', 'modules/caro-kann.json',
  'modules/sicilian-dragon.json', 'modules/kp-endgames.json',
  'modules/pawn-endgames-2.json', 'modules/rook-endgames.json',
  'modules/queen-vs-pawn.json', 'modules/fortresses.json',
];

const CDN_FILES = [
  'https://cdn.jsdelivr.net/npm/chessground@9.2.1/+esm',
  'https://cdn.jsdelivr.net/npm/chess.js@1.0.0/+esm',
  'https://cdn.jsdelivr.net/npm/chessground@9.2.1/assets/chessground.base.css',
  'https://cdn.jsdelivr.net/npm/chessground@9.2.1/assets/chessground.brown.css',
  'https://cdn.jsdelivr.net/npm/chessground@9.2.1/assets/chessground.cburnett.css',
  'https://unpkg.com/stockfish@19.0.1/bin/stockfish-19-lite-single.js',
  'https://unpkg.com/stockfish@19.0.1/bin/stockfish-19-lite-single.wasm',
];
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap';

const CDN_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// Save one CDN file. jsDelivr's "+esm" modules can import more files from
// jsDelivr, and the font sheet points at font files, so save those too.
async function saveCdn(cache, url, seen = new Set()) {
  if (seen.has(url)) return;
  seen.add(url);
  // Never let a slow CDN hold up the install for long.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDN_TIMEOUT_MS);
  const res = await fetch(url, { mode: 'cors', signal: controller.signal }).finally(() => clearTimeout(timer));
  if (!res.ok) throw new Error('could not fetch ' + url);
  await cache.put(url, res.clone());
  if (url.includes('+esm')) {
    const code = await res.text();
    const imports = code.match(/["'](\/npm\/[^"']+)["']/g) || [];
    await Promise.all(imports.map(m => saveCdn(cache, 'https://cdn.jsdelivr.net' + m.slice(1, -1), seen)));
  }
  if (url.startsWith('https://fonts.googleapis.com/')) {
    const css = await res.text();
    const fonts = css.match(/https:\/\/fonts\.gstatic\.com\/[^)'"]+/g) || [];
    await Promise.all(fonts.map(f => saveCdn(cache, f, seen)));
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Our own files must all be saved, or the install fails and is retried.
    await cache.addAll(APP_FILES.map(f => new Request(f, { cache: 'reload' })));
    // Library files: try each; a failure here only means it is saved later,
    // the first time the page uses it.
    await Promise.allSettled([...CDN_FILES, FONT_CSS].map(url => saveCdn(cache, url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(event));
  } else if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req));
  }
  // Anything else (the tablebase) is left to the browser.
});

async function networkFirst(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  // A page load is always the app itself: '#/...' routes are not sent to us.
  const key = req.mode === 'navigate' ? './' : req;
  const fromNetwork = fetch(req).then(res => {
    if (res.ok) event.waitUntil(cache.put(key, res.clone()));
    return res;
  });
  fromNetwork.catch(() => {}); // a failure is handled below
  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const res = await Promise.race([fromNetwork, timeout]);
    if (res) return res;
  } catch (e) {
    // offline: fall through to the saved copy
  }
  const saved = await cache.match(key, { ignoreSearch: true });
  if (saved) return saved;
  return fromNetwork; // nothing saved: let the network answer (or fail) in its own time
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req.url);
  if (saved) return saved;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req.url, res.clone());
  return res;
}
