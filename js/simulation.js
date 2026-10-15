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
    case 'riskReversal': { const [i, j] = decodePair(idx); return `${s[i]}/${s[j]} Risk Reversal (${riskReversalCallsOver(idx) ? 'calls' : 'puts'} over)${suffix}`; }
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
const MASSIVE_SIZE_POOL = [150, 200, 250, 300];  // what a customer follows a trade with: far bigger than anything resting
const RFQ_VOLUME_POOL = [20, 25, 50, 75, 100, 150, 200]; // never less than 20 lots: nobody asks for a market in 2

function pushTimer(id) { APP.session.timers.push(id); }
function later(fn, ms) { const id = setTimeout(fn, ms); pushTimer(id); return id; }
function running() { return APP.session.status === 'running'; }
function markActivity() { APP.session.lastActivity = Date.now(); }

// ---- cell helpers ------------------------------------------------------------

// Recomputes a cell's derived display fields from its levels / marks / RFQ flag.
function syncCell(cell) {
  // an indicative mark a live price has moved through is stale: if a customer bids 1.20 where the
  // 1.20 offer just traded out, the offer simply isn't there any more — there are only bids
  if (!cell.asks.length && cell.bids.length && cell.markAsk != null && cell.markAsk <= cell.bids[0].px + 1e-9) cell.markAsk = null;
  if (!cell.bids.length && cell.asks.length && cell.markBid != null && cell.markBid >= cell.asks[0].px - 1e-9) cell.markBid = null;
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
    toast(`Your order in ${describeInstrument(kind, idx, book)} was pushed out of the visible levels and pulled.`);
  }
}

// `mine`: the line is about something you did yourself (between steps), not a step's event.
function logFlow(text, color, mine) {
  APP.history.unshift({ id: APP.util.uid(), text, color, ts: APP.session.elapsedSec, step: APP.config.mode === 'steps' ? APP.session.step : null, mine: !!mine });
  if (APP.history.length > 300) APP.history.length = 300;
  if (color !== 'gray') flashFlowPanel(color === 'green' ? 'green' : 'red');
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
  let total = 0;
  list.forEach(c => { total += (c.weight != null ? c.weight : weightFor(c.kind)); });
  let r = Math.random() * total;
  for (const c of list) { r -= (c.weight != null ? c.weight : weightFor(c.kind)); if (r <= 0) return c; }
  return list[list.length - 1];
}

// The flow concentrates on a few strikes (the money and its neighbours) and, in the spread book and
// the IDB, on the structures built on whatever has traded most. Resting orders of the user's draw action.
function flowWeight(c) {
  let w = weightFor(c.kind);
  if (c.kind !== 'stock') w *= isFocusKind(c.kind, c.idx) ? 6 : 1;
  if (!c.book && APP.market.hotKinds.includes(c.kind)) w *= 3; // a few instruments do most of the trading
  if (c.book || isBookKind(c.kind)) w *= 1 + popularity(c.kind, c.idx);
  if (c.cell && userHasOrders(c.cell)) w *= 2.5;
  return w;
}

// A market that's wider than it should be for its size simply gets fewer trades — from uninformed
// customers as much as informed ones. Up to the widest a customer would quote there it's 1; beyond that
// it falls away with the square of how much wider it is (twice as wide is roughly a quarter as often).
function widthTradeFactor(kind, idx, bid, ask, bidSize, askSize) {
  if (kind === 'stock' || bid == null || ask == null) return 1;
  const lots = Math.max(1, (bidSize + askSize) / 2);
  const ref = widthRange(kind, lots, idx)[1];
  const r = (ask - bid) / Math.max(ref, tickSize());
  return r <= 1.15 ? 1 : Math.pow(1.15 / r, 2);
}
function cellWidthFactor(c) {
  const b = c.cell.bids[0], a = c.cell.asks[0];
  if (!b || !a) return 1;
  return widthTradeFactor(c.kind, c.idx, b.px, a.px, b.size + b.user, a.size + a.user);
}

function countTrade(kind, idx) {
  const key = `${kind}_${idx}`;
  APP.market.counts[key] = (APP.market.counts[key] || 0) + 1;
}

// Half of the customers know something (they trade only when they have an edge); the rest trade for
// their own reasons, whatever the price.
function informedProbability() { return 0.5; }

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
  const t = tickSize();
  const [lo, hi] = widthRange(kind, size, idx);
  const liveWidth = Math.max(t, APP.util.rand(lo, hi));
  let bid = mid - liveWidth / 2, ask = mid + liveWidth / 2;
  let advantage = 'neutral';
  const roll = neutral ? 1 : Math.random();
  if (roll < 0.25) {
    // "good for the user" skew only ever narrows the market, so it can't blow the width cap.
    const skew = APP.util.rand(2 * t, Math.max(3 * t, liveWidth));
    if (Math.random() < 0.5) ask = Math.max(bid + t, ask - skew); else bid = Math.min(ask - t, bid + skew);
    advantage = 'good';
  } else if (roll < 0.40) {
    // "bad for the user" skew widens the market — squeezed back afterward so total width never
    // exceeds hi, the same cap ambient/tight markets are held to elsewhere.
    const skew = APP.util.rand(2 * t, Math.max(3 * t, liveWidth));
    if (Math.random() < 0.5) ask += skew; else bid -= skew;
    advantage = 'bad';
  }
  if (ask - bid > hi) {
    const over = (ask - bid) - hi;
    ask -= over / 2; bid += over / 2;
  }
  const floor = priceFloorFor(kind, idx);
  bid = APP.util.rt(Math.max(floor, bid));
  ask = APP.util.rt(Math.max(bid + t, ask));
  if (isVerticalKind(kind) && ask - bid > verticalMaxWidth() + 1e-9) ask = APP.util.rt(bid + verticalMaxWidth());
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
  addTrade('stock', 0, side, size, px, 'delta1');
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
    cell.bids.push({ px: APP.util.rt(q.bid - tickSize() * APP.util.randInt(1, 2)), size: stockSizeChoice(), user: 0 });
    cell.asks.push({ px: APP.util.rt(q.ask + tickSize() * APP.util.randInt(1, 2)), size: stockSizeChoice(), user: 0 });
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
    if (cell.bids.length < 2) cell.bids.push({ px: APP.util.rt(cell.bids[0].px - tickSize() * APP.util.randInt(1, 2)), size: stockSizeChoice(), user: 0 });
    if (cell.asks.length < 2) cell.asks.push({ px: APP.util.rt(cell.asks[0].px + tickSize() * APP.util.randInt(1, 2)), size: stockSizeChoice(), user: 0 });
  }
}

