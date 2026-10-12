// Global state, config, and instrument universe for the options market-making sim.
const APP = {};

APP.CONST = {
  R: 0.04,      // risk-free rate assumption (stock mode only — futures are priced undiscounted)
  Q: 0.015,     // dividend yield assumption (stock mode only)
  DTE_DAYS: 30, // fixed days-to-expiration for the whole session
};

APP.util = {
  round5c(x) { return Math.round(x / 0.05) * 0.05; },
  floor5c(x) { return Math.floor(x / 0.05 + 1e-9) * 0.05; },
  ceil5c(x) { return Math.ceil(x / 0.05 - 1e-9) * 0.05; },
  fmt(x) {
    if (x === null || x === undefined || isNaN(x)) return '';
    const s = (Math.round(x * 100) / 100).toFixed(2);
    return s === '-0.00' ? '0.00' : s;
  },
  fmtSigned(x) {
    const s = APP.util.fmt(Math.abs(x));
    return (x < 0 ? '-' : '+') + s;
  },
  rand(min, max) { return min + Math.random() * (max - min); },
  randInt(min, max) { return Math.floor(APP.util.rand(min, max + 1)); },
  choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; },
  clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); },
  uid() { return Math.random().toString(36).slice(2, 10); },
};

APP.config = {
  spreadsOn: true,
  spreadBookOn: true,
  certaintyMode: 'stock', // 'none' | 'stock' | 'vol' — 'stock' means "fixed delta-1 instrument" (future or stock)
  idbOn: true,
  tradesPerMinute: 1,     // 0.5 - 4.0, step 0.1 — how often live quotes/RFQs come up
  simLengthMin: 10,
  showPosition: true,
  startWithPosition: false,
  delta1: 'future',       // 'future' | 'stock' — the delta-1 instrument
  numStrikes: 2,          // 1 - 5
  bookView: true,         // order-book view (top 2 levels) on the main board vs. single top-of-book price
};

// seconds between ambient events, derived from the trades/minute config
function tradePaceSec() { return 60 / APP.config.tradesPerMinute; }

APP.drillConfig = {
  minutes: 10, // 1 - 20
  delta1: 'future', // 'future' | 'stock'
  view: 'book',     // 'book' | 'single'
  types: { arb: true, take: true }, // order-book question types switched on (make-a-market is always on)
};

APP.ui = {
  screen: 'home', // 'home' | 'countdown' | 'session' | 'drill' | 'drillResults'
  countdownThen: null, // function to call once the countdown finishes
  ticket: null,        // the open order ticket (take / place / own-order), if any
};

// ---- Instrument universe ------------------------------------------------

function getStrikeIncrement(spot) {
  if (spot < 30) return 2.5;
  if (spot < 150) return 5;
  return 10;
}

APP.market = {
  delta1: 'future', // fixed at session start from APP.config.delta1
  spot0: 0,
  vol0: 0,
  strikes: [],      // 1-5 strikes ascending
  incr: 5,
  rc: 0,            // fixed reversal/conversion $ value (forward - spot), computed once (0 for futures)
  stockNodes: [],   // [{t(sec), val}]
  volNodes: [],
  T: APP.CONST.DTE_DAYS / 365,
};

function isFutureMode() { return APP.market.delta1 === 'future'; }
function delta1Name() { return isFutureMode() ? 'Future' : 'Stock'; }

APP.session = {
  status: 'idle', // idle | running | ended
  startEpoch: 0,
  elapsedSec: 0,
  boardFrozen: false, // true while an IDB RFQ is being handled
  timers: [],      // active setTimeout ids to clear on reset
  rfqActive: null,  // the one market currently being asked for: {type:'board',kind,idx,book} | {type:'idb'}
  rfqQueue: [],     // pending one-sided re-quote requests
  phase: 'setup',   // 'setup' (the user makes the board; clock paused) | 'flow' (customers come in)
  setupQueue: [],   // main-board cells the user still has to make a market in
  lastActivity: 0,
};

// instrument "slots" on the board. Each slot has a cell: a small order book plus status.
//   bids / asks: live levels, best first — {px, size (other participants), user (the user's own size)}
//   markBid / markAsk: indicative (non-tradeable) reference prices, shown only where no live level exists
//   rfqSide: non-null while a customer is asking the user for a market ('both' | 'bid' | 'ask')
// bid/ask/bidSize/askSize/userBidSize/userAskSize/status are derived from those by syncCell().
function makeCell() {
  return {
    status: 'empty', // empty | indicative | live | rfq
    bid: null, ask: null,
    bidSize: null, askSize: null,
    userBidSize: 0, userAskSize: 0,
    bids: [], asks: [],
    markBid: null, markAsk: null,
    rfqSide: null,
    rfqVolume: null,
    _refBid: null, _refAsk: null, // {px,size} shown as the fixed side of a one-sided RFQ
    _timer: null,
  };
}

APP.instruments = {
  stock: makeCell(), // the delta-1 instrument (future or stock) — kind key stays 'stock'
  rc: { value: 0 }, // static, no cell machine
  ps: [], call: [], put: [], bw: [], straddle: [], // arrays of N cells (by strike idx)
  callSpread: [], putSpread: [],     // arrays of N-1 cells (by pair idx, pair i = strikes[i],strikes[i+1])
};

function initInstrumentUniverse() {
  const N = APP.market.strikes.length;
  APP.instruments.stock = makeCell();
  ['ps', 'call', 'put', 'bw', 'straddle'].forEach(k => {
    APP.instruments[k] = [];
    for (let i = 0; i < N; i++) APP.instruments[k][i] = makeCell();
  });
  APP.instruments.callSpread = []; APP.instruments.putSpread = [];
  for (let i = 0; i < N - 1; i++) {
    APP.instruments.callSpread[i] = makeCell();
    APP.instruments.putSpread[i] = makeCell();
  }
}

// Spread book: an away-from-board resting market in structures that AREN'T already findable on
// the board — straddles/combos (stock mode only; futures put straddles on the board), strangles,
// risk-reversals, vertical spreads that skip strikes, butterflies and condors. It's an
// independent set of cells, only relevant when spreadBookOn; only up to 2 are ever shown at once.
// Which identities exist depends on the delta-1 mode and the strike count — see
// spreadBookIdentities() in market.js.
APP.spreadBook = {
  entries: {},  // key `${kind}_${idx}` -> cell
  active: [],   // up to 2 currently-displayed {kind, idx} entries
};
function spreadBookKey(kind, idx) { return `${kind}_${idx}`; }
function initSpreadBook() {
  APP.spreadBook.entries = {};
  spreadBookIdentities().forEach(({ kind, idx }) => { APP.spreadBook.entries[spreadBookKey(kind, idx)] = makeCell(); });
  APP.spreadBook.active = [];
}
function spreadBookCellFor(kind, idx) {
  return APP.spreadBook.entries[spreadBookKey(kind, idx)];
}

APP.idb = {
  active: null, // {kind, idx, status, rfqSide, rfqVolume, fixedBid..., bid, ask, bidSize, askSize}
  log: [],
};

APP.position = {
  legs: [], // {type:'stock'|'call'|'put', strike?, qty (signed), entryPrice, time}
};

APP.history = []; // the "flow" panel: {id, text, color:'red'|'yellow'|'blue'|'green', ts}
