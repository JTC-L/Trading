// Event engine: order-book cells, customer flow (new markets, improvements, trades), one-at-a-time
// RFQs (board and IDB), and the user's own orders.
//
// A cell is a small order book. Live levels ({px, size, user}) sit in cell.bids / cell.asks, best
// first; `size` is other participants' size and `user` is the user's own. Customers and other
// market makers never pull their own quotes — a level only leaves the book by trading (or by being
// pushed beyond the visible depth). When a side is fully traded out it either settles to an
// indicative mark at the traded price or is re-requested from the user as a one-sided RFQ.

function getCell(kind, idx, book) {
  if (kind === 'stock') return APP.instruments.stock;
  if (book) return spreadBookCellFor(kind, idx);
  switch (kind) {
    case 'ps': return APP.instruments.ps[idx];
    case 'call': return APP.instruments.call[idx];
    case 'put': return APP.instruments.put[idx];
    case 'bw': return APP.instruments.bw[idx];
    case 'straddle': return APP.instruments.straddle[idx];
    case 'callSpread': return APP.instruments.callSpread[idx];
    case 'putSpread': return APP.instruments.putSpread[idx];
  }
  return null;
}

function describeInstrument(kind, idx, book) {
  const s = APP.market.strikes;
  const suffix = book ? ' (book)' : '';
  switch (kind) {
    case 'stock': return delta1Name();
    case 'ps': return `${s[idx]} P+S${suffix}`;
    case 'call': return `${s[idx]} Call${suffix}`;
    case 'put': return `${s[idx]} Put${suffix}`;
    case 'bw': return `${s[idx]} B/W${suffix}`;
    case 'callSpread': return `${s[idx]}/${s[idx + 1]} Call Spread${suffix}`;
    case 'putSpread': return `${s[idx]}/${s[idx + 1]} Put Spread${suffix}`;
    case 'straddle': return `${s[idx]} Straddle${suffix}`;
    case 'combo': return `${s[idx]} Combo${suffix}`;
    case 'strangle': { const [i, j] = decodePair(idx); return `${s[i]}/${s[j]} Strangle${suffix}`; }
    case 'riskReversal': { const [i, j] = decodePair(idx); return `${s[i]}/${s[j]} Risk Reversal${suffix}`; }
    case 'callSpreadWide': { const [i, j] = decodePair(idx); return `${s[i]}/${s[j]} Call Spread${suffix}`; }
    case 'putSpreadWide': { const [i, j] = decodePair(idx); return `${s[i]}/${s[j]} Put Spread${suffix}`; }
    case 'butterfly': { const [i, j, k] = decodeTriple(idx); return `${s[i]}/${s[j]}/${s[k]} Butterfly${suffix}`; }
    case 'condor': { const [i, j, k, l] = decodeQuad(idx); return `${s[i]}/${s[j]}/${s[k]}/${s[l]} Condor${suffix}`; }
  }
  return kind;
}

// Visible depth: the main board shows the top 2 levels when the order-book view is on; verticals,
// the spread book and the IDB are always single-level.
function levelCap(kind, book) {
  if (!APP.config.bookView || book) return 1;
  if (kind === 'callSpread' || kind === 'putSpread') return 1;
  return 2;
}

const AMBIENT_SIZE_POOL = [5, 10, 15, 20, 25, 35, 50];
const BIG_SIZE_POOL = [50, 60, 75, 80, 90, 100];
const RFQ_VOLUME_POOL = [10, 20, 25, 50, 75, 100, 150, 200];

function pushTimer(id) { APP.session.timers.push(id); }
function later(fn, ms) { const id = setTimeout(fn, ms); pushTimer(id); return id; }
function running() { return APP.session.status === 'running'; }
function markActivity() { APP.session.lastActivity = Date.now(); }

// ---- cell helpers ------------------------------------------------------------

// Recomputes a cell's derived display fields from its levels / marks / RFQ flag.
function syncCell(cell) {
  const b = cell.bids[0], a = cell.asks[0];
  cell.bid = b ? b.px : cell.markBid;
  cell.ask = a ? a.px : cell.markAsk;
  cell.bidSize = b ? b.size + b.user : null;
  cell.askSize = a ? a.size + a.user : null;
  cell.userBidSize = b ? b.user : 0;
  cell.userAskSize = a ? a.user : 0;
  if (cell.rfqSide) cell.status = 'rfq';
  else if (cell.bids.length || cell.asks.length) cell.status = 'live';
  else if (cell.markBid != null || cell.markAsk != null) cell.status = 'indicative';
  else cell.status = 'empty';
}

function hasLevels(cell) { return cell.bids.length > 0 || cell.asks.length > 0; }

function userHasOrders(cell) {
  return cell.bids.some(l => l.user > 0) || cell.asks.some(l => l.user > 0);
}

// Adds `size` at `px` on a side. Same price -> joins that level (behind existing size). Better than
// the best -> becomes the new best and pushes the rest down, with whatever falls beyond `cap`
// dropping off. Worse than everything visible -> not placed.
function insertLevel(cell, side, px, size, owner, cap) {
  const arr = side === 'bid' ? cell.bids : cell.asks;
  px = Math.round(px * 100) / 100;
  const existing = arr.find(l => Math.abs(l.px - px) < 1e-6);
  if (existing) {
    if (owner === 'user') existing.user += size; else existing.size += size;
    return { placed: true, becameBest: false, dropped: [] };
  }
  const better = side === 'bid' ? (a, b) => a > b + 1e-9 : (a, b) => a < b - 1e-9;
  let pos = arr.findIndex(l => better(px, l.px));
  if (pos === -1) pos = arr.length;
  if (pos >= cap) return { placed: false };
  arr.splice(pos, 0, { px, size: owner === 'cust' ? size : 0, user: owner === 'user' ? size : 0 });
  const dropped = arr.length > cap ? arr.splice(cap) : [];
  return { placed: true, becameBest: pos === 0, dropped };
}

function wouldCross(cell, side, px) {
  if (side === 'bid') return cell.asks.length > 0 && px >= cell.asks[0].px - 1e-9;
  return cell.bids.length > 0 && px <= cell.bids[0].px + 1e-9;
}

function notifyDropped(kind, idx, book, dropped) {
  if (dropped && dropped.some(l => l.user > 0)) {
    toast(`Your order in ${describeInstrument(kind, idx, book)} was pushed out of the visible levels and cancelled.`);
  }
}

function logFlow(text, color) {
  APP.history.unshift({ id: APP.util.uid(), text, color, ts: APP.session.elapsedSec });
  if (APP.history.length > 300) APP.history.length = 300;
  flashFlowPanel(color === 'green' ? 'green' : 'red');
}

// ---- candidate pools ----------------------------------------------------------

function allCells() { return enumerateBoardCells().concat(enumerateSpreadBookCells()); }

