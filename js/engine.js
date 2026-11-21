// Stockfish in the browser, used by the practice bot and the game review.
//
// The engine is the "lite, single-threaded" WebAssembly build of Stockfish
// (stockfish.js by Nathan Rugg, GPLv3), loaded from the unpkg CDN. jsDelivr
// refuses this package because the whole npm package is over its 150 MB limit.
// The lite build needs no special server headers, so it runs on GitHub Pages.
//
// A worker can't be started straight from another site's URL, so the page
// fetches the engine's script and .wasm file itself (the service worker keeps
// copies, so this works offline) and starts the worker from blob URLs. The
// engine looks for its .wasm file in the part of the worker's URL after '#',
// so the .wasm blob URL goes there.

const BUILDS = [
  'https://unpkg.com/stockfish@19.0.1/bin/stockfish-19-lite-single.js',
  'https://unpkg.com/stockfish@18.0.5/bin/stockfish-18-lite-single.js',
];
const START_TIMEOUT_MS = 30000;

let shared = null; // one engine for the whole site

// Start the engine (once) and resolve when it is ready for commands.
export function getEngine() {
  if (!shared) {
    shared = Engine.start().catch(err => {
      shared = null; // let a later call try again
      throw err;
    });
  }
  return shared;
}

export class Engine {
  static async start() {
    let lastError;
    for (const js of BUILDS) {
      try {
        const engine = await Engine.load(js);
        await engine.ready();
        return engine;
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error('The chess engine could not be loaded. Check your connection and try again. (' + (lastError && lastError.message) + ')');
  }

  // The engine files are fetched by the page (so the service worker can keep
  // them for offline use) and handed to the worker as blob URLs.
  static async load(jsUrl) {
    const wasmUrl = jsUrl.replace(/\.js$/, '.wasm');
    const [code, wasm] = await Promise.all([
      fetch(jsUrl).then(r => { if (!r.ok) throw new Error('engine script ' + r.status); return r.text(); }),
      fetch(wasmUrl).then(r => { if (!r.ok) throw new Error('engine binary ' + r.status); return r.arrayBuffer(); }),
    ]);
    const jsBlob = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    const wasmBlob = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
    return new Engine(jsBlob + '#' + encodeURIComponent(wasmBlob));
  }

  constructor(workerUrl) {
    this.worker = new Worker(workerUrl);
    this.listeners = new Set();
    this.queue = Promise.resolve(); // one search at a time
    this.worker.onmessage = e => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      for (const fn of [...this.listeners]) fn(line);
    };
    this.failed = new Promise((_, reject) => {
      this.worker.onerror = e => reject(new Error(e.message || 'engine worker failed'));
    });
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  // Wait for the first line that matches test(line).
  waitFor(test, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      let timer;
      const fn = line => {
        if (!test(line)) return;
        this.listeners.delete(fn);
        clearTimeout(timer);
        resolve(line);
      };
      this.listeners.add(fn);
      if (timeoutMs) {
        timer = setTimeout(() => { this.listeners.delete(fn); reject(new Error('engine did not answer')); }, timeoutMs);
      }
    });
  }

  async ready() {
    const ok = this.waitFor(l => l === 'uciok', START_TIMEOUT_MS);
    this.send('uci');
    await Promise.race([ok, this.failed]);
    this.send('setoption name Hash value 16');
    const ready = this.waitFor(l => l === 'readyok', START_TIMEOUT_MS);
    this.send('isready');
    await ready;
  }

  // Search a position and return the best lines, best first:
  // [{ move: 'e2e4', score: 34, mate: null }], scores in centipawns from the
  // side to move's point of view. A forced mate is reported in `mate`
  // (positive: the side to move mates) and also folded into `score`.
  analyse(fen, { depth = 10, multipv = 1 } = {}) {
    const job = this.queue.then(() => this.runSearch(fen, depth, multipv));
    this.queue = job.catch(() => {});
    return job;
  }

  async runSearch(fen, depth, multipv) {
    const lines = new Map();
    const collect = line => {
      if (!line.startsWith('info ') || !line.includes(' pv ')) return;
      const t = line.split(' ');
      const at = key => t.indexOf(key);
      const k = at('multipv') >= 0 ? Number(t[at('multipv') + 1]) : 1;
      const s = at('score');
      if (s < 0) return;
      const kind = t[s + 1];
      const value = Number(t[s + 2]);
      const mate = kind === 'mate' ? value : null;
      const score = kind === 'mate' ? (value > 0 ? 10000 - value : -10000 - value) : value;
      lines.set(k, { move: t[at('pv') + 1], score, mate, depth: Number(t[at('depth') + 1]) });
    };
    this.listeners.add(collect);
    this.send(`setoption name MultiPV value ${multipv}`);
    this.send(`position fen ${fen}`);
    const done = this.waitFor(l => l.startsWith('bestmove'));
    this.send(`go depth ${depth}`);
    const best = await done;
    this.listeners.delete(collect);
    const result = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    // No legal moves (mate or stalemate): Stockfish answers "bestmove (none)".
    if (!result.length && !best.includes('(none)')) result.push({ move: best.split(' ')[1], score: 0, mate: null });
    return result;
  }

  // The engine's score for a position, in centipawns from White's point of view.
  async evaluate(fen, depth = 12) {
    const [top] = await this.analyse(fen, { depth, multipv: 1 });
    const whiteToMove = fen.split(' ')[1] === 'w';
    if (!top) return { score: 0, best: null, mate: null }; // game over: scored by the caller
    const sign = whiteToMove ? 1 : -1;
    return { score: sign * top.score, best: top.move, mate: top.mate === null ? null : sign * top.mate };
  }
}
