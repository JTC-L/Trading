// Fair-value engine: stock/vol theme paths, Black-Scholes fairs, and quote-width regimes.

// `bias` (+1 / -1) forces every move in the path the same way — that's how a session's theme (rising
// vol, a falling market...) shows up in the fair values; 0 leaves each move's direction random.
function buildPath(simLenSec, numTurns, startVal, kind, bias) {
  if (numTurns <= 0) return [{ t: 0, val: startVal }, { t: simLenSec, val: startVal }];
  const segments = numTurns + 1;
  const sign = () => bias || (Math.random() < 0.5 ? -1 : 1);
  const nodes = [{ t: 0, val: startVal }];
  let prevVal = startVal;
  for (let i = 1; i <= numTurns; i++) {
    const baseT = simLenSec * i / segments;
    const jitter = (simLenSec / segments) * 0.15 * (Math.random() * 2 - 1);
    const t = APP.util.clamp(baseT + jitter, 150, Math.max(150, simLenSec - 150));
    let val;
    if (kind === 'stock') {
      const pct = APP.util.rand(0.012, 0.035) * sign();
      val = prevVal * (1 + pct);
    } else {
      const delta = APP.util.rand(1.5, 4) * sign();
      val = APP.util.clamp(prevVal + delta, 8, 60);
    }
    nodes.push({ t, val });
    prevVal = val;
  }
  let finalVal;
  if (kind === 'stock') {
    const pct = APP.util.rand(0.01, 0.03) * sign();
    finalVal = prevVal * (1 + pct);
  } else {
    const delta = APP.util.rand(1, 3) * sign();
    finalVal = APP.util.clamp(prevVal + delta, 8, 60);
  }
  nodes.push({ t: simLenSec, val: finalVal });
  nodes.sort((a, b) => a.t - b.t);
  return nodes;
}

// A session's theme: what the customers believe, and so which way they lean. A fixed delta-1 can't
// have a market view, so then it's a view on vol; a fixed vol means a view on the underlying.
const THEMES = {
  volUp: { key: 'volUp', variable: 'vol', dir: 1, label: 'rising volatility' },
  volDown: { key: 'volDown', variable: 'vol', dir: -1, label: 'falling volatility' },
  stockUp: { key: 'stockUp', variable: 'stock', dir: 1, label: 'a rising market' },
  stockDown: { key: 'stockDown', variable: 'stock', dir: -1, label: 'a falling market' },
};
function pickTheme(certaintyMode) {
  const pool = certaintyMode === 'stock' ? ['volUp', 'volDown']
    : certaintyMode === 'vol' ? ['stockUp', 'stockDown']
    : ['volUp', 'volDown', 'stockUp', 'stockDown'];
  return THEMES[APP.util.choice(pool)];
}

function valueAt(nodes, tSec) {
  if (tSec <= nodes[0].t) return nodes[0].val;
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    if (tSec >= a.t && tSec <= b.t) {
      const f = (tSec - a.t) / ((b.t - a.t) || 1);
      return a.val + (b.val - a.val) * f;
    }
  }
  return nodes[nodes.length - 1].val;
}

function currentSpot() { return valueAt(APP.market.stockNodes, APP.session.elapsedSec); }
function currentVolPct() { return valueAt(APP.market.volNodes, APP.session.elapsedSec); }
function currentVol() { return currentVolPct() / 100; }

// A future carries no cost of carry, so its options are priced undiscounted (Black-76): r = q = 0
// makes BS(S=F) exactly that, and gives C - P = F - K with no r/c.
function mktR() { return isFutureMode() ? 0 : APP.CONST.R; }
function mktQ() { return isFutureMode() ? 0 : APP.CONST.Q; }