// Cells with nothing live and no pending request — free for a new market or an RFQ.
function freeCells() {
  return allCells().filter(c => c.kind !== 'stock' && !hasLevels(c.cell) && !c.cell.rfqSide);
}
function liveCells(includeDelta1) {
  return allCells().filter(c => (includeDelta1 || c.kind !== 'stock') && hasLevels(c.cell));
}

function weightFor(kind) {
  if (kind === 'callSpread' || kind === 'putSpread') return 1;
  if (isBookKind(kind)) return 1;
  return 3;
}
function weightedPick(list) {
  const pool = [];
  list.forEach(c => { const w = c.weight || weightFor(c.kind); for (let i = 0; i < w; i++) pool.push(c); });
  return APP.util.choice(pool);
}

// How often a customer trade is driven by a price being off fair value (rather than by the theme).
function informedProbability() { return 0.45; }

// The spread book only ever displays up to 2 instruments at once. Returns true if `kind`/`idx`
// has (or now has) a slot; false if the book is full of currently-active (non-indicative) entries.
function ensureSpreadBookSlot(kind, idx) {
  const active = APP.spreadBook.active;
  if (active.some(a => a.kind === kind && a.idx === idx)) return true;
  if (active.length < 2) { active.push({ kind, idx }); return true; }
  const evictAt = active.findIndex(a => {
    const c = spreadBookCellFor(a.kind, a.idx);
    return !hasLevels(c) && !c.rfqSide;
  });
  if (evictAt === -1) return false;
  Object.assign(spreadBookCellFor(active[evictAt].kind, active[evictAt].idx), makeCell());
  active.splice(evictAt, 1, { kind, idx });
  return true;
}

// ---- quote construction --------------------------------------------------------

// `neutral` quotes sit squarely on fair value (no mispricing) — the opening markets the user anchors on.
function buildLiveQuoteForCell(kind, idx, size, neutral) {
  const mid = fairMid(kind, idx);
  const [lo, hi] = widthRange(kind, size);
  const liveWidth = APP.util.rand(lo, hi) * 0.6;
  let bid = mid - liveWidth / 2, ask = mid + liveWidth / 2;
  let advantage = 'neutral';
  const roll = neutral ? 1 : Math.random();
  if (roll < 0.25) {
    // "good for the user" skew only ever narrows the market, so it can't blow the width cap.
    const skew = APP.util.rand(0.1, Math.max(0.15, liveWidth));
    if (Math.random() < 0.5) ask -= skew; else bid += skew;
    advantage = 'good';
  } else if (roll < 0.40) {
    // "bad for the user" skew widens the market — squeeze it back afterward so total width never
    // exceeds hi, the same cap ambient/tight markets are held to elsewhere.
    const skew = APP.util.rand(0.1, Math.max(0.15, liveWidth));
    if (Math.random() < 0.5) ask += skew; else bid -= skew;
    advantage = 'bad';
  }
  if (ask - bid > hi) {
    const over = (ask - bid) - hi;
    ask -= over / 2; bid += over / 2;
  }
  const floor = priceFloorFor(kind);
  bid = APP.util.round5c(Math.max(floor, bid));
  ask = APP.util.round5c(Math.max(bid + 0.05, ask));
  return { bid, ask, advantage };
}

// ---- the delta-1 instrument (future / stock): always live ----------------------

// Sized in "option-contract-equivalent" terms (a contract is 100 units), reflecting that the
// underlying's liquidity is driven by the options market makers hedging on it. When the delta-1
// is fixed for the session it's far more liquid (~10000 vs ~50 in the ITM options); when vol is
// fixed instead, delta-1 and options liquidity are more comparable (~4000).
function stockSizeChoice() {
  const mode = APP.config.certaintyMode;
  if (mode === 'stock') return APP.util.choice([80, 90, 100, 110, 120]) * 100;
  if (mode === 'vol') return APP.util.choice([32, 36, 40, 44, 48]) * 100;
  return APP.util.choice([5, 10, 15, 20, 25]) * 100;
}

function fillUserOrderAgainstDelta1(side, px, size) {
  addTrade('stock', 0, side, size, px);
  logFlow(`Customer ${side === 'buy' ? 'sold' : 'bought'} ${size} ${delta1Name()} at ${fmt(px)} from you`, 'red');
}

function rebuildDelta1(cell) {
  const cap = levelCap('stock', false);
  const fixed = APP.config.certaintyMode === 'stock';
  const bidSize = stockSizeChoice(), askSize = stockSizeChoice();
  let q;
  if (fixed) {
    // the delta-1 price is fixed for the whole session — generate it once and never again.
    if (!APP.market._fixedStockQuote) APP.market._fixedStockQuote = buildLiveQuoteForCell('stock', 0, Math.max(bidSize, askSize));
    q = APP.market._fixedStockQuote;
  } else {
    q = buildLiveQuoteForCell('stock', 0, Math.max(bidSize, askSize));
  }
  APP.market._d1Quote = q;
  const userBids = cell.bids.filter(l => l.user > 0).map(l => ({ px: l.px, size: l.user }));
  const userAsks = cell.asks.filter(l => l.user > 0).map(l => ({ px: l.px, size: l.user }));
  cell.bids = [{ px: q.bid, size: bidSize, user: 0 }];
  cell.asks = [{ px: q.ask, size: askSize, user: 0 }];
  if (cap > 1) {
    cell.bids.push({ px: APP.util.round5c(q.bid - 0.05 * APP.util.randInt(1, 2)), size: stockSizeChoice(), user: 0 });
    cell.asks.push({ px: APP.util.round5c(q.ask + 0.05 * APP.util.randInt(1, 2)), size: stockSizeChoice(), user: 0 });
  }
  const reinsert = (side, o) => {
    const r = insertLevel(cell, side, o.px, o.size, 'user', cap);
    notifyDropped('stock', 0, false, r.placed ? r.dropped : [{ user: o.size }]);
  };
  userBids.forEach(o => {
    if (o.px >= q.ask - 1e-9) fillUserOrderAgainstDelta1('buy', o.px, o.size); // the market moved through the user's bid
    else reinsert('bid', o);
  });
  userAsks.forEach(o => {
    if (o.px <= q.bid + 1e-9) fillUserOrderAgainstDelta1('sell', o.px, o.size);
    else reinsert('ask', o);
  });
}

// Refills customer levels the user (or a customer trade) has consumed.
function topUpDelta1(cell) {
  const cap = levelCap('stock', false);
  const q = APP.market._d1Quote || APP.market._fixedStockQuote;
  if (!q) { rebuildDelta1(cell); return; }
  if (!cell.bids.length) cell.bids.push({ px: q.bid, size: stockSizeChoice(), user: 0 });
  if (!cell.asks.length) cell.asks.push({ px: q.ask, size: stockSizeChoice(), user: 0 });
  if (cap > 1) {
    if (cell.bids.length < 2) cell.bids.push({ px: APP.util.round5c(cell.bids[0].px - 0.05 * APP.util.randInt(1, 2)), size: stockSizeChoice(), user: 0 });
    if (cell.asks.length < 2) cell.asks.push({ px: APP.util.round5c(cell.asks[0].px + 0.05 * APP.util.randInt(1, 2)), size: stockSizeChoice(), user: 0 });
  }
}