function refreshStockQuote() {
  if (!running()) return;
  refreshDelta1();
  renderAll();
  if (APP.config.mode !== 'steps') later(refreshStockQuote, tradePaceSec() * 1000 * APP.util.rand(0.4, 0.9));
}

// Keeps the delta-1's market on the (moving) fair value. Step mode does this once a step.
function refreshDelta1() {
  const cell = APP.instruments.stock;
  const fixed = APP.config.certaintyMode === 'stock';
  const custBid = cell.bids.find(l => l.size > 0), custAsk = cell.asks.find(l => l.size > 0);
  const mid = (custBid && custAsk) ? (custBid.px + custAsk.px) / 2 : null;
  if (mid === null || (!fixed && Math.abs(mid - currentSpot()) > 0.15)) rebuildDelta1(cell);
  else topUpDelta1(cell);
  syncCell(cell);
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
    const floor = priceFloorFor(kind, idx);
    const b2 = APP.util.rt(q.bid - tickSize() * APP.util.randInt(1, 2));
    const a2 = APP.util.rt(q.ask + tickSize() * APP.util.randInt(1, 2));
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
// The user starts from just enough already-trading markets to price the whole board — and no more —
// then makes a market in every other box of the main board, one request at a time. Only once the board
// is complete does the clock start and the customers arrive, so each market the user makes can be
// judged against something real.
//
// "Enough to price the board": with the delta-1 known, every call, put and straddle at a strike carries
// the same one number, and a vertical spread links two strikes' numbers. So the board is solved by a
// spanning tree over {the strikes, plus "the ground"}: a call/put/straddle ties one strike to the
// ground, a vertical ties two neighbouring strikes. A random such tree is the opening set — some
// verticals, some calls, some puts — and not one market more. (With vol fixed, the ATM straddle is
// always one of them.)
function atmIndex() {
  const s = APP.market.strikes, spot = APP.market.spot0;
  let best = 0;
  s.forEach((K, i) => { if (Math.abs(K - spot) < Math.abs(s[best] - spot)) best = i; });
  return best;
}

function openingSet() {
  const N = APP.market.strikes.length, atm = atmIndex(), GROUND = N;
  const parent = Array.from({ length: N + 1 }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const chosen = [];
  const join = (e, a, b) => { const ra = find(a), rb = find(b); if (ra === rb) return false; parent[ra] = rb; chosen.push(e); return true; };
  if (APP.config.certaintyMode === 'vol') {
    if (isFutureMode()) join({ kind: 'straddle', idx: atm, book: false }, atm, GROUND);
    else if (APP.config.spreadBookOn) join({ kind: 'straddle', idx: atm, book: true }, atm, GROUND);
    else join({ kind: 'call', idx: atm, book: false }, atm, GROUND); // no spread book to hold the straddle
  }
  const edges = [];
  for (let i = 0; i < N; i++) {
    edges.push({ e: { kind: 'call', idx: i, book: false }, a: i, b: GROUND });
    edges.push({ e: { kind: 'put', idx: i, book: false }, a: i, b: GROUND });
  }
  if (APP.config.spreadsOn) {
    for (let i = 0; i < N - 1; i++) {
      edges.push({ e: { kind: 'callSpread', idx: i, book: false }, a: i, b: i + 1 });
      edges.push({ e: { kind: 'putSpread', idx: i, book: false }, a: i, b: i + 1 });
    }
  }
  edges.sort(() => Math.random() - 0.5).forEach(x => join(x.e, x.a, x.b));
  return chosen;
}

function seedOpeningMarkets() {
  openingSet().forEach(({ kind, idx, book }) => {
    const cell = getCell(kind, idx, book);
    if (!cell) return;
    if (book && !ensureSpreadBookSlot(kind, idx)) return;
    spawnMarket({ kind, idx, cell, book: !!book }, true);
  });
}

// The main-board boxes the user has left to make, working out from the money (each strike's options,
// then the verticals between strikes that are both done).
function buildSetupQueue() {
  const N = APP.market.strikes.length, atm = atmIndex();
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => Math.abs(a - atm) - Math.abs(b - atm) || a - b);
  const kinds = isFutureMode() ? ['call', 'put', 'straddle'] : ['call', 'put', 'ps', 'bw'];
  const q = [], done = new Set();
  const add = (kind, idx) => { if (!hasLevels(getCell(kind, idx, false))) q.push({ kind, idx }); };
  order.forEach(i => {
    kinds.forEach(kind => add(kind, i));
    done.add(i);
    if (!APP.config.spreadsOn) return;
    [i - 1, i].forEach(v => { // the verticals between this strike and an already-done neighbour
      if (v >= 0 && v < N - 1 && done.has(v) && done.has(v + 1)) { add('callSpread', v); add('putSpread', v); }
    });
  });
  // Only the first three — the boxes nearest the money. The rest of the board isn't made up front: the
  // trading concentrates on a few strikes and instruments, and anything else gets asked for later.
  return q.slice(0, SETUP_MARKETS);
}
const SETUP_MARKETS = 3;

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
  const t = tickSize();
  const edge = t * APP.util.choice([1, 2, 3]);
  let px;
  if (side === 'ask') {
    if (best.bid == null) return null;
    px = APP.util.ft(best.bid - edge);
    if (!(px < best.bid - 1e-9)) return null;
  } else {
    if (best.ask == null) return null;
    px = APP.util.ct(best.ask + edge);
    if (!(px > best.ask + 1e-9)) return null;
  }
  return px;
}

