// Fair-value engine: stock/vol theme paths, Black-Scholes fairs, and quote-width regimes.

function buildPath(simLenSec, numTurns, startVal, kind) {
  if (numTurns <= 0) return [{ t: 0, val: startVal }, { t: simLenSec, val: startVal }];
  const segments = numTurns + 1;
  const nodes = [{ t: 0, val: startVal }];
  let prevVal = startVal;
  for (let i = 1; i <= numTurns; i++) {
    const baseT = simLenSec * i / segments;
    const jitter = (simLenSec / segments) * 0.15 * (Math.random() * 2 - 1);
    const t = APP.util.clamp(baseT + jitter, 150, Math.max(150, simLenSec - 150));
    let val;
    if (kind === 'stock') {
      const pct = APP.util.rand(0.012, 0.035) * (Math.random() < 0.5 ? -1 : 1);
      val = prevVal * (1 + pct);
    } else {
      const delta = APP.util.rand(1.5, 4) * (Math.random() < 0.5 ? -1 : 1);
      val = APP.util.clamp(prevVal + delta, 8, 60);
    }
    nodes.push({ t, val });
    prevVal = val;
  }
  let finalVal;
  if (kind === 'stock') {
    const pct = APP.util.rand(0.01, 0.03) * (Math.random() < 0.5 ? -1 : 1);
    finalVal = prevVal * (1 + pct);
  } else {
    const delta = APP.util.rand(1, 3) * (Math.random() < 0.5 ? -1 : 1);
    finalVal = APP.util.clamp(prevVal + delta, 8, 60);
  }
  nodes.push({ t: simLenSec, val: finalVal });
  nodes.sort((a, b) => a.t - b.t);
  return nodes;
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

function fairCall(K) {
  return BS.price(currentSpot(), K, APP.market.T, APP.CONST.R, APP.CONST.Q, currentVol(), 'call');
}
function fairPut(K) {
  return BS.price(currentSpot(), K, APP.market.T, APP.CONST.R, APP.CONST.Q, currentVol(), 'put');
}
// P+S and B/W are quoted the way a floor combo actually trades: relative to the strike, not as a
// raw stock-scale dollar sum. Parity (C - P = S - K + rc) means P+S's true dollar cost (S+P) is
// exactly Call - rc + K, and B/W's true debit (S-C) is exactly K - (Put + rc) — so the strike-
// relative quotes below reduce to a clean, small, strike-independent offset of the paired option.
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

// Multi-strike spread-book instruments encode their two strike indices i<j as idx = i*10+j.
function encodePair(i, j) { return i * 10 + j; }
function decodePair(idx) { return [Math.floor(idx / 10), idx % 10]; }

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
  }
  return 0;
}