function refreshStockQuote() {
  if (!running()) return;
  const cell = APP.instruments.stock;
  const fixed = APP.config.certaintyMode === 'stock';
  const custBid = cell.bids.find(l => l.size > 0), custAsk = cell.asks.find(l => l.size > 0);
  const mid = (custBid && custAsk) ? (custBid.px + custAsk.px) / 2 : null;
  if (mid === null || (!fixed && Math.abs(mid - currentSpot()) > 0.15)) rebuildDelta1(cell);
  else topUpDelta1(cell);
  syncCell(cell);
  renderAll();
  later(refreshStockQuote, tradePaceSec() * 1000 * APP.util.rand(0.4, 0.9));
}

// ---- customer flow: new markets ------------------------------------------------

// `anchor`: an opening market — fair-centred, and put up quietly (no flow entry, no flash).
function spawnMarket(pick, anchor) {
  const { kind, idx, cell, book } = pick;
  const cap = levelCap(kind, book);
  const bidSize = APP.util.choice(AMBIENT_SIZE_POOL), askSize = APP.util.choice(AMBIENT_SIZE_POOL);
  const q = buildLiveQuoteForCell(kind, idx, Math.max(bidSize, askSize), !!anchor);
  cell.markBid = null; cell.markAsk = null;
  cell.bids = [{ px: q.bid, size: bidSize, user: 0 }];
  cell.asks = [{ px: q.ask, size: askSize, user: 0 }];
  if (cap > 1) {
    const floor = priceFloorFor(kind);
    const b2 = APP.util.round5c(q.bid - 0.05 * APP.util.randInt(1, 2));
    const a2 = APP.util.round5c(q.ask + 0.05 * APP.util.randInt(1, 2));
    if (b2 >= floor) cell.bids.push({ px: b2, size: APP.util.choice(AMBIENT_SIZE_POOL), user: 0 });
    cell.asks.push({ px: a2, size: APP.util.choice(AMBIENT_SIZE_POOL), user: 0 });
  }
  syncCell(cell);
  if (anchor) return;
  const desc = describeInstrument(kind, idx, book);
  logFlow(`Customer made ${desc}: ${fmt(q.bid)} x${bidSize} / ${fmt(q.ask)} x${askSize}`, 'green');
  flashCell(kind, idx, book, 'green');
  markActivity();
}

// ---- how a session opens ---------------------------------------------------------
// The user starts from a few anchors that are already trading, then makes a market in every other
// box of the main board, one request at a time. Only once the board is complete does the clock start
// and the customers arrive — so each market the user makes can be judged against something real.
//   delta-1 fixed (or neither): the delta-1, the vertical spreads, and one option/straddle (the ATM one)
//   vol fixed: just the ATM straddle (in the spread book, for stock mode) and the vertical spreads
function atmIndex() {
  const s = APP.market.strikes, spot = APP.market.spot0;
  let best = 0;
  s.forEach((K, i) => { if (Math.abs(K - spot) < Math.abs(s[best] - spot)) best = i; });
  return best;
}

function seedOpeningMarkets() {
  const N = APP.market.strikes.length, atm = atmIndex();
  const put = (kind, idx, book) => {
    const cell = getCell(kind, idx, book);
    if (!cell) return;
    if (book && !ensureSpreadBookSlot(kind, idx)) return;
    spawnMarket({ kind, idx, cell, book: !!book }, true);
  };
  if (APP.config.spreadsOn) {
    for (let i = 0; i < N - 1; i++) { put('callSpread', i, false); put('putSpread', i, false); }
  }
  if (APP.config.certaintyMode === 'vol') {
    if (isFutureMode()) put('straddle', atm, false);
    else if (APP.config.spreadBookOn) put('straddle', atm, true);
    else put('call', atm, false); // no spread book to hold the straddle: anchor on the ATM call instead
  } else {
    put(isFutureMode() ? 'straddle' : 'call', atm, false);
  }
}

// The main-board boxes the user has left to make, working out from the money so that each one can be
// worked out from what's already there (ATM call/put from the future and the straddle, then each
// neighbouring strike from the verticals, then its straddle from its call and put).
function buildSetupQueue() {
  const N = APP.market.strikes.length, atm = atmIndex();
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => Math.abs(a - atm) - Math.abs(b - atm) || a - b);
  const kinds = isFutureMode() ? ['call', 'put', 'straddle'] : ['call', 'put', 'ps', 'bw'];
  const q = [];
  order.forEach(i => kinds.forEach(kind => {
    if (!hasLevels(getCell(kind, i, false))) q.push({ kind, idx: i });
  }));
  return q;
}

function setupLeft() { return APP.session.setupQueue.length + (APP.session.rfqActive && APP.session.rfqActive.type === 'board' && APP.session.phase === 'setup' ? 1 : 0); }

// ---- customer flow: improvements -----------------------------------------------

// Quotes (name -> {bid, ask}) for every same-strike instrument that has a two-sided live book —
// what a customer (or the user) could actually trade against.
function strikeQuotes(idx, excludeName, includeMarks) {
  const vecs = arbVectors(APP.market.delta1, APP.market.strikes[idx], APP.market.rc);
  const quotes = {};
  Object.keys(vecs).forEach(name => {
    if (name === excludeName) return;
    const cell = name === 'stock' ? APP.instruments.stock : getCell(name, idx, false);
    if (!cell) return;
    if (includeMarks) {
      if (cell.bid != null && cell.ask != null) quotes[name] = { bid: cell.bid, ask: cell.ask };
    } else if (cell.bids.length && cell.asks.length) {
      quotes[name] = { bid: cell.bids[0].px, ask: cell.asks[0].px };
    }
  });
  return { vecs, quotes };
}

// A price that would genuinely create a same-strike arbitrage against the other live books.
function arbImprovementPx(kind, idx, cell, side) {
  if (!mainOptionKinds().includes(kind)) return null;
  const { vecs, quotes } = strikeQuotes(idx, kind, false);
  const best = bestMarketFromOthers(vecs, kind, quotes);
  const edge = APP.util.choice([0.05, 0.10, 0.15]);
  let px;
  if (side === 'ask') {
    if (best.bid == null) return null;
    px = APP.util.floor5c(best.bid - edge);
    if (!(px < best.bid - 1e-9)) return null;
  } else {
    if (best.ask == null) return null;
    px = APP.util.ceil5c(best.ask + edge);
    if (!(px > best.ask + 1e-9)) return null;
  }
  return px;
}