// A sensible one-tick improvement toward (but never through) fair value.
// `forward`: aim for where fair value is heading rather than where it is; `ticks`: how far to move.
function normalImprovementPx(kind, idx, cell, side, forward, ticks) {
  const fair = forward ? fairMidAt(kind, idx, lookaheadSec()) : fairMid(kind, idx);
  const t = tickSize();
  const own = side === 'bid' ? cell.bids[0] : cell.asks[0];
  let px;
  if (own) px = APP.util.rt(own.px + (side === 'bid' ? t : -t) * (ticks || 1));
  else {
    const mark = side === 'bid' ? cell.markBid : cell.markAsk;
    px = mark != null ? mark : APP.util.rt(fair + (side === 'bid' ? -2 * t : 2 * t));
  }
  if (side === 'bid' && px > fair + t / 2) return null;
  if (side === 'ask' && px < fair - t / 2) return null;
  return px;
}

// A customer tightens a market (one side, a tick or more) — sometimes enough to create a parity arb.
// Returns whether anything happened. A market the user is sitting in is improved more often.
function fireImprove() {
  const cands = liveCells(false).filter(c => !c.cell.rfqSide);
  if (!cands.length) return false;
  cands.forEach(c => { c.weight = flowWeight(c) * (userHasOrders(c.cell) ? 1.6 : 1); });
  for (let attempt = 0; attempt < 6; attempt++) {
    if (tryImprove(weightedPick(cands))) return true;
  }
  return false;
}

function tryImprove(pick) {
  const { kind, idx, cell, book } = pick;
  const t = tickSize();
  const cap = levelCap(kind, book);
  const side = Math.random() < 0.5 ? 'bid' : 'ask';
  const floor = priceFloorFor(kind, idx);

  let px = null, arbMode = false;
  if (!book && Math.random() < 0.45) { px = arbImprovementPx(kind, idx, cell, side); arbMode = px !== null; }
  if (px === null) px = normalImprovementPx(kind, idx, cell, side);
  if (px === null) return false;
  if (side === 'bid' && px < floor) return false;
  if (side === 'ask' && px < floor + t) return false;
  const own = side === 'bid' ? cell.bids[0] : cell.asks[0];
  if (own && !(side === 'bid' ? px > own.px + 1e-9 : px < own.px - 1e-9)) return false; // must genuinely improve
  if (wouldCross(cell, side, px)) {
    if (!arbMode) return false;
    // An arb-creating price usually sits through the cell's own opposite side (books are tight, so
    // the synthetic is wider than the cell itself): the customer pays up through it first — a real
    // trade, which fills the user if they were resting there — and then rests the rich price.
    for (let guard = 0; guard < 2 && wouldCross(cell, side, px); guard++) {
      const opp = side === 'bid' ? cell.asks[0] : cell.bids[0];
      customerTrade(kind, idx, book, cell, side === 'bid' ? 'buy' : 'sell', opp.size + opp.user);
    }
    if (wouldCross(cell, side, px)) return false;
  }

  // often a bigger clip than whatever the user is showing
  const userSz = own ? own.user : 0;
  let size = APP.util.choice(BIG_SIZE_POOL);
  if (userSz > 0) size = Math.max(size, Math.ceil(userSz * 1.5 / 5) * 5);

  const res = insertLevel(cell, side, px, size, 'cust', cap);
  if (!res.placed) return false;
  if (arbMode) { // keep the (now stale) mark on the side that was just paid up through consistent
    if (side === 'bid' && !cell.asks.length) cell.markAsk = APP.util.rt(px + 2 * t);
    if (side === 'ask' && !cell.bids.length) cell.markBid = APP.util.rt(Math.max(floor, px - 2 * t));
  }
  syncCell(cell);
  const desc = describeInstrument(kind, idx, book);
  logFlow(`Customer ${side === 'bid' ? 'bid' : 'offered'} ${fmt(px)} x${size} in ${desc}`, 'green');
  flashCell(kind, idx, book, 'green');
  notifyDropped(kind, idx, book, res.dropped);
  markActivity();
  renderAll();
  return true;
}

// ---- customer flow: trades -----------------------------------------------------

