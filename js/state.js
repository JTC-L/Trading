// Global state, config, and instrument universe for the options market-making sim.
const APP = {};

APP.CONST = {
  R: 0.04,      // risk-free rate assumption
  Q: 0.015,     // dividend yield assumption
  DTE_DAYS: 30, // fixed days-to-expiration for the whole session
};

APP.util = {
  round5c(x) { return Math.round(x / 0.05) * 0.05; },
  fmt(x) {
    if (x === null || x === undefined || isNaN(x)) return '';
    const s = (Math.round(x * 100) / 100).toFixed(2);
    return s;
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
  certaintyMode: 'stock', // 'none' | 'stock' | 'vol'
  idbOn: true,
  tradesPerMinute: 1,     // 0.5 - 4.0, step 0.1 — how often live quotes/RFQs come up
  simLengthMin: 10,
  showPosition: true,
  fillPct: 25,            // 25 - 100, step 25 — % of the board filled indicative at the start
  startWithPosition: false,
};

// seconds between ambient events, derived from the trades/minute config
function tradePaceSec() { return 60 / APP.config.tradesPerMinute; }

APP.drillConfig = {
  minutes: 2, // 1 - 10
};

APP.ui = {
  screen: 'home', // 'home' | 'countdown' | 'session' | 'drill' | 'drillResults'
  countdownThen: null, // function to call once the countdown finishes
};

// ---- Instrument universe ------------------------------------------------

function getStrikeIncrement(spot) {
  if (spot < 30) return 2.5;
  if (spot < 150) return 5;
  return 10;
}

APP.market = {
  spot0: 0,
  vol0: 0,
  strikes: [],      // 5 strikes ascending
  incr: 5,
  rc: 0,            // fixed reversal/conversion $ value (forward - spot), computed once
  stockNodes: [],   // [{t(sec), val}]
  volNodes: [],
  T: APP.CONST.DTE_DAYS / 365,
};

APP.session = {
  status: 'idle', // idle | running | ended
  startEpoch: 0,
  elapsedSec: 0,
  boardFrozen: false, // true while an IDB RFQ is being handled
  timers: [],      // active setTimeout ids to clear on reset
};

// instrument "slots" on the board. Each slot has a cell state machine.
// kinds: ps, call, put, bw (strike-indexed 0..4), stock (single), callspread/putspread (pair-indexed 0..3)
function makeCell() {
  return {
    status: 'empty', // empty | indicative | live | rfq | quoted
    bid: null, ask: null,
    bidSize: null, askSize: null,
    userBidSize: 0, userAskSize: 0, // how much of bidSize/askSize is the user's own resting market
    rfqSide: null,               // 'both' | 'bid' | 'ask' — which side(s) the RFQ is soliciting
    rfqVolume: null,             // the size the customer specified for the solicited side(s)
    _fixedBidSize: null, _fixedAskSize: null, // fabricated size for the non-solicited (fixed) side of a one-sided RFQ
    _timer: null,
    _advantage: null,
  };
}

APP.instruments = {
  stock: makeCell(),
  rc: { value: 0 }, // static, no cell machine
  ps: [], call: [], put: [], bw: [], // arrays of 5 cells (by strike idx)
  callSpread: [], putSpread: [],     // arrays of 4 cells (by pair idx, pair i = strikes[i],strikes[i+1])
};

function initInstrumentUniverse() {
  for (let i = 0; i < 5; i++) {
    APP.instruments.ps[i] = makeCell();
    APP.instruments.call[i] = makeCell();
    APP.instruments.put[i] = makeCell();
    APP.instruments.bw[i] = makeCell();
  }
  for (let i = 0; i < 4; i++) {
    APP.instruments.callSpread[i] = makeCell();
    APP.instruments.putSpread[i] = makeCell();
  }
}

// Spread book: an away-from-board resting market in structures that AREN'T already findable on
// the board — same-strike straddles/combos, cross-strike strangles/risk-reversals, and vertical
// spreads that skip over strikes (the board only ever shows adjacent-strike verticals). It's an
// independent set of cells (its own prices can differ from the board's), only relevant when
// spreadBookOn; only up to 2 candidates are ever shown at once (see active).
const SPREAD_BOOK_SINGLE_KINDS = ['straddle', 'combo'];       // idx = strike index (0-4)
const SPREAD_BOOK_PAIR_KINDS = ['strangle', 'riskReversal', 'callSpreadWide', 'putSpreadWide']; // idx = i*10+j
APP.spreadBook = {
  entries: {},  // key `${kind}_${idx}` -> cell
  active: [],   // up to 2 currently-displayed {kind, idx} entries
};
function spreadBookKey(kind, idx) { return `${kind}_${idx}`; }
function initSpreadBook() {
  APP.spreadBook.entries = {};
  SPREAD_BOOK_SINGLE_KINDS.forEach(kind => {
    for (let i = 0; i < 5; i++) APP.spreadBook.entries[spreadBookKey(kind, i)] = makeCell();
  });
  SPREAD_BOOK_PAIR_KINDS.forEach(kind => {
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) APP.spreadBook.entries[spreadBookKey(kind, i * 10 + j)] = makeCell();
    }
  });
  APP.spreadBook.active = [];
}
function spreadBookCellFor(kind, idx) {
  return APP.spreadBook.entries[spreadBookKey(kind, idx)];
}

APP.idb = {
  active: null, // {instrumentDesc, kind, ref, bid, ask, size, awaitingUser, resolved}
  log: [],
};

APP.position = {
  legs: [], // {type:'stock'|'call'|'put', strike?, qty (signed), entryPrice, time}
};

APP.alerts = []; // {id, text, ts}