// A sensible one-tick improvement toward (but never through) fair value.
function normalImprovementPx(kind, idx, cell, side) {
  const fair = fairMid(kind, idx);
  const own = side === 'bid' ? cell.bids[0] : cell.asks[0];
  let px;
  if (own) px = APP.util.round5c(own.px + (side === 'bid' ? 0.05 : -0.05));
  else {
    const mark = side === 'bid' ? cell.markBid : cell.markAsk;
    px = mark != null ? mark : APP.util.round5c(fair + (side === 'bid' ? -0.1 : 0.1));
  }
  if (side === 'bid' && px > fair + 0.025) return null;
  if (side === 'ask' && px < fair - 0.025) return null;
  return px;
}

function fireImprove() {
  const cands = liveCells(false);
  if (!cands.length) return;
  cands.forEach(c => { c.weight = userHasOrders(c.cell) ? 4 : weightFor(c.kind); });
  const pick = weightedPick(cands);
  const { kind, idx, cell, book } = pick;
  if (cell.rfqSide) return;
  const cap = levelCap(kind, book);
  const side = Math.random() < 0.5 ? 'bid' : 'ask';
  const floor = priceFloorFor(kind);

  let px = null, arbMode = false;
  if (!book && Math.random() < 0.45) { px = arbImprovementPx(kind, idx, cell, side); arbMode = px !== null; }
  if (px === null) px = normalImprovementPx(kind, idx, cell, side);
  if (px === null) return;
  if (side === 'bid' && px < floor) return;
  if (side === 'ask' && px < floor + 0.05) return;
  const own = side === 'bid' ? cell.bids[0] : cell.asks[0];
  if (own && !(side === 'bid' ? px > own.px + 1e-9 : px < own.px - 1e-9)) return; // must genuinely improve
  if (wouldCross(cell, side, px)) {
    if (!arbMode) return;
    // An arb-creating price usually sits through the cell's own opposite side (books are tight, so
    // the synthetic is wider than the cell itself): the customer pays up through it first — a real
    // trade, which fills the user if they were resting there — and then rests the rich price.
    for (let guard = 0; guard < 2 && wouldCross(cell, side, px); guard++) {
      const opp = side === 'bid' ? cell.asks[0] : cell.bids[0];
      customerTrade(kind, idx, book, cell, side === 'bid' ? 'buy' : 'sell', opp.size + opp.user);
    }
    if (wouldCross(cell, side, px)) return;
  }

  // often a bigger clip than whatever the user is showing
  const userSz = own ? own.user : 0;
  let size = APP.util.choice(BIG_SIZE_POOL);
  if (userSz > 0) size = Math.max(size, Math.ceil(userSz * 1.5 / 5) * 5);

  const res = insertLevel(cell, side, px, size, 'cust', cap);
  if (!res.placed) return;
  if (arbMode) { // keep the (now stale) mark on the side that was just paid up through consistent
    if (side === 'bid' && !cell.asks.length) cell.markAsk = APP.util.round5c(px + 0.1);
    if (side === 'ask' && !cell.bids.length) cell.markBid = APP.util.round5c(Math.max(floor, px - 0.1));
  }
  syncCell(cell);
  const desc = describeInstrument(kind, idx, book);
  logFlow(`Customer ${side === 'bid' ? 'bid' : 'offered'} ${fmt(px)} x${size} in ${desc}`, 'green');
  flashCell(kind, idx, book, 'green');
  notifyDropped(kind, idx, book, res.dropped);
  markActivity();
  renderAll();
}

// Customers sometimes just add size at the best price (behind whoever's already there).
function fireJoin() {
  const cands = liveCells(false);
  if (!cands.length) return;
  const { cell } = APP.util.choice(cands);
  const side = Math.random() < 0.5 ? 'bid' : 'ask';
  const lvl = side === 'bid' ? cell.bids[0] : cell.asks[0];
  if (!lvl) return;
  lvl.size += APP.util.choice([5, 10, 15, 20, 25]);
  syncCell(cell);
}

// ---- customer flow: trades -----------------------------------------------------

// After a side is fully traded out: settle it to an indicative mark at the traded price, and half
// the time also ask the user for a fresh quote on that side.
function onSideExhausted(kind, idx, book, cell, bookSide, px) {
  if (kind === 'stock') { topUpDelta1(cell); syncCell(cell); return; }
  const floor = priceFloorFor(kind);
  if (bookSide === 'bid') {
    cell.markBid = px;
    const otherLive = cell.asks.length > 0;
    if (!otherLive && (cell.markAsk == null || cell.markAsk <= px + 1e-9)) {
      const q = makeIndicativeQuote(kind, idx);
      cell.markAsk = APP.util.round5c(Math.max(q.ask, px + 0.05));
    }
  } else {
    cell.markAsk = px;
    const otherLive = cell.bids.length > 0;
    if (!otherLive && (cell.markBid == null || cell.markBid >= px - 1e-9)) {
      const q = makeIndicativeQuote(kind, idx);
      cell.markBid = APP.util.round5c(Math.max(floor, Math.min(q.bid, px - 0.05)));
    }
  }
  syncCell(cell);
  if (Math.random() < 0.5 && !APP.session.rfqQueue.some(r => r.kind === kind && r.idx === idx && !!r.book === !!book && r.side === bookSide)) {
    APP.session.rfqQueue.push({ kind, idx, book: !!book, side: bookSide });
  }
}

// How much a customer takes from the best price: all of it 70% of the time, otherwise a part of it.
function customerClipSize(kind, total) {
  if (kind === 'stock') return Math.min(total, APP.util.choice([500, 1000, 2000, 3000]));
  return Math.random() < 0.7 ? total : Math.max(5, Math.round(total * APP.util.rand(0.2, 0.9) / 5) * 5);
}

// side: 'buy' = the customer lifts the offer, 'sell' = the customer hits the bid.
function customerTrade(kind, idx, book, cell, side, qty) {
  const arr = side === 'buy' ? cell.asks : cell.bids;
  const lvl = arr[0];
  if (!lvl) return;
  const px = lvl.px;
  const total = lvl.size + lvl.user;
  const q = Math.min(qty, total);
  if (q <= 0) return;
  const fromOthers = Math.min(q, lvl.size);
  const fromUser = q - fromOthers;
  lvl.size -= fromOthers;
  lvl.user -= fromUser;
  if (fromUser > 0) addTrade(kind, idx, side === 'buy' ? 'sell' : 'buy', fromUser, px);
  const desc = describeInstrument(kind, idx, book);
  const suffix = fromUser > 0 ? (fromUser === q ? ' from you' : ` (${fromUser} from you)`) : '';
  logFlow(`Customer ${side === 'buy' ? 'bought' : 'sold'} ${q} ${desc} at ${fmt(px)}${suffix}`, fromUser > 0 ? 'red' : 'yellow');
  flashCell(kind, idx, book, 'red');
  const gone = lvl.size <= 0 && lvl.user <= 0;
  if (gone) arr.shift();
  // the delta-1 is deep and always re-quoted: a traded-out best level is replenished at the same price
  if (gone && kind === 'stock') arr.unshift({ px, size: stockSizeChoice(), user: 0 });
  syncCell(cell);
  if (gone && arr.length === 0) onSideExhausted(kind, idx, book, cell, side === 'buy' ? 'ask' : 'bid', px);
  markActivity();
  renderAll();
}