function fairCall(K) {
  return BS.price(currentSpot(), K, APP.market.T, mktR(), mktQ(), currentVol(), 'call');
}
function fairPut(K) {
  return BS.price(currentSpot(), K, APP.market.T, mktR(), mktQ(), currentVol(), 'put');
}
// P+S and B/W are quoted the way a floor combo actually trades: relative to the strike, not as a
// raw stock-scale dollar sum. Parity (C - P = S - K + rc) means P+S's true dollar cost (S+P) is
// exactly Call - rc + K, and B/W's true debit (S-C) is exactly K - (Put + rc) — so the strike-
// relative quotes below reduce to a clean, small, strike-independent offset of the paired option.
// (Stock mode only — futures have no P+S / B/W.)
function fairBW(K) { return fairPut(K) + APP.market.rc; }
function fairPS(K) { return fairCall(K) - APP.market.rc; }
function fairCallSpread(i) {
  const s = APP.market.strikes;
  return fairCall(s[i]) - fairCall(s[i + 1]);
}
function fairPutSpread(i) {
  const s = APP.market.strikes;
  return fairPut(s[i + 1]) - fairPut(s[i]);
}

// Multi-strike instruments encode their strike indices into a single idx:
//   pairs (i<j)            idx = i*10+j
//   butterflies (i<j<k)    idx = i*100+j*10+k
//   condors (i<j<k<l)      idx = i*1000+j*100+k*10+l
function encodePair(i, j) { return i * 10 + j; }
function decodePair(idx) { return [Math.floor(idx / 10), idx % 10]; }
function encodeTriple(i, j, k) { return i * 100 + j * 10 + k; }
function decodeTriple(idx) { return [Math.floor(idx / 100), Math.floor(idx / 10) % 10, idx % 10]; }
function encodeQuad(i, j, k, l) { return i * 1000 + j * 100 + k * 10 + l; }
function decodeQuad(idx) { return [Math.floor(idx / 1000), Math.floor(idx / 100) % 10, Math.floor(idx / 10) % 10, idx % 10]; }

function fairStraddle(K) { return fairCall(K) + fairPut(K); }
// A combo is quoted as call-minus-put if the call is richer, or put-minus-call if the put is
// richer — i.e. always |C-P| — precisely so that going "long the combo" is always a debit you
// pay, never a credit you're paid to take on (see addTrade's 'combo' case for which leg is long).
function fairCombo(K) { return Math.abs(fairCall(K) - fairPut(K)); }
function fairStrangle(idx) {
  const [i, j] = decodePair(idx), s = APP.market.strikes;
  return fairPut(s[i]) + fairCall(s[j]); // put at the lower strike, call at the upper
}
function fairRiskReversal(idx) {
  const [i, j] = decodePair(idx), s = APP.market.strikes;
  return fairCall(s[j]) - fairPut(s[i]); // long call at the upper strike, short put at the lower
}
function fairCallSpreadWide(idx) {
  const [i, j] = decodePair(idx), s = APP.market.strikes;
  return fairCall(s[i]) - fairCall(s[j]);
}
function fairPutSpreadWide(idx) {
  const [i, j] = decodePair(idx), s = APP.market.strikes;
  return fairPut(s[j]) - fairPut(s[i]);
}
// Equal-wing butterfly: long the wings, short 2x the body. Equal-wing condor: long the outer
// strikes, short the two inner strikes. Quoted as call structures (puts price identically).
function fairButterfly(idx) {
  const [i, j, k] = decodeTriple(idx), s = APP.market.strikes;
  return fairCall(s[i]) - 2 * fairCall(s[j]) + fairCall(s[k]);
}
function fairCondor(idx) {
  const [i, j, k, l] = decodeQuad(idx), s = APP.market.strikes;
  return fairCall(s[i]) - fairCall(s[j]) - fairCall(s[k]) + fairCall(s[l]);
}

function fairMid(kind, idx) {
  switch (kind) {
    case 'stock': return currentSpot();
    case 'call': return fairCall(APP.market.strikes[idx]);
    case 'put': return fairPut(APP.market.strikes[idx]);
    case 'ps': return fairPS(APP.market.strikes[idx]);
    case 'bw': return fairBW(APP.market.strikes[idx]);
    case 'callSpread': return fairCallSpread(idx);
    case 'putSpread': return fairPutSpread(idx);
    case 'straddle': return fairStraddle(APP.market.strikes[idx]);
    case 'combo': return fairCombo(APP.market.strikes[idx]);
    case 'strangle': return fairStrangle(idx);
    case 'riskReversal': return fairRiskReversal(idx);
    case 'callSpreadWide': return fairCallSpreadWide(idx);
    case 'putSpreadWide': return fairPutSpreadWide(idx);
    case 'butterfly': return fairButterfly(idx);
    case 'condor': return fairCondor(idx);
  }
  return 0;
}