// After a side is fully traded out: settle it to an indicative mark at the traded price, and half
// the time also ask the user for a fresh quote on that side. (A live price on the other side stays
// live; the traded side just goes indicative until someone makes a new price there.)
function onSideExhausted(kind, idx, book, cell, bookSide, px) {
  if (kind === 'stock') { topUpDelta1(cell); syncCell(cell); return; }
  const t = tickSize();
  const floor = priceFloorFor(kind, idx);
  if (bookSide === 'bid') {
    cell.markBid = px;
    const otherLive = cell.asks.length > 0;
    if (!otherLive && (cell.markAsk == null || cell.markAsk <= px + 1e-9)) {
      const q = makeIndicativeQuote(kind, idx);
      cell.markAsk = APP.util.rt(Math.max(q.ask, px + t));
    }
  } else {
    cell.markAsk = px;
    const otherLive = cell.bids.length > 0;
    if (!otherLive && (cell.markBid == null || cell.markBid >= px - 1e-9)) {
      const q = makeIndicativeQuote(kind, idx);
      cell.markBid = APP.util.rt(Math.max(floor, Math.min(q.bid, px - t)));
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

// true while a customer trades because you tightened a market (that's yours, not a step's event)
let REWARD_TRADE = false;

// side: 'buy' = the customer lifts the offer, 'sell' = the customer hits the bid.
function customerTrade(kind, idx, book, cell, side, qty) {
  const arr = side === 'buy' ? cell.asks : cell.bids;
  const lvl = arr[0];
  if (!lvl) return false;
  const px = lvl.px;
  const total = lvl.size + lvl.user;
  const q = Math.min(qty, total);
  if (q <= 0) return false;
  const fromOthers = Math.min(q, lvl.size);
  const fromUser = q - fromOthers;
  lvl.size -= fromOthers;
  lvl.user -= fromUser;
  if (fromUser > 0) addTrade(kind, idx, side === 'buy' ? 'sell' : 'buy', fromUser, px, REWARD_TRADE ? 'reward' : 'fill', { improved: !!lvl.userImp });
  countTrade(kind, idx);
  const desc = describeInstrument(kind, idx, book);
  const suffix = fromUser > 0 ? (fromUser === q ? ' from you' : ` (${fromUser} from you)`) : '';
  logFlow(`Customer ${side === 'buy' ? 'bought' : 'sold'} ${q} ${desc} at ${fmt(px)}${suffix}`, fromUser > 0 ? 'red' : 'yellow', REWARD_TRADE);
  flashCell(kind, idx, book, 'red');
  const gone = lvl.size <= 0 && lvl.user <= 0;
  if (gone) arr.shift();
  // the delta-1 is deep and always re-quoted: a traded-out best level is replenished at the same price
  if (gone && kind === 'stock') arr.unshift({ px, size: stockSizeChoice(), user: 0 });
  syncCell(cell);
  if (gone && arr.length === 0) onSideExhausted(kind, idx, book, cell, side === 'buy' ? 'ask' : 'bid', px);
  markActivity();
  renderAll();
  return true;
}

// ---- who trades, and why ---------------------------------------------------------------
// Two kinds of customer. An INFORMED customer knows where fair value is heading (the session's theme:
// rising vol, a falling market...) and trades only when a price gives them an edge against that — so
// the instruments they pick are the ones the view is really about: the future and in-the-money options
// for delta, at-the-money options and straddles for vol. An UNINFORMED customer trades for their own
// reasons, always, at whatever the price is.

// How far ahead an informed customer sees.
function lookaheadSec() { return Math.max(40, APP.market.lenSec * 0.12); }

function liveCandidates() { return liveCells(true).filter(c => !c.cell.rfqSide); }

function fireInformedTrade(cands) {
  const dt = lookaheadSec();
  const opts = [];
  cands.forEach(c => {
    const bet = betOf(c); // only the right tools for the view: delta-1 / in-the-money options, or ATM options
    if (!bet) return;
    const ask = c.cell.asks[0], bid = c.cell.bids[0];
    const fwd = fairMidAt(c.kind, c.idx, dt);
    const eBuy = ask ? fwd - ask.px : -Infinity;
    const eSell = (bid && !((c.kind === 'call' || c.kind === 'put') && bid.px <= 0)) ? bid.px - fwd : -Infinity; // never reward a 0 bid
    const edge = Math.max(eBuy, eSell);
    if (edge > 1e-9) opts.push(Object.assign({}, c, { side: eBuy >= eSell ? 'buy' : 'sell', bet, weight: flowWeight(c) * edge * cellWidthFactor(c) }));
  });
  if (!opts.length) return false;
  return customerTakes(weightedPick(opts));
}

function fireUninformedTrade(cands) {
  const opts = [];
  cands.forEach(c => {
    const ask = c.cell.asks[0], bid = c.cell.bids[0];
    const sides = [];
    if (ask) sides.push('buy');
    if (bid && !((c.kind === 'call' || c.kind === 'put') && bid.px <= 0)) sides.push('sell');
    if (sides.length) opts.push(Object.assign({}, c, { side: APP.util.choice(sides), weight: flowWeight(c) * cellWidthFactor(c) }));
  });
  if (!opts.length) return false;
  return customerTakes(weightedPick(opts));
}

// One customer trade: they take the best price (all of it 70% of the time), and often follow it up
// with a massive order on the same side.
function customerTakes(pick) {
  const lvl = pick.side === 'buy' ? pick.cell.asks[0] : pick.cell.bids[0];
  if (!lvl) return false;
  const px = lvl.px;
  const ok = customerTrade(pick.kind, pick.idx, pick.book, pick.cell, pick.side, customerClipSize(pick.kind, lvl.size + lvl.user));
  if (ok && pick.kind !== 'stock' && Math.random() < 0.5) queueFollowOn(pick.kind, pick.idx, pick.book, pick.side, px);
  if (ok && pick.bet) reactToBet(pick);
  return ok;
}

// ---- what an informed customer bets with, and who reacts ----------------------------------
// A view on DIRECTION is expressed with the delta-1 and in-the-money options (they carry the delta); a
// view on VOL with at-the-money options and the straddle (they carry the vega). Anything else is a poor
// way to bet, so an informed customer leaves it alone.
function nearestStrikeIdx() {
  const s = APP.market.strikes, S = currentSpot();
  let b = 0;
  s.forEach((K, i) => { if (Math.abs(K - S) < Math.abs(s[b] - S)) b = i; });
  return b;
}

function betOf(c) {
  const th = APP.market.theme;
  if (!th) return null;
  const S = currentSpot(), K = APP.market.strikes[c.idx];
  if (th.variable === 'stock') {
    if (c.book) return null;
    if (c.kind === 'stock') return 'delta';
    if (c.kind === 'call' || c.kind === 'ps') return K < S ? 'delta' : null; // in the money
    if (c.kind === 'put' || c.kind === 'bw') return K > S ? 'delta' : null;
    return null;
  }
  if (!['call', 'put', 'ps', 'bw', 'straddle'].includes(c.kind)) return null;
  if (c.book && c.kind !== 'straddle') return null;
  return c.idx === nearestStrikeIdx() ? 'vol' : null; // at the money
}

// How an instrument's price moves with the underlying: the future and calls go up with it, puts go down.
function priceSens(kind) { return kind === 'stock' || kind === 'call' || kind === 'ps' ? 1 : (kind === 'put' || kind === 'bw' ? -1 : 0); }

// When someone makes such a bet the instruments that move with it react: bet on vol by buying the ATM
// calls and the ATM puts and straddle get bid up; bet on a rally by buying the future and the in-the-money
// calls get bid up and the in-the-money puts get offered down.
function reactToBet(pick) {
  const buy = pick.side === 'buy' ? 1 : -1;
  const targets = [];
  const add = (k, i, book, dir) => {
    const c = getCell(k, i, book);
    if (c && hasLevels(c) && !c.rfqSide && !(k === pick.kind && i === pick.idx && !!book === !!pick.book)) targets.push({ kind: k, idx: i, cell: c, book: !!book, dir });
  };
  if (pick.bet === 'vol') {
    mainOptionKinds().forEach(k => add(k, pick.idx, false, buy));      // every vega instrument moves the same way
    if (!isFutureMode()) add('straddle', pick.idx, true, buy);
  } else {
    const view = buy * priceSens(pick.kind); // +1: they think the underlying goes up
    if (pick.kind !== 'stock') add('stock', 0, false, view);
    const S = currentSpot(), K = APP.market.strikes[pick.idx];
    ['call', 'ps'].forEach(k => { if (mainOptionKinds().includes(k) && K < S) add(k, pick.idx, false, view * priceSens(k)); });
    ['put', 'bw'].forEach(k => { if (mainOptionKinds().includes(k) && K > S) add(k, pick.idx, false, view * priceSens(k)); });
  }
  const chosen = targets.sort(() => Math.random() - 0.5).slice(0, 2);
  const react = () => chosen.forEach(t => restCustomerOrder(t, t.dir > 0 ? 'bid' : 'ask', APP.util.choice(BIG_SIZE_POOL), null, true));
  if (APP.config.mode === 'steps') react(); else later(react, APP.util.rand(600, 1800));
}

// One customer-trade event: informed or not. An informed customer with nothing to trade stays out of
// it, and someone else (an uninformed customer) trades instead.
function fireTradeEvent() {
  const cands = liveCandidates();
  if (!cands.length) return false;
  if (Math.random() < informedProbability() && fireInformedTrade(cands)) return true;
  return fireUninformedTrade(cands);
}

// ---- customers putting up size after a trade --------------------------------------------

// A customer's resting order: improve the best price if that's sensible, otherwise add size to it.
// `hintPx` (the price they just traded at) is a fair place to rest when the book there has emptied.
function restCustomerOrder(pick, side, size, hintPx, reaction) {
  const { kind, idx, cell, book } = pick;
  const t = tickSize();
  const cap = levelCap(kind, book), floor = priceFloorFor(kind, idx);
  const own = side === 'bid' ? cell.bids[0] : cell.asks[0];
  const better = (px) => !own || (side === 'bid' ? px > own.px + 1e-9 : px < own.px - 1e-9);
  const okPx = (px) => px !== null && !(side === 'bid' ? px < floor : px < floor + t) && !wouldCross(cell, side, px) && better(px);
  let px = null;
  if (hintPx != null && okPx(hintPx) && Math.random() < 0.6) px = hintPx;
  else if (reaction) { // pricing in what the bet says: one or two ticks, towards where fair value is heading
    for (const n of [APP.util.randInt(1, 2), 1]) { const c = normalImprovementPx(kind, idx, cell, side, true, n); if (okPx(c)) { px = c; break; } }
  } else { const n = normalImprovementPx(kind, idx, cell, side); if (okPx(n)) px = n; }
  const desc = describeInstrument(kind, idx, book);
  if (px !== null) {
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

// Having just traded, some customers put up massive size on the same side — a buyer bids, a seller
// offers — in the same market or a similar one (the neighbouring strikes, or the same strike's other
// options). Timed sessions do it a few seconds later; step-by-step ones keep it for a later step.
function queueFollowOn(kind, idx, book, side, px) {
  const f = { kind, idx, book, side, px };
  if (APP.config.mode === 'steps') APP.session.stepQueue.push(f);
  else later(() => runFollowOn(f), APP.util.rand(2500, 7000));
}

function runFollowOn(f) {
  if (!running() || APP.session.phase !== 'flow') return false;
  const own = getCell(f.kind, f.idx, f.book);
  const pool = [];
  const add = (k, i, same) => {
    const c = getCell(k, i, false);
    if (c && hasLevels(c) && !c.rfqSide) pool.push({ kind: k, idx: i, cell: c, book: false, same });
  };
  if (own && hasLevels(own) && !own.rfqSide) pool.push({ kind: f.kind, idx: f.idx, cell: own, book: !!f.book, same: true });
  if (!f.book) {
    add(f.kind, f.idx - 1, false); add(f.kind, f.idx + 1, false);
    mainOptionKinds().forEach(k => { if (k !== f.kind) add(k, f.idx, false); });
  }
  if (!pool.length) return false;
  pool.forEach(p => { p.weight = p.same ? 3 : 1; });
  const pick = weightedPick(pool);
  return restCustomerOrder(pick, f.side === 'buy' ? 'bid' : 'ask', APP.util.choice(MASSIVE_SIZE_POOL), pick.same ? f.px : null);
}

// ---- event loops (customer flow begins only once the board is made) -----------------

function loopTrades() {
  if (!running()) return;
  fireTradeEvent();
  later(loopTrades, tradePaceSec() * 1000 * APP.util.rand(0.25, 0.55));
}
function loopImprove() { // someone improves a price — sometimes enough to create a parity arb
  if (!running()) return;
  fireImprove();
  later(loopImprove, tradePaceSec() * 1000 * APP.util.rand(0.8, 1.6));
}

// Never let the user sit idle with nothing happening once the flow has started.
function watchdogTick() {
  if (!running()) return;
  if (Date.now() - APP.session.lastActivity > 25000) fireTradeEvent();
  later(watchdogTick, APP.util.rand(6000, 9000));
}

// ---- step-by-step: one event per press of Next -------------------------------------------
// You can be asked for a market, a customer can improve a market (yours or anyone's), or a customer
// can trade (with you or not). Taking a price yourself is free: it never uses up a step.

function stepEvent() {
  const q = APP.session.stepQueue;
  if (q.length && Math.random() < 0.6 && runFollowOn(q.shift())) return true;
  const r = Math.random();
  const order = r < 0.40 ? ['trade', 'rfq', 'improve']
    : r < 0.62 ? ['improve', 'trade', 'rfq']
    : r < 0.90 ? ['rfq', 'trade', 'improve']
    : ['trade', 'improve', 'rfq'];
  for (const k of order) {
    if (k === 'trade' && fireTradeEvent()) return true;
    if (k === 'improve' && fireImprove()) return true;
    if (k === 'rfq' && armNextRfq()) return true;
  }
  while (q.length) if (runFollowOn(q.shift())) return true;
  return false;
}

// ---- the user's own actions ----------------------------------------------------

function validateOrderPrice(kind, side, px) {
  if (isNaN(px)) return 'Enter a price.';
  if (isSignedKind(kind)) return null; // strike-relative combos — negative/zero are legitimate
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
  px = APP.util.rt(px);
  if (wouldCross(cell, side, px)) return { error: `That ${side === 'bid' ? 'bid' : 'offer'} crosses the market — click the ${side === 'bid' ? 'offer' : 'bid'} to take it instead.` };
  const cap = levelCap(kind, book);
  // order-book cells take top-of-book quotes only: join the best price or improve it
  const best = side === 'bid' ? cell.bids[0] : cell.asks[0];
  if (cap > 1 && best && (side === 'bid' ? px < best.px - 1e-9 : px > best.px + 1e-9)) {
    return { error: `Top of book only: a ${side === 'bid' ? 'bid' : 'offer'} must be ${fmt(best.px)} or ${side === 'bid' ? 'higher' : 'lower'}.` };
  }
  const widthBefore = (cell.bids[0] && cell.asks[0]) ? cell.asks[0].px - cell.bids[0].px : null;
  const res = insertLevel(cell, side, px, size, 'user', cap);
  if (!res.placed) return { error: `Outside the top ${cap} level${cap > 1 ? 's' : ''} — price it better than the ${cap > 1 ? 'second-best' : 'best'} level.` };
  syncCell(cell);
  const sideArr = side === 'bid' ? cell.bids : cell.asks;
  const myLevel = sideArr.find(l => Math.abs(l.px - px) < 1e-9);
  if (myLevel && res.becameBest) myLevel.userImp = true; // an improvement: if it gets hit, the review knows
  reviewQuote({ how: 'order', kind, idx, book, side, bid: side === 'bid' ? px : null, ask: side === 'ask' ? px : null, volume: size, top: !!(sideArr[0] && sideArr[0].user > 0) });
  notifyDropped(kind, idx, book, res.dropped);
  toast(`Order placed: ${side === 'bid' ? 'bid' : 'offer'} ${size} ${describeInstrument(kind, idx, book)} @ ${fmt(px)}`);
  if (APP.config.mode === 'steps' && APP.session.phase === 'flow') logFlow(`You ${side === 'bid' ? 'bid' : 'offered'} ${fmt(px)} x${size} in ${describeInstrument(kind, idx, book)}`, 'gray', true);
  markActivity();
  renderAll();
  // Tighten a two-sided market to 75% of its width or less and a customer trades with you: the reward
  // for spotting that the price you've just shown is worth something (an arbitrage, say).
  if (res.becameBest && widthBefore != null && cell.bids[0] && cell.asks[0]
      && cell.asks[0].px - cell.bids[0].px <= 0.75 * widthBefore + 1e-9) {
    scheduleTightenReward(kind, idx, book, side, px);
  }
  return { ok: true };
}

function scheduleTightenReward(kind, idx, book, side, px) {
  later(() => {
    if (!running()) return;
    const cell = getCell(kind, idx, book);
    if (!cell) return;
    const arr = side === 'bid' ? cell.bids : cell.asks;
    const lvl = arr[0];
    if (!lvl || lvl.user <= 0 || Math.abs(lvl.px - px) > 1e-9) return; // pulled, or someone beat it
    REWARD_TRADE = true;
    try { customerTrade(kind, idx, book, cell, side === 'bid' ? 'sell' : 'buy', lvl.size + lvl.user); } finally { REWARD_TRADE = false; }
  }, 600);
}

// Pull the user's own market from a cell (one side, or both). Pulling leaves nothing in its place: no
// indicative price is put up where your quote was.
function pullUserMarkets(kind, idx, book, side) {
  const cell = getCell(kind, idx, book);
  if (!cell) return;
  ['bid', 'ask'].forEach(s => {
    if (side && side !== s) return;
    const arr = s === 'bid' ? cell.bids : cell.asks;
    arr.forEach(l => { l.user = 0; });
    const kept = arr.filter(l => l.size > 0);
    if (s === 'bid') cell.bids = kept; else cell.asks = kept;
  });
  syncCell(cell);
  toast(`You pulled your market in ${describeInstrument(kind, idx, book)}.`);
  if (APP.config.mode === 'steps' && APP.session.phase === 'flow') logFlow(`You pulled your market in ${describeInstrument(kind, idx, book)}`, 'gray', true);
  renderAll();
}

function handlePull(kind, idx, book) {
  if (!running() || APP.session.boardFrozen) return;
  pullUserMarkets(kind, idx, book, null);
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
  addTrade(kind, idx, side, q, px, 'take');
  countTrade(kind, idx);
  logFlow(`You ${side === 'buy' ? 'bought' : 'sold'} ${q} ${describeInstrument(kind, idx, book)} at ${fmt(px)}`, 'blue', true);
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
  // step by step, requests for a market arrive as steps (see stepEvent), never on a timer
  if (APP.config.mode === 'steps' && APP.session.phase === 'flow') return;
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

// Asks the user for the next market, if there is one to ask for (flow phase). True if it did.
function armNextRfq() {
  if (APP.session.rfqActive || APP.session.boardFrozen) return false;
  if (APP.config.idbOn && !APP.idb.active && Math.random() < 0.25 && startIdbRfq()) return true;

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
    return true;
  }

  // otherwise a customer asks for a market in something nobody's quoting — mostly around the money,
  // and in the spread book, in structures built on what's been trading
  const free = freeCells();
  free.forEach(c => { c.weight = flowWeight(c); });
  while (free.length) {
    const pick = weightedPick(free);
    free.splice(free.indexOf(pick), 1);
    if (pick.book && !ensureSpreadBookSlot(pick.kind, pick.idx)) continue;
    armRfq(pick);
    renderAll();
    return true;
  }
  return false;
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

  if (!armNextRfq()) scheduleNextRfq(4000); // nothing to ask for right now
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
  if (isSignedKind(kind)) {
    // no sign constraint
  } else if (kind === 'call' || kind === 'put') {
    if (bid < 0) return { error: 'Bid cannot be negative.' };
    if (ask <= 0) return { error: 'Ask must be positive.' };
  } else if (bid <= 0 || ask <= 0) {
    return { error: 'Prices must be positive.' };
  }
  bid = APP.util.rt(bid); ask = APP.util.rt(ask);
  if (ask <= bid) return { error: 'Ask must be greater than bid.' };
  // width requirement: no more than 1 wide (2 wide in more than 100 vega), and verticals stay tight
  const volume = isIdb ? APP.idb.active.rfqVolume : (getCell(kind, idx, book).rfqVolume || 0);
  const maxW = maxUserWidth(kind, idx, volume);
  const width = Math.round((ask - bid) * 100) / 100; // (1.92 to 2.22 is exactly 0.30 wide, whatever the floating point says)
  if (width > maxW + 1e-9) {
    return { error: isVerticalKind(kind)
      ? `Too wide: a vertical spread can be at most ${fmt(maxW)} wide.`
      : `Too wide: for ${volume} lots the market can be at most ${maxW} wide.` };
  }

  if (isIdb) {
    APP.idb.active.bid = bid; APP.idb.active.ask = ask;
    APP.idb.active.bidSize = bidSize; APP.idb.active.askSize = askSize;
    APP.idb.active.status = 'quoted';
    reviewQuote({ how: 'rfq', kind, idx, book: false, side: APP.idb.active.rfqSide, bid, ask, volume, top: null });
    if (APP.config.mode === 'steps' && APP.session.phase === 'flow') {
      logFlow(`IDB asked for a market in ${describeInstrument(kind, idx)} (${volume} lots): you quoted ${fmt(bid)} x${bidSize} – ${fmt(ask)} x${askSize}`, 'gray');
    }
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
    const onTop = (side === 'bid' || side === 'both' ? !!(cell.bids[0] && cell.bids[0].user > 0) : true)
      && (side === 'ask' || side === 'both' ? !!(cell.asks[0] && cell.asks[0].user > 0) : true);
    reviewQuote({ how: 'rfq', kind, idx, book, side, bid, ask, volume, top: onTop });
    if (APP.config.mode === 'steps' && APP.session.phase === 'flow') { // the step is complete: it goes in the history
      const q = side === 'both' ? `${fmt(bid)} x${bidSize} – ${fmt(ask)} x${askSize}` : (side === 'bid' ? `a bid of ${fmt(bid)} x${bidSize}` : `an offer of ${fmt(ask)} x${askSize}`);
      logFlow(`Asked for ${side === 'both' ? 'a market' : (side === 'bid' ? 'a bid' : 'an offer')} in ${describeInstrument(kind, idx, book)} (${volume} lots): you quoted ${q}`, 'gray');
    }
    onRfqMade();
    renderAll();
  }
  return { ok: true };
}

// The customer on the other end of a quoted IDB market: an informed one trades only if the market gives
// them an edge against where fair value is heading; an uninformed one always trades, either way.
function decideTrade(kind, idx, bid, ask, bidSize, askSize) {
  const canSell = !((kind === 'call' || kind === 'put') && bid <= 0); // never reward a 0 bid with a trade
  if (Math.random() < informedProbability()) {
    const fwd = fairMidAt(kind, idx, lookaheadSec());
    const edgeBuy = fwd - ask;   // customer buys if the ask is cheap vs where fair is heading
    const edgeSell = bid - fwd;  // customer sells (hits the bid) if the bid is rich
    if (edgeBuy > 1e-9 && edgeBuy >= edgeSell) return 'buy';
    if (canSell && edgeSell > 1e-9) return 'sell';
    return null;
  }
  // an uninformed customer trades whatever the price — but a market wider than it should be is passed on more often
  if (Math.random() > widthTradeFactor(kind, idx, bid, ask, bidSize || 20, askSize || 20)) return null;
  return (canSell && Math.random() < 0.5) ? 'sell' : 'buy';
}

// ---- IDB RFQs ---------------------------------------------------------------

function startIdbRfq() {
  const pool = enumerateBoardCells().filter(c => c.kind !== 'stock').map(c => ({ kind: c.kind, idx: c.idx, book: false }))
    .concat(spreadBookIdentities().map(s => ({ kind: s.kind, idx: s.idx, book: true }))); // butterflies, condors, strangles...
  if (!pool.length) return false;
  pool.forEach(c => { c.weight = flowWeight(c); });
  const pick = weightedPick(pool);
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
  return true;
}

function resolveIdbDecision() {
  const active = APP.idb.active;
  if (!active || active.status !== 'quoted') return;
  const decision = decideTrade(active.kind, active.idx, active.bid, active.ask, active.bidSize, active.askSize);
  let msg;
  const desc = describeInstrument(active.kind, active.idx);
  if (decision) {
    const dealerSide = decision === 'buy' ? 'sell' : 'buy';
    const price = decision === 'buy' ? active.ask : active.bid;
    const size = decision === 'buy' ? active.askSize : active.bidSize;
    addTrade(active.kind, active.idx, dealerSide, size, price, 'idb');
    countTrade(active.kind, active.idx);
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

// Timed sessions: every few seconds, note your risk and any parity gap that's been sitting there.
function loopReview() {
  if (!running()) return;
  reviewSample();
  reviewScanArbs(2);
  later(loopReview, 6000);
}

function tickClock() {
  if (!running() || APP.config.mode === 'steps') return;
  APP.session.elapsedSec = (Date.now() - APP.session.startEpoch) / 1000;
  const total = APP.market.lenSec;
  if (APP.session.elapsedSec >= total) {
    APP.session.elapsedSec = total;
    endSession();
    return;
  }
  renderClock();
  later(tickClock, 500);
}

// ---- step by step ------------------------------------------------------------
// No clock: each press of Next brings the next event (see stepEvent). Time on the fair-value paths
// moves on one notch per step, so the market still drifts the way the session's theme says.

function advanceStep() {
  if (!running() || APP.config.mode !== 'steps' || APP.session.phase !== 'flow') return;
  if (APP.session.rfqActive) { toast('Make the market you were asked for first.'); return; }
  if (APP.session.boardFrozen) { toast('Wait for the IDB customer to decide first.'); return; }
  if (APP.session.step >= APP.config.steps) { endSession(); return; }
  closeTicket();
  reviewSample();
  reviewScanArbs(1); // anything out of line still on the screen as you move on counts as passed
  APP.session.step += 1;
  APP.session.elapsedSec = APP.session.step / APP.config.steps * APP.market.lenSec;
  refreshDelta1();
  if (!stepEvent()) logFlow('A quiet moment — nothing happened.', 'gray');
  markActivity();
  renderAll();
}

// ---- lifecycle ---------------------------------------------------------------
// Two phases. SETUP: the opening markets are up, the clock is paused, and the user makes a market in
// each remaining box of the main board, one request at a time. FLOW: once the board is complete the
// customers arrive — on a clock (timed) or one per press of Next (step by step) — with the informed
// ones leaning the way the session's theme says.

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
  APP.session.step = 0;
  APP.session.stepQueue = [];
  reviewSample();
  if (APP.config.mode === 'steps') {
    toast('The board is made — press Next step to bring in the first event.');
    renderAll();
    return;
  }
  toast('The board is made — the customers are coming in.');
  tickClock();
  later(loopReview, 6000);
  const pace = tradePaceSec() * 1000;
  later(loopTrades, pace * APP.util.rand(0.2, 0.4));
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
  resetReview();
  APP.session.rfqActive = null;
  APP.session.rfqQueue = [];
  APP.session.step = 0;
  APP.session.stepQueue = [];
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
  toast('The opening markets are up — make the three markets you\'re asked for, then the customers come in.');
  if (APP.config.mode !== 'steps') later(refreshStockQuote, tradePaceSec() * 1000 * APP.util.rand(0.4, 0.9));
  scheduleNextRfq(700);
}

function endSession() {
  APP.session.status = 'ended';
  clearAllTimers();
  closeTicket();
  renderAll();
  reviewSample();
  document.getElementById('simFinalStats').innerHTML = reviewHtml(); // a score out of 10, with feedback
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