function fireCustomerTrade() {
  const cands = liveCells(true);
  if (!cands.length) return;
  cands.forEach(c => { c.weight = c.kind === 'stock' ? 1 : (userHasOrders(c.cell) ? 5 : 2); });
  const { kind, idx, cell, book } = weightedPick(cands);
  if (cell.rfqSide) return;
  const fair = fairMid(kind, idx);
  const ask = cell.asks[0], bid = cell.bids[0];
  const canBuy = !!ask;
  const canSell = !!bid && !((kind === 'call' || kind === 'put') && bid.px <= 0); // never reward a 0 bid with a trade
  let side = null;
  if (Math.random() < informedProbability()) {
    const eb = canBuy ? fair - ask.px : -Infinity, es = canSell ? bid.px - fair : -Infinity;
    if (eb > 0.05 && eb >= es) side = 'buy';
    else if (es > 0.05) side = 'sell';
  }
  if (!side && Math.random() < 0.5) {
    const opts = [];
    if (canBuy) opts.push('buy');
    if (canSell) opts.push('sell');
    if (opts.length) side = APP.util.choice(opts);
  }
  if (!side) return;
  const lvl = side === 'buy' ? ask : bid;
  const total = lvl.size + lvl.user;
  customerTrade(kind, idx, book, cell, side, customerClipSize(kind, total));
}

// ---- the session's theme: what the customers believe -------------------------------
// Customers share a view (rising vol, a falling market...) and it shows in what they do: they take
// liquidity in that direction, and the fair values then bear the view out (see pickTheme in market.js).
// 'buy' = they lift offers, 'sell' = they hit bids; null = this instrument isn't a way to express it.
function themeSideFor(kind) {
  const t = APP.market.theme;
  if (!t) return null;
  const up = t.dir > 0;
  if (t.variable === 'vol') { // long vol: calls, puts, straddles, strangles (and the stock-mode combos)
    return ['call', 'put', 'straddle', 'ps', 'bw', 'strangle'].includes(kind) ? (up ? 'buy' : 'sell') : null;
  }
  if (['call', 'ps', 'callSpread', 'callSpreadWide', 'riskReversal', 'stock'].includes(kind)) return up ? 'buy' : 'sell';
  if (['put', 'bw', 'putSpread', 'putSpreadWide'].includes(kind)) return up ? 'sell' : 'buy';
  return null; // straddles, butterflies... are neutral to a view on direction
}

// Customers still want a sensible price: a price far from fair rarely gets lifted/hit.
function themeAcceptProbability(kind, idx, side, px) {
  const fair = fairMid(kind, idx);
  const edgeAgainstThem = side === 'buy' ? px - fair : fair - px; // how much they're giving up
  const tol = kind === 'stock' ? 0.5 : 0.3;
  if (edgeAgainstThem <= 0.10) return 1;
  if (edgeAgainstThem >= tol) return 0;
  return 1 - 0.85 * (edgeAgainstThem - 0.10) / (tol - 0.10);
}

function fireThemeTrade() {
  const cands = [];
  liveCells(true).forEach(c => {
    if (c.cell.rfqSide) return;
    const side = themeSideFor(c.kind);
    if (!side) return;
    const lvl = side === 'buy' ? c.cell.asks[0] : c.cell.bids[0];
    if (!lvl) return;
    if (side === 'sell' && (c.kind === 'call' || c.kind === 'put') && lvl.px <= 0) return; // never reward a 0 bid
    if (Math.random() > themeAcceptProbability(c.kind, c.idx, side, lvl.px)) return;
    cands.push(Object.assign({}, c, { side, lvl, weight: c.kind === 'stock' ? 1 : (lvl.user > 0 ? 6 : 2) }));
  });
  if (!cands.length) return false;
  const pick = weightedPick(cands);
  const total = pick.lvl.size + pick.lvl.user;
  customerTrade(pick.kind, pick.idx, pick.book, pick.cell, pick.side, customerClipSize(pick.kind, total));
  if (pick.kind !== 'stock' && Math.random() < 0.65) scheduleFollowOn(pick.kind, pick.idx, pick.book, pick.side);
  return true;
}

// A customer's resting order: improve the best price a tick if that's sensible, otherwise add size to it.
function restCustomerOrder(pick, side) {
  const { kind, idx, cell, book } = pick;
  const cap = levelCap(kind, book), floor = priceFloorFor(kind);
  const own = side === 'bid' ? cell.bids[0] : cell.asks[0];
  const px = normalImprovementPx(kind, idx, cell, side);
  const improves = px !== null && !(side === 'bid' ? px < floor : px < floor + 0.05) && !wouldCross(cell, side, px)
    && (!own || (side === 'bid' ? px > own.px + 1e-9 : px < own.px - 1e-9));
  let size = APP.util.choice(BIG_SIZE_POOL);
  if (own && own.user > 0) size = Math.max(size, Math.ceil(own.user * 1.5 / 5) * 5);
  const desc = describeInstrument(kind, idx, book);
  if (improves) {
    const res = insertLevel(cell, side, px, size, 'cust', cap);
    if (!res.placed) return false;
    syncCell(cell);
    logFlow(`Customer ${side === 'bid' ? 'bid' : 'offered'} ${fmt(px)} x${size} in ${desc}`, 'green');
    notifyDropped(kind, idx, book, res.dropped);
  } else if (own) {
    own.size += size;
    syncCell(cell);
    logFlow(`Customer added ${size} to the ${side === 'bid' ? 'bid' : 'offer'} at ${fmt(own.px)} in ${desc}`, 'green');
  } else return false;
  flashCell(kind, idx, book, 'green');
  markActivity();
  renderAll();
  return true;
}

// Having just traded in one market, customers often put in more orders in similar ones: the same
// instrument at the neighbouring strikes, or the same strike's other options — leaning the same way.
function scheduleFollowOn(kind, idx, book, side) {
  later(() => {
    if (!running() || APP.session.phase !== 'flow') return;
    const wantSide = themeSideFor(kind);
    const sims = [];
    const add = (k, i) => {
      const c = getCell(k, i, false);
      if (c && hasLevels(c) && !c.rfqSide && themeSideFor(k) === wantSide) sims.push({ kind: k, idx: i, cell: c, book: false });
    };
    if (!book) {
      add(kind, idx - 1); add(kind, idx + 1);
      mainOptionKinds().forEach(k => { if (k !== kind) add(k, idx); });
    }
    if (!sims.length) return;
    restCustomerOrder(APP.util.choice(sims), side === 'buy' ? 'bid' : 'ask'); // a buyer bids, a seller offers
  }, APP.util.rand(2500, 7000));
}