// Total bid-ask width ranges [lo, hi] by liquidity regime. Markets are tight (capped at 0.20)
// unless the size being quoted is 100 or more, in which case the old, wider regime-based range
// applies (a bigger clip naturally trades wider).
function widthRange(kind, size) {
  const mode = APP.config.certaintyMode;
  const isOption = (kind === 'call' || kind === 'put' || kind === 'ps' || kind === 'bw');
  const isSpread = (kind === 'callSpread' || kind === 'putSpread' || kind === 'callSpreadWide' || kind === 'putSpreadWide'
    || kind === 'butterfly' || kind === 'condor');
  const isCombo = (kind === 'straddle' || kind === 'combo' || kind === 'strangle' || kind === 'riskReversal');
  let lo, hi;
  if (kind === 'stock') {
    if (mode === 'stock') [lo, hi] = [0.02, 0.04];
    else if (mode === 'vol') [lo, hi] = [0.15, 0.30];
    else [lo, hi] = [0.08, 0.15];
  } else if (isOption) {
    if (mode === 'stock') [lo, hi] = [0.30, 0.50];
    else if (mode === 'vol') [lo, hi] = [0.10, 0.20];
    else [lo, hi] = [0.15, 0.30];
  } else if (isSpread) {
    [lo, hi] = [0.10, 0.22];
  } else if (isCombo) {
    [lo, hi] = [0.15, 0.30];
  } else {
    [lo, hi] = [0.10, 0.20];
  }
  if ((size || 0) < 100) {
    hi = Math.min(hi, 0.20);
    lo = Math.min(lo, hi);
  }
  return [lo, hi];
}

// P+S and B/W are the only instruments allowed to price negative (they're strike-relative
// combo debits/credits, not raw option premiums) — everything else keeps the usual nickel floor.
function priceFloorFor(kind) { return (kind === 'ps' || kind === 'bw') ? -Infinity : 0.05; }

function makeIndicativeQuote(kind, idx) {
  const mid = fairMid(kind, idx);
  const [lo, hi] = widthRange(kind, 0); // indicative marks carry no size — always tight
  const w = APP.util.rand(lo, hi) / 2;
  const floor = priceFloorFor(kind);
  let bid = APP.util.round5c(Math.max(floor, mid - w));
  let ask = APP.util.round5c(Math.max(bid + 0.05, mid + w));
  return { bid, ask };
}

// --- session bootstrap -----------------------------------------------------

// The main-board option kinds for the current delta-1 mode, in display order.
function mainOptionKinds() { return isFutureMode() ? ['call', 'put', 'straddle'] : ['ps', 'call', 'put', 'bw']; }

function enumerateBoardCells() {
  const N = APP.market.strikes.length;
  const list = [];
  list.push({ kind: 'stock', idx: 0, cell: APP.instruments.stock });
  const kinds = mainOptionKinds();
  for (let i = 0; i < N; i++) {
    kinds.forEach(kind => list.push({ kind, idx: i, cell: APP.instruments[kind][i] }));
  }
  if (APP.config.spreadsOn) {
    for (let i = 0; i < N - 1; i++) {
      list.push({ kind: 'callSpread', idx: i, cell: APP.instruments.callSpread[i] });
      list.push({ kind: 'putSpread', idx: i, cell: APP.instruments.putSpread[i] });
    }
  }
  return list;
}