// Total bid-ask width ranges [lo, hi] by liquidity regime. Markets are tight (capped at 0.20)
// unless the size being quoted is 100 or more, in which case the old, wider regime-based range
// applies (a bigger clip naturally trades wider).
function widthRange(kind, size) {
  const mode = APP.config.certaintyMode;
  const isOption = (kind === 'call' || kind === 'put' || kind === 'ps' || kind === 'bw');
  const isSpread = (kind === 'callSpread' || kind === 'putSpread' || kind === 'callSpreadWide' || kind === 'putSpreadWide');
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

function pickDifficulty() { return APP.config.fillPct / 100; }

function enumerateBoardCells() {
  const list = [];
  list.push({ kind: 'stock', idx: 0, cell: APP.instruments.stock });
  for (let i = 0; i < 5; i++) {
    list.push({ kind: 'ps', idx: i, cell: APP.instruments.ps[i] });
    list.push({ kind: 'call', idx: i, cell: APP.instruments.call[i] });
    list.push({ kind: 'put', idx: i, cell: APP.instruments.put[i] });
    list.push({ kind: 'bw', idx: i, cell: APP.instruments.bw[i] });
  }
  if (APP.config.spreadsOn) {
    for (let i = 0; i < 4; i++) {
      list.push({ kind: 'callSpread', idx: i, cell: APP.instruments.callSpread[i] });
      list.push({ kind: 'putSpread', idx: i, cell: APP.instruments.putSpread[i] });
    }
  }
  return list;
}

function enumerateSpreadBookCells() {
  const list = [];
  if (!APP.config.spreadBookOn) return list;
  SPREAD_BOOK_SINGLE_KINDS.forEach(kind => {
    for (let i = 0; i < 5; i++) list.push({ kind, idx: i, cell: spreadBookCellFor(kind, i), book: true });
  });
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) {
      const idx = encodePair(i, j);
      list.push({ kind: 'strangle', idx, cell: spreadBookCellFor('strangle', idx), book: true });
      list.push({ kind: 'riskReversal', idx, cell: spreadBookCellFor('riskReversal', idx), book: true });
      if (j !== i + 1) { // adjacent-strike verticals already live on the board — book holds only wider ones
        list.push({ kind: 'callSpreadWide', idx, cell: spreadBookCellFor('callSpreadWide', idx), book: true });
        list.push({ kind: 'putSpreadWide', idx, cell: spreadBookCellFor('putSpreadWide', idx), book: true });
      }
    }
  }
  return list;
}

function initMarket() {
  const spot0 = APP.util.round5c(APP.util.rand(70, 130));
  const vol0 = APP.util.rand(18, 30);
  const incr = getStrikeIncrement(spot0);
  const atm = Math.round(spot0 / incr) * incr;
  const strikes = [atm - 2 * incr, atm - incr, atm, atm + incr, atm + 2 * incr];

  APP.market.spot0 = spot0;
  APP.market.vol0 = vol0;
  APP.market.incr = incr;
  APP.market.strikes = strikes;
  APP.market.T = APP.CONST.DTE_DAYS / 365;
  APP.market.rc = APP.util.round5c(spot0 * (Math.exp((APP.CONST.R - APP.CONST.Q) * APP.market.T) - 1));
  APP.instruments.rc.value = APP.market.rc;
  APP.market._fixedStockQuote = null; // re-rolled once, then held for the whole session if stock is fixed

  const simLenSec = APP.config.simLengthMin * 60;
  const maxTurns = Math.max(0, Math.floor(APP.config.simLengthMin / 3));
  let stockTurns, volTurns;
  if (APP.config.certaintyMode === 'stock') {
    stockTurns = 0;
    volTurns = APP.util.randInt(Math.min(2, maxTurns), maxTurns);
  } else if (APP.config.certaintyMode === 'vol') {
    volTurns = 0;
    stockTurns = APP.util.randInt(0, maxTurns);
  } else {
    stockTurns = APP.util.randInt(0, maxTurns);
    volTurns = APP.util.randInt(0, maxTurns);
  }
  APP.market.stockNodes = buildPath(simLenSec, stockTurns, spot0, 'stock');
  APP.market.volNodes = buildPath(simLenSec, volTurns, vol0, 'vol');

  initInstrumentUniverse();
  initSpreadBook();
}

function applyInitialFill() {
  const pct = pickDifficulty();
  APP.session.elapsedSec = 0;
  enumerateBoardCells().forEach(({ kind, idx, cell }) => {
    if (kind === 'stock') return; // stock is always live, handled separately
    if (Math.random() < pct) {
      const q = makeIndicativeQuote(kind, idx);
      cell.status = 'indicative';
      cell.bid = q.bid; cell.ask = q.ask;
    }
  });
  enumerateSpreadBookCells().forEach(({ kind, idx, cell }) => {
    if (Math.random() < pct && ensureSpreadBookSlot(kind, idx)) {
      const q = makeIndicativeQuote(kind, idx);
      cell.status = 'indicative';
      cell.bid = q.bid; cell.ask = q.ask;
    }
  });
}