// ---- event loops (customer flow begins only once the board is made) -----------------

function loopTheme() {
  if (!running()) return;
  if (Math.random() < 0.8) { if (!fireThemeTrade()) fireCustomerTrade(); }
  else fireCustomerTrade(); // the odd trade for a plain pricing reason
  later(loopTheme, tradePaceSec() * 1000 * APP.util.rand(0.25, 0.55));
}
function loopImprove() { // rare: someone improves a price — sometimes enough to create a parity arb
  if (!running()) return;
  fireImprove();
  later(loopImprove, tradePaceSec() * 1000 * APP.util.rand(1.0, 2.0));
}

// Never let the user sit idle with nothing happening once the flow has started.
function watchdogTick() {
  if (!running()) return;
  if (Date.now() - APP.session.lastActivity > 25000) { if (!fireThemeTrade()) fireCustomerTrade(); }
  later(watchdogTick, APP.util.rand(6000, 9000));
}

// ---- the user's own actions ----------------------------------------------------

function validateOrderPrice(kind, side, px) {
  if (isNaN(px)) return 'Enter a price.';
  if (kind === 'ps' || kind === 'bw') return null; // strike-relative combos — negative/zero are legitimate
  if (kind === 'call' || kind === 'put') {
    if (side === 'bid' && px < 0) return 'Bid cannot be negative.';
    if (side === 'ask' && px <= 0) return 'Offer must be positive.';
    return null;
  }
  if (px <= 0) return 'Price must be positive.';
  return null;
}

// Rest an order of the user's own on one side of a cell's book.
function placeUserOrder(kind, idx, book, side, px, size) {
  if (!running()) return { error: 'Session is not running.' };
  const cell = getCell(kind, idx, book);
  if (!cell) return { error: 'No such market.' };
  if (cell.rfqSide) return { error: 'Answer the request in the red box first.' };
  if (!Number.isInteger(size) || size <= 0) return { error: 'Size must be a positive whole number.' };
  const bad = validateOrderPrice(kind, side, px);
  if (bad) return { error: bad };
  px = APP.util.round5c(px);
  if (wouldCross(cell, side, px)) return { error: `That ${side === 'bid' ? 'bid' : 'offer'} crosses the market — click the ${side === 'bid' ? 'offer' : 'bid'} to take it instead.` };
  const cap = levelCap(kind, book);
  // order-book cells take top-of-book quotes only: join the best price or improve it
  const best = side === 'bid' ? cell.bids[0] : cell.asks[0];
  if (cap > 1 && best && (side === 'bid' ? px < best.px - 1e-9 : px > best.px + 1e-9)) {
    return { error: `Top of book only: a ${side === 'bid' ? 'bid' : 'offer'} must be ${fmt(best.px)} or ${side === 'bid' ? 'higher' : 'lower'}.` };
  }
  const res = insertLevel(cell, side, px, size, 'user', cap);
  if (!res.placed) return { error: `Outside the top ${cap} level${cap > 1 ? 's' : ''} — price it better than the ${cap > 1 ? 'second-best' : 'best'} level.` };
  syncCell(cell);
  notifyDropped(kind, idx, book, res.dropped);
  toast(`Order placed: ${side === 'bid' ? 'bid' : 'offer'} ${size} ${describeInstrument(kind, idx, book)} @ ${fmt(px)}`);
  markActivity();
  renderAll();
  return { ok: true };
}

// Remove the user's own size from a cell (one side, or both).
function cancelUserOrders(kind, idx, book, side) {
  const cell = getCell(kind, idx, book);
  if (!cell) return;
  ['bid', 'ask'].forEach(s => {
    if (side && side !== s) return;
    const arr = s === 'bid' ? cell.bids : cell.asks;
    arr.forEach(l => { l.user = 0; });
    const kept = arr.filter(l => l.size > 0);
    if (s === 'bid') cell.bids = kept; else cell.asks = kept;
  });
  if (!hasLevels(cell) && cell.markBid == null && cell.markAsk == null) {
    const q = makeIndicativeQuote(kind, idx);
    cell.markBid = q.bid; cell.markAsk = q.ask;
  }
  syncCell(cell);
  toast(`You cancelled your order in ${describeInstrument(kind, idx, book)}.`);
  renderAll();
}

function handlePull(kind, idx, book) {
  if (!running() || APP.session.boardFrozen) return;
  cancelUserOrders(kind, idx, book, null);
}

// The user lifts the offer (side 'buy') or hits the bid (side 'sell') at the best level, for up to
// the other participants' size there (never their own).
function executeUserTake(kind, idx, book, side, qty) {
  if (!running()) return { error: 'Session is not running.' };
  if (APP.session.boardFrozen) return { error: 'Board trading is frozen during an IDB request.' };
  const cell = getCell(kind, idx, book);
  if (!cell) return { error: 'No such market.' };
  const arr = side === 'buy' ? cell.asks : cell.bids;
  const lvl = arr[0];
  if (!lvl) return { error: 'No live price to take.' };
  if (lvl.size <= 0) return { error: 'That level is your own order.' };
  if (!Number.isInteger(qty) || qty <= 0) return { error: 'Size must be a positive whole number.' };
  const q = Math.min(qty, lvl.size);
  const px = lvl.px;
  lvl.size -= q;
  addTrade(kind, idx, side, q, px);
  logFlow(`You ${side === 'buy' ? 'bought' : 'sold'} ${q} ${describeInstrument(kind, idx, book)} at ${fmt(px)}`, 'blue');
  flashCell(kind, idx, book, 'red');
  const gone = lvl.size <= 0 && lvl.user <= 0;
  if (gone) arr.shift();
  if (gone && kind === 'stock') arr.unshift({ px, size: stockSizeChoice(), user: 0 });
  syncCell(cell);
  if (gone && arr.length === 0) onSideExhausted(kind, idx, book, cell, side === 'buy' ? 'ask' : 'bid', px);
  markActivity();
  renderAll();
  return { ok: true, qty: q };
}

// Single-price view's Yours/Mine buttons: take everything available at the best price.
function handleTake(kind, idx, book, side) {
  const cell = getCell(kind, idx, book);
  if (!cell) return;
  const lvl = (side === 'buy' ? cell.asks : cell.bids)[0];
  if (!lvl || lvl.size <= 0) return;
  executeUserTake(kind, idx, book, side, lvl.size);
}

// ---- RFQs: strictly one market asked for at a time -----------------------------

// Whether the other same-strike books on the screen are enough to work out a price for `kind`.
function isParityDerivable(kind, idx) {
  if (!mainOptionKinds().includes(kind)) return false;
  const { vecs, quotes } = strikeQuotes(idx, kind, true);
  const best = bestMarketFromOthers(vecs, kind, quotes);
  return best.bid != null && best.ask != null;
}