// Every structure the spread book (and the IDB) can ask about for this mode/strike count —
// regardless of whether the spread book is switched on (the IDB draws from the same universe).
function spreadBookIdentities() {
  const N = APP.market.strikes.length;
  const list = [];
  if (!isFutureMode()) { // futures put straddles on the board; combos are meaningless against a future
    for (let i = 0; i < N; i++) { list.push({ kind: 'straddle', idx: i }); list.push({ kind: 'combo', idx: i }); }
  }
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const idx = encodePair(i, j);
      list.push({ kind: 'strangle', idx });
      list.push({ kind: 'riskReversal', idx });
      if (j !== i + 1) { // adjacent-strike verticals already live on the board — book holds only wider ones
        list.push({ kind: 'callSpreadWide', idx });
        list.push({ kind: 'putSpreadWide', idx });
      }
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      for (let k = j + 1; k < N; k++) {
        if (j - i === k - j) list.push({ kind: 'butterfly', idx: encodeTriple(i, j, k) }); // equal wings, needs 3 strikes
        for (let l = k + 1; l < N; l++) {
          if (j - i === l - k) list.push({ kind: 'condor', idx: encodeQuad(i, j, k, l) }); // equal wings, needs 4 strikes
        }
      }
    }
  }
  return list;
}

function enumerateSpreadBookCells(ignoreToggle) {
  if (!APP.config.spreadBookOn && !ignoreToggle) return [];
  return spreadBookIdentities().map(({ kind, idx }) => ({ kind, idx, cell: spreadBookCellFor(kind, idx), book: true }));
}

// Whether a structure lives in the spread book (as opposed to having its own board slot).
function isBookKind(kind) {
  if (kind === 'straddle') return !isFutureMode();
  return ['combo', 'strangle', 'riskReversal', 'callSpreadWide', 'putSpreadWide', 'butterfly', 'condor'].includes(kind);
}

function initMarket() {
  APP.market.delta1 = APP.config.delta1;
  const spot0 = APP.util.round5c(APP.util.rand(70, 130));
  const vol0 = APP.util.rand(18, 30);
  const incr = getStrikeIncrement(spot0);
  const N = APP.util.clamp(APP.config.numStrikes, 1, 5);
  const strikes = [];
  if (N % 2 === 1) {
    const atm = Math.round(spot0 / incr) * incr;
    for (let t = -(N - 1) / 2; t <= (N - 1) / 2; t++) strikes.push(atm + t * incr);
  } else { // an even count brackets the price
    const base = Math.floor(spot0 / incr) * incr;
    for (let t = -(N / 2 - 1); t <= N / 2; t++) strikes.push(base + t * incr);
  }

  APP.market.spot0 = spot0;
  APP.market.vol0 = vol0;
  APP.market.incr = incr;
  APP.market.strikes = strikes;
  APP.market.T = APP.CONST.DTE_DAYS / 365;
  APP.market.rc = isFutureMode() ? 0 : APP.util.round5c(spot0 * (Math.exp((APP.CONST.R - APP.CONST.Q) * APP.market.T) - 1));
  APP.instruments.rc.value = APP.market.rc;
  APP.market._fixedStockQuote = null; // re-rolled once, then held for the whole session if the delta-1 is fixed

  const simLenSec = APP.config.simLengthMin * 60;
  const maxTurns = Math.max(1, Math.floor(APP.config.simLengthMin / 3));
  let stockTurns, volTurns;
  if (APP.config.certaintyMode === 'stock') {
    stockTurns = 0;
    volTurns = APP.util.randInt(Math.min(2, maxTurns), maxTurns);
  } else if (APP.config.certaintyMode === 'vol') {
    volTurns = 0;
    stockTurns = APP.util.randInt(1, maxTurns);
  } else {
    stockTurns = APP.util.randInt(1, maxTurns);
    volTurns = APP.util.randInt(1, maxTurns);
  }
  // the session's theme: a view the customers share, which the fair values then bear out
  const theme = pickTheme(APP.config.certaintyMode);
  APP.market.theme = theme;
  APP.market.stockNodes = buildPath(simLenSec, stockTurns, spot0, 'stock', theme.variable === 'stock' ? theme.dir : 0);
  APP.market.volNodes = buildPath(simLenSec, volTurns, vol0, 'vol', theme.variable === 'vol' ? theme.dir : 0);

  initInstrumentUniverse();
  initSpreadBook();
}
