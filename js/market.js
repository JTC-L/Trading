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
// A risk reversal is always quoted as a positive price, |call(upper) - put(lower)|: "calls over" when the
// call is richer (long the call, short the put), "puts over" when the put is (long the put, short the call).
function riskReversalCallsOver(idx) {
  const [i, j] = decodePair(idx), s = APP.market.strikes;
  return fairCall(s[j]) >= fairPut(s[i]);
}
function fairRiskReversal(idx) {
  const [i, j] = decodePair(idx), s = APP.market.strikes;
  return Math.abs(fairCall(s[j]) - fairPut(s[i]));
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

// ---- vega, tick and width rules -------------------------------------------------------

// Vertical spreads (and their wide cousins) trade very tight: at most 0.05 wide, or 0.10 on a 0.10 tick.
function isVerticalKind(kind) { return kind === 'callSpread' || kind === 'putSpread' || kind === 'callSpreadWide' || kind === 'putSpreadWide'; }
function verticalMaxWidth() { return tickSize() >= 0.1 - 1e-9 ? 0.1 : 0.05; }

// Black-Scholes vega of one unit of the instrument (per share, per vol point) — a spread's is the
// difference of its legs' vegas, so wings and verticals are naturally low-vega.
function unitVega(kind, idx) {
  if (kind === 'stock') return 0;
  const S = currentSpot(), T = APP.market.T, r = mktR(), q = mktQ(), vol = currentVol(), s = APP.market.strikes;
  const v = (i) => BS.greeks(S, s[i], T, r, q, vol, 'call').vega; // a put at the same strike has the same vega
  switch (kind) {
    case 'call': case 'put': case 'ps': case 'bw': return v(idx);
    case 'straddle': return 2 * v(idx);
    case 'combo': return 0;
    case 'callSpread': case 'putSpread': return Math.abs(v(idx) - v(idx + 1));
    case 'strangle': { const [i, j] = decodePair(idx); return v(i) + v(j); }
    case 'riskReversal': case 'callSpreadWide': case 'putSpreadWide': { const [i, j] = decodePair(idx); return Math.abs(v(j) - v(i)); }
    case 'butterfly': { const [i, j, k] = decodeTriple(idx); return Math.abs(v(i) - 2 * v(j) + v(k)); }
    case 'condor': { const [i, j, k, l] = decodeQuad(idx); return Math.abs(v(i) - v(j) - v(k) + v(l)); }
  }
  return 0;
}

// The position tracker's vega units: a quantity is in contracts of 100 shares.
function vegaOfSize(kind, idx, qty) { return unitVega(kind, idx) * 100 * qty; }

// How wide a market is, by instrument and size: proportional to the instrument's vega times the square
// root of the volume. An instrument with twice the vega quotes twice as wide, and four times the lots
// quote twice as wide — 100 lots 1 point wide on a vega-one instrument means 400 lots 2 wide, or 100 lots
// 0.5 wide on a vega-0.5 instrument. (Vega is per share per vol point, so an at-the-money call here is
// about 0.12: roughly 0.12 wide at 100 lots, 0.25 at 400.) The delta-1 isn't priced this way.
function typicalWidth(kind, idx, qty) {
  return unitVega(kind, idx || 0) * Math.sqrt(Math.max(qty, 1) / 100);
}

// What a market maker may quote: no more than 1 wide on any instrument, or 2 wide when the size asked for
// is more than 200 options or 100 straddles (a straddle is two options, so half the lots). Verticals stay
// within their own, much tighter cap whatever the size. A wider market than is typical just gets fewer
// trades (see widthTradeFactor in simulation.js).
function isStraddleLike(kind) { return kind === 'straddle' || kind === 'strangle' || kind === 'riskReversal' || kind === 'combo'; }
function maxUserWidth(kind, idx, qty) {
  if (isVerticalKind(kind)) return verticalMaxWidth();
  return qty > (isStraddleLike(kind) ? 100 : 200) ? 2 : 1;
}

// A smaller tick means a tighter market everywhere; a bigger one, a looser one.
function tickWidthScale() { const t = tickSize(); return t >= 0.1 - 1e-9 ? 1.4 : (t <= 0.01 + 1e-9 ? 0.5 : 1); }

// Total bid-ask width range [lo, hi] for a market in `size` lots. The delta-1 keeps its liquidity-regime
// widths; everything else follows typicalWidth, a little wider when the delta-1 is fixed (less is known
// about the options) and tighter when vol is fixed. Verticals are capped outright.
function widthRange(kind, size, idx) {
  const mode = APP.config.certaintyMode;
  const scale = tickWidthScale(), t = tickSize();
  let lo, hi;
  if (kind === 'stock') {
    if (mode === 'stock') [lo, hi] = [0.02, 0.04];
    else if (mode === 'vol') [lo, hi] = [0.15, 0.30];
    else [lo, hi] = [0.08, 0.15];
    lo *= scale; hi *= scale;
  } else {
    const regime = mode === 'stock' ? 1.7 : (mode === 'vol' ? 0.65 : 1);
    const typ = typicalWidth(kind, idx, size || 25) * regime * scale;
    lo = 0.75 * typ; hi = 1.3 * typ;
  }
  lo = Math.max(lo, t); hi = Math.max(hi, lo);
  if (isVerticalKind(kind)) { hi = Math.min(hi, verticalMaxWidth()); lo = Math.min(lo, hi); }
  return [lo, hi];
}

// P+S and B/W are the only instruments allowed to price negative (they're strike-relative combo
// debits/credits, not raw option premiums). Everything else keeps a one-tick floor, and an option is
// never bid for less than its intrinsic value (the parity bound: C >= S - K + rc, P >= K - S - rc).
function intrinsicFor(kind, idx) {
  if (kind !== 'call' && kind !== 'put' && kind !== 'straddle') return 0;
  const d = currentSpot() - APP.market.strikes[idx] + APP.market.rc; // C - P
  return kind === 'call' ? Math.max(0, d) : kind === 'put' ? Math.max(0, -d) : Math.abs(d);
}
// Signed structures: P+S and B/W are strike-relative, so they can be worth less than nothing. (A risk
// reversal can't: it's quoted as |call - put|.)
function isSignedKind(kind) { return kind === 'ps' || kind === 'bw'; }
function priceFloorFor(kind, idx) {
  if (isSignedKind(kind)) return -Infinity;
  return Math.max(tickSize(), idx == null ? 0 : APP.util.ct(intrinsicFor(kind, idx)));
}

function makeIndicativeQuote(kind, idx) {
  const mid = fairMid(kind, idx);
  const [lo, hi] = widthRange(kind, 0, idx); // indicative marks carry no size: a modest 25-lot width
  const w = APP.util.rand(lo, hi) / 2;
  const floor = priceFloorFor(kind, idx);
  let bid = APP.util.rt(Math.max(floor, mid - w));
  let ask = APP.util.rt(Math.max(bid + tickSize(), mid + w));
  return { bid, ask };
}

// ---- time travel and focus -----------------------------------------------------------

// The fair value `dtSec` from now on the session's own clock (informed customers trade on this).
function fairMidAt(kind, idx, dtSec) {
  const saved = APP.session.elapsedSec;
  APP.session.elapsedSec = Math.min(APP.market.lenSec, saved + dtSec);
  const v = fairMid(kind, idx);
  APP.session.elapsedSec = saved;
  return v;
}

// A session's length on the clock the fair-value paths run on. Timed sessions run in real time; a
// step-by-step session has no clock, so it gets a virtual one with room for the moves to play out.
function sessionLenSec() {
  return APP.config.mode === 'steps' ? Math.max(300, APP.config.steps * 15) : APP.config.simLengthMin * 60;
}

// Strike indices of the instruments a structure is built on.
function strikesOf(kind, idx) {
  switch (kind) {
    case 'stock': return [];
    case 'callSpread': case 'putSpread': return [idx, idx + 1];
    case 'strangle': case 'riskReversal': case 'callSpreadWide': case 'putSpreadWide': return decodePair(idx);
    case 'butterfly': return decodeTriple(idx);
    case 'condor': return decodeQuad(idx);
  }
  return [idx];
}
function isFocusKind(kind, idx) {
  const st = strikesOf(kind, idx);
  return kind === 'stock' || st.every(i => APP.market.focus.includes(i));
}
// How often the instruments under a structure have traded (calls and puts at its strikes, and itself).
function popularity(kind, idx) {
  const c = APP.market.counts, own = c[`${kind}_${idx}`] || 0;
  return own + strikesOf(kind, idx).reduce((s, i) => s + (c[`call_${i}`] || 0) + (c[`put_${i}`] || 0) + (c[`straddle_${i}`] || 0), 0);
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
  APP.market.tick = [0.01, 0.05, 0.1].includes(APP.config.tick) ? APP.config.tick : 0.05;
  APP.market.counts = {};
  const spot0 = APP.util.rt(APP.util.rand(70, 130));
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
  APP.market.rc = isFutureMode() ? 0 : APP.util.rt(spot0 * (Math.exp((APP.CONST.R - APP.CONST.Q) * APP.market.T) - 1));
  APP.instruments.rc.value = APP.market.rc;
  APP.market._fixedStockQuote = null; // re-rolled once, then held for the whole session if the delta-1 is fixed

  // the flow concentrates on three strikes: the at-the-money one and the ones either side of it
  let atm = 0;
  strikes.forEach((K, i) => { if (Math.abs(K - spot0) < Math.abs(strikes[atm] - spot0)) atm = i; });
  APP.market.focus = [atm - 1, atm, atm + 1].filter(i => i >= 0 && i < strikes.length);
  // ... and on a couple of the instruments (e.g. the calls and the straddles), not all of them
  APP.market.hotKinds = mainOptionKinds().slice().sort(() => Math.random() - 0.5).slice(0, 2);

  const simLenSec = sessionLenSec();
  APP.market.lenSec = simLenSec;
  const maxTurns = Math.max(1, Math.floor(simLenSec / 180));
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