function pickRfqSide(cell) {
  if (cell.markBid == null || cell.markAsk == null) return 'both';
  const r = Math.random();
  if (r < 0.55) return 'both';
  return r < 0.775 ? 'bid' : 'ask';
}

function armRfq(pick, sideOverride) {
  const { kind, idx, cell, book } = pick;
  const rfqSide = sideOverride || pickRfqSide(cell);
  cell.rfqSide = rfqSide;
  cell.rfqVolume = APP.util.choice(RFQ_VOLUME_POOL);
  cell._refBid = null; cell._refAsk = null;
  if (rfqSide === 'bid') { // soliciting the bid; the offer is shown as the fixed reference
    const l = cell.asks[0];
    cell._refAsk = l ? { px: l.px, size: l.size + l.user } : { px: cell.markAsk != null ? cell.markAsk : makeIndicativeQuote(kind, idx).ask, size: APP.util.choice(AMBIENT_SIZE_POOL) };
  } else if (rfqSide === 'ask') {
    const l = cell.bids[0];
    cell._refBid = l ? { px: l.px, size: l.size + l.user } : { px: cell.markBid != null ? cell.markBid : makeIndicativeQuote(kind, idx).bid, size: APP.util.choice(AMBIENT_SIZE_POOL) };
  }
  cell._domRfq = false;
  syncCell(cell);
  APP.session.rfqActive = { type: 'board', kind, idx, book: !!book };
}

function scheduleNextRfq(delayMs) {
  if (APP.session.rfqTimer) clearTimeout(APP.session.rfqTimer);
  APP.session.rfqTimer = later(fireNextRfq, delayMs);
}

function onRfqMade() {
  APP.session.rfqActive = null;
  if (APP.session.phase === 'setup') { // keep going until the whole board is made, then the customers arrive
    if (APP.session.setupQueue.length) scheduleNextRfq(450); else beginFlowPhase();
    return;
  }
  scheduleNextRfq(tradePaceSec() * 1000 * APP.util.rand(0.8, 1.6));
}

function fireNextRfq() {
  if (!running()) return;
  if (APP.session.rfqActive) return; // the answer handler reschedules
  if (APP.session.boardFrozen) { scheduleNextRfq(2000); return; }

  // Setup: ask for the main board one box at a time (a box the user already quoted is skipped)
  if (APP.session.phase === 'setup') {
    while (APP.session.setupQueue.length) {
      const r = APP.session.setupQueue.shift();
      const cell = getCell(r.kind, r.idx, false);
      if (!cell || cell.rfqSide || hasLevels(cell)) continue;
      armRfq({ kind: r.kind, idx: r.idx, cell, book: false }, 'both');
      renderAll();
      return;
    }
    beginFlowPhase(); // nothing left to make
    return;
  }

  if (APP.config.idbOn && !APP.idb.active && Math.random() < 0.25) { startIdbRfq(); return; }

  // a queued one-sided re-quote (a side just traded out) comes first
  while (APP.session.rfqQueue.length) {
    const r = APP.session.rfqQueue.shift();
    if (r.book && !APP.config.spreadBookOn) continue;
    const cell = getCell(r.kind, r.idx, r.book);
    if (!cell || cell.rfqSide) continue;
    const sideArr = r.side === 'bid' ? cell.bids : cell.asks;
    if (sideArr.length) continue; // someone already re-quoted it
    if (r.book && !ensureSpreadBookSlot(r.kind, r.idx)) continue;
    armRfq({ kind: r.kind, idx: r.idx, cell, book: r.book }, r.side);
    renderAll();
    return;
  }

  // otherwise a customer asks for a market in something nobody's quoting (spread-book structures)
  const order = freeCells().sort(() => Math.random() - 0.5);
  for (const pick of order) {
    if (pick.book && !ensureSpreadBookSlot(pick.kind, pick.idx)) continue;
    armRfq(pick);
    renderAll();
    return;
  }
  scheduleNextRfq(4000); // nothing free right now
}

// Turn a confirmed market into resting user levels (board / spread book), or resolve it as an IDB
// print. bid/ask/bidSize/askSize are already-parsed numbers.
function submitMarket(kind, idx, book, bid, ask, bidSize, askSize, isIdb) {
  if (!running()) return { error: 'Session is not running.' };
  if (!Number.isInteger(bidSize) || bidSize <= 0) return { error: 'Bid size must be a positive integer.' };
  if (!Number.isInteger(askSize) || askSize <= 0) return { error: 'Ask size must be a positive integer.' };
  if (isNaN(bid) || isNaN(ask)) return { error: 'Enter both a bid and an ask.' };
  // P+S/B-W are strike-relative combo debits/credits, so negative or zero prices are legitimate.
  // Calls/puts may be bid at 0 (just never traded on) but must still offer a positive ask.
  // Everything else keeps the plain positive-price rule.
  if (kind === 'ps' || kind === 'bw') {
    // no sign constraint
  } else if (kind === 'call' || kind === 'put') {
    if (bid < 0) return { error: 'Bid cannot be negative.' };
    if (ask <= 0) return { error: 'Ask must be positive.' };
  } else if (bid <= 0 || ask <= 0) {
    return { error: 'Prices must be positive.' };
  }
  bid = APP.util.round5c(bid); ask = APP.util.round5c(ask);
  if (ask <= bid) return { error: 'Ask must be greater than bid.' };

  if (isIdb) {
    APP.idb.active.bid = bid; APP.idb.active.ask = ask;
    APP.idb.active.bidSize = bidSize; APP.idb.active.askSize = askSize;
    APP.idb.active.status = 'quoted';
    onRfqMade();
    renderAll();
    later(() => resolveIdbDecision(), APP.util.rand(1500, 3200));
  } else {
    const cell = getCell(kind, idx, book);
    const side = cell.rfqSide || 'both';
    const cap = levelCap(kind, book);
    const dropped = [];
    if (side === 'bid' || side === 'both') {
      if (cell.asks.length && bid >= cell.asks[0].px - 1e-9) return { error: 'Bid crosses the live offer.' };
      const r = insertLevel(cell, 'bid', bid, bidSize, 'user', cap); (r.dropped || []).forEach(d => dropped.push(d));
      cell.markBid = null;
    }
    if (side === 'ask' || side === 'both') {
      if (cell.bids.length && ask <= cell.bids[0].px + 1e-9) return { error: 'Offer crosses the live bid.' };
      const r = insertLevel(cell, 'ask', ask, askSize, 'user', cap); (r.dropped || []).forEach(d => dropped.push(d));
      cell.markAsk = null;
    }
    cell.rfqSide = null; cell.rfqVolume = null; cell._refBid = null; cell._refAsk = null;
    syncCell(cell);
    markActivity();
    onRfqMade();
    renderAll();
  }
  return { ok: true };
}

function decideTrade(kind, mid, bid, ask) {
  const informed = Math.random() < informedProbability();
  const threshold = 0.05;
  const edgeBuy = mid - ask;   // customer buys if ask is cheap vs fair
  const edgeSell = bid - mid;  // customer sells (hits bid) if bid is rich vs fair
  const canSell = !((kind === 'call' || kind === 'put') && bid <= 0); // never reward a 0 bid with a trade
  if (informed) {
    if (edgeBuy > threshold && edgeBuy >= edgeSell) return 'buy';
    if (canSell && edgeSell > threshold) return 'sell';
    return null;
  }
  if (Math.random() < 0.55) return (canSell && Math.random() < 0.5) ? 'sell' : 'buy';
  return null;
}

// ---- IDB RFQs ---------------------------------------------------------------

function startIdbRfq() {
  const pool = enumerateBoardCells().filter(c => c.kind !== 'stock').map(c => ({ kind: c.kind, idx: c.idx }))
    .concat(spreadBookIdentities()); // the IDB draws on butterflies, condors, strangles... too
  if (!pool.length) { scheduleNextRfq(5000); return; }
  const pick = APP.util.choice(pool);
  const ref = makeIndicativeQuote(pick.kind, pick.idx);
  const r = Math.random();
  const rfqSide = r < 0.6 ? 'both' : (r < 0.8 ? 'bid' : 'ask');
  APP.session.boardFrozen = true;
  APP.idb.active = {
    kind: pick.kind, idx: pick.idx, status: 'awaiting_market',
    rfqSide, rfqVolume: APP.util.choice(RFQ_VOLUME_POOL),
    fixedBid: ref.bid, fixedBidSize: rfqSide === 'ask' ? APP.util.choice(AMBIENT_SIZE_POOL) : null,
    fixedAsk: ref.ask, fixedAskSize: rfqSide === 'bid' ? APP.util.choice(AMBIENT_SIZE_POOL) : null,
    bid: null, ask: null, bidSize: null, askSize: null,
  };
  APP.session.rfqActive = { type: 'idb' };
  renderAll();
}

function resolveIdbDecision() {
  const active = APP.idb.active;
  if (!active || active.status !== 'quoted') return;
  const mid = fairMid(active.kind, active.idx);
  const decision = decideTrade(active.kind, mid, active.bid, active.ask);
  let msg;
  const desc = describeInstrument(active.kind, active.idx);
  if (decision) {
    const dealerSide = decision === 'buy' ? 'sell' : 'buy';
    const price = decision === 'buy' ? active.ask : active.bid;
    const size = decision === 'buy' ? active.askSize : active.bidSize;
    addTrade(active.kind, active.idx, dealerSide, size, price);
    const verb = decision === 'buy' ? 'bought' : 'sold';
    msg = `IDB: customer ${verb} ${size} ${desc} @ ${fmt(price)}`;
    logFlow(`Customer ${verb} ${size} ${desc} at ${fmt(price)} from you (IDB)`, 'red');
  } else {
    msg = `IDB: customer passed on ${desc} (${fmt(active.bid)} - ${fmt(active.ask)})`;
  }
  APP.idb.log.unshift({ id: APP.util.uid(), text: msg, ts: APP.session.elapsedSec });
  APP.idb.active = null;
  APP.session.boardFrozen = false;
  markActivity();
  renderAll();
}

// ---- session clock -----------------------------------------------------------

function tickClock() {
  if (!running()) return;
  APP.session.elapsedSec = (Date.now() - APP.session.startEpoch) / 1000;
  const total = APP.config.simLengthMin * 60;
  if (APP.session.elapsedSec >= total) {
    APP.session.elapsedSec = total;
    endSession();
    return;
  }
  renderClock();
  later(tickClock, 500);
}

// ---- lifecycle ---------------------------------------------------------------
// Two phases. SETUP: the opening markets are up, the clock is paused, and the user makes a market in
// each remaining box of the main board, one request at a time. FLOW: once the board is complete the
// clock starts and the customers arrive, leaning the way the session's theme says.

function clearAllTimers() {
  APP.session.timers.forEach(id => clearTimeout(id));
  APP.session.timers = [];
  APP.session.rfqTimer = null;
}

function beginFlowPhase() {
  if (APP.session.phase === 'flow' || !running()) return;
  APP.session.phase = 'flow';
  APP.session.startEpoch = Date.now();
  APP.session.elapsedSec = 0;
  APP.session.lastActivity = Date.now();
  toast('The board is made — the customers are coming in.');
  tickClock();
  const pace = tradePaceSec() * 1000;
  later(loopTheme, pace * APP.util.rand(0.2, 0.4));
  later(loopImprove, pace * APP.util.rand(1.0, 1.8));
  later(watchdogTick, APP.util.rand(6000, 9000));
  scheduleNextRfq(pace * APP.util.rand(1.0, 2.0));
  renderAll();
}

function startSession() {
  clearAllTimers();
  initMarket();
  closeTicket();
  buildSkeleton();
  APP.position.legs = [];
  APP.idb.log = [];
  APP.idb.active = null;
  APP.history = [];
  APP.session.rfqActive = null;
  APP.session.rfqQueue = [];
  APP.session.phase = 'setup';
  if (APP.config.startWithPosition) generateStartingPosition();
  APP.session.status = 'running';
  APP.session.startEpoch = Date.now();
  APP.session.elapsedSec = 0; // the clock (and so every fair value) holds still until the board is made
  APP.session.boardFrozen = false;
  APP.session.lastActivity = Date.now();
  rebuildDelta1(APP.instruments.stock);
  syncCell(APP.instruments.stock);
  seedOpeningMarkets();
  APP.session.setupQueue = buildSetupQueue();
  renderAll();
  toast('The opening markets are up — make a market in each box that asks you for one.');
  later(refreshStockQuote, tradePaceSec() * 1000 * APP.util.rand(0.4, 0.9));
  scheduleNextRfq(700);
}

function endSession() {
  APP.session.status = 'ended';
  clearAllTimers();
  closeTicket();
  renderAll();
  const pnl = hasPosition() ? payoffAt(currentSpot()) : 0;
  const theme = APP.market.theme ? APP.market.theme.label : '';
  document.getElementById('simFinalStats').innerHTML =
    `P&L at current spot: ${APP.util.fmtSigned(pnl)}`
    + (theme ? `<div style="font-size:0.6em;color:#555;font-weight:600;margin-top:8px;">The customers' theme was ${theme}.</div>` : '');
  showScreen('simResults');
}

// Stops the running session without touching which screen is shown — used when the user opens
// "Reset configuration" to go back and change settings.
function stopSession() {
  clearAllTimers();
  closeTicket();
  APP.session.status = 'idle';
  APP.session.boardFrozen = false;
}
