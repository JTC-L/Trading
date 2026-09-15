// Event engine: ambient live quotes, board/spread-book RFQs, IDB RFQs, customer decisions.

function getCell(kind, idx, book) {
  if (kind === 'stock') return APP.instruments.stock;
  if (book) return spreadBookCellFor(kind, idx);
  switch (kind) {
    case 'ps': return APP.instruments.ps[idx];
    case 'call': return APP.instruments.call[idx];
    case 'put': return APP.instruments.put[idx];
    case 'bw': return APP.instruments.bw[idx];
    case 'callSpread': return APP.instruments.callSpread[idx];
    case 'putSpread': return APP.instruments.putSpread[idx];
  }
  return null;
}

function describeInstrument(kind, idx, book) {
  const s = APP.market.strikes;
  const suffix = book ? ' (book)' : '';
  switch (kind) {
    case 'stock': return 'Stock';
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
  }
  return kind;
}

function weightFor(kind) {
  const mode = APP.config.certaintyMode;
  if (kind === 'callSpread' || kind === 'putSpread' || kind === 'callSpreadWide' || kind === 'putSpreadWide') return 2;
  if (kind === 'straddle' || kind === 'combo' || kind === 'strangle' || kind === 'riskReversal') return 2;
  return mode === 'stock' ? 1 : (mode === 'vol' ? 4 : 2);
}

function buildPool(candidates) {
  const pool = [];
  candidates.forEach(c => {
    const w = weightFor(c.kind);
    for (let i = 0; i < w; i++) pool.push(c);
  });
  return pool;
}

// Stock is handled by its own always-live refresh loop (see refreshStockQuote), so it's excluded
// from the generic ambient/RFQ pools.
function eligibleAmbientCandidates() {
  const all = enumerateBoardCells().concat(enumerateSpreadBookCells());
  return all.filter(c => c.kind !== 'stock' && (c.cell.status === 'empty' || c.cell.status === 'indicative'));
}
function eligibleRfqCandidates() {
  const all = enumerateBoardCells().concat(enumerateSpreadBookCells());
  return all.filter(c => c.kind !== 'stock' && (c.cell.status === 'empty' || c.cell.status === 'indicative'));
}
function eligibleJoinCandidates() {
  const all = enumerateBoardCells().concat(enumerateSpreadBookCells());
  return all.filter(c => c.cell.status === 'live' && ((c.cell.userBidSize || 0) > 0 || (c.cell.userAskSize || 0) > 0));
}

// Higher board-fill % implies a tougher session — scale informed customer flow with it.
function informedProbability() {
  return APP.util.clamp(0.2 + (APP.config.fillPct / 100) * 0.5, 0.2, 0.7);
}

function pushTimer(id) { APP.session.timers.push(id); }

function clearCellTimer(cell) {
  if (cell._timer) { clearTimeout(cell._timer); cell._timer = null; }
}

function clearLiveCellFields(cell) {
  cell.bidSize = null; cell.askSize = null;
  cell.userBidSize = 0; cell.userAskSize = 0;
  cell.rfqSide = null; cell.rfqVolume = null; cell._fixedBidSize = null; cell._fixedAskSize = null;
  cell._advantage = null;
}

// Whether an RFQ should solicit both sides, or just one (with the other side shown fixed, taken
// from whatever indicative reference already exists — only possible when one exists).
function pickRfqSide(priorStatus) {
  if (priorStatus !== 'indicative') return 'both';
  const r = Math.random();
  if (r < 0.55) return 'both';
  if (r < 0.775) return 'bid';
  return 'ask';
}

const RFQ_VOLUME_POOL = [10, 20, 25, 50, 75, 100, 150, 200];

// The spread book only ever displays up to 2 instruments at once. Returns true if `kind`/`idx`
// has (or now has) a slot; false if the book is full of currently-active (non-indicative) entries.
function ensureSpreadBookSlot(kind, idx) {
  const active = APP.spreadBook.active;
  if (active.some(a => a.kind === kind && a.idx === idx)) return true;
  if (active.length < 2) { active.push({ kind, idx }); return true; }
  const evictAt = active.findIndex(a => spreadBookCellFor(a.kind, a.idx).status === 'indicative');
  if (evictAt === -1) return false;
  Object.assign(spreadBookCellFor(active[evictAt].kind, active[evictAt].idx), makeCell());
  active.splice(evictAt, 1, { kind, idx });
  return true;
}

// Only top of book is ever shown: if another participant prices through the user's resting
// quote on `side`, that side's price/size is replaced and the user's ownership of it is cleared
// (their quote is pulled — it's no longer the best price, so it no longer belongs on screen).
function improveOverUserQuote(kind, idx, book, side) {
  const cell = getCell(kind, idx, book);
  if (!cell || cell.status !== 'live') return;
  const tick = 0.05;
  const newSize = APP.util.choice([5, 10, 15, 20, 25]);
  if (side === 'bid') {
    cell.bid = APP.util.round5c(Math.min(cell.ask - 0.05, cell.bid + tick));
    cell.bidSize = newSize;
    cell.userBidSize = 0;
  } else {
    cell.ask = APP.util.round5c(Math.max(cell.bid + 0.05, cell.ask - tick));
    cell.askSize = newSize;
    cell.userAskSize = 0;
  }
  toast(`Another participant improved the ${side === 'bid' ? 'bid' : 'offer'} on your ${describeInstrument(kind, idx, book)} — your quote was pulled.`);
  renderAll();
}

// ---- Watchdog: never let the user sit idle with nothing to look at ----------

function watchdogTick() {
  if (APP.session.status !== 'running') return;
  const all = enumerateBoardCells().concat(enumerateSpreadBookCells());
  const hasOtherLive = all.some(c => c.cell.status === 'live' && !((c.cell.userBidSize || 0) > 0 || (c.cell.userAskSize || 0) > 0))
    || APP.instruments.stock.status === 'live';
  const hasPendingRfq = all.some(c => c.cell.status === 'rfq');
  if (!hasOtherLive && !hasPendingRfq) {
    const userLiveCells = all.filter(c => c.cell.status === 'live' && ((c.cell.userBidSize || 0) > 0 || (c.cell.userAskSize || 0) > 0));
    if (userLiveCells.length && Math.random() < 0.5) {
      const pick = APP.util.choice(userLiveCells);
      forceCustomerTrade(pick.kind, pick.idx, pick.book);
    } else {
      fireAmbientQuote(); // also reschedules the normal ambient cycle — harmless overlap
    }
  }
  const delay = APP.util.rand(8000, 13000);
  pushTimer(setTimeout(watchdogTick, delay));
}

// Guarantees a trade against one of the user's own resting markets — used only when the board
// would otherwise go quiet (no other live prices, no pending RFQs) so the user isn't left waiting.
function forceCustomerTrade(kind, idx, book) {
  const cell = getCell(kind, idx, book);
  if (!cell || cell.status !== 'live') return;
  const mid = fairMid(kind, idx);
  const canSell = !((kind === 'call' || kind === 'put') && cell.bid <= 0);
  const decision = decideTrade(kind, mid, cell.bid, cell.ask) || (canSell ? (Math.random() < 0.5 ? 'buy' : 'sell') : 'buy');
  const price = decision === 'buy' ? cell.ask : cell.bid;
  const size = decision === 'buy' ? cell.askSize : cell.bidSize;
  const dealerSide = decision === 'buy' ? 'sell' : 'buy';
  clearCellTimer(cell);
  addTrade(kind, idx, dealerSide, size, price);
  const verb = decision === 'buy' ? 'bought' : 'sold';
  triggerAlert(`Customer ${verb} ${size} ${describeInstrument(kind, idx, book)} at ${APP.util.fmt(price)} from you`, 'red');
  cell.status = 'indicative';
  const q = makeIndicativeQuote(kind, idx);
  cell.bid = q.bid; cell.ask = q.ask;
  clearLiveCellFields(cell);
  ensureMinimumLiveOptions();
  renderAll();
}

// ---- Stock: always live, always tradeable -----------------------------------

// A stock quote's size is framed in option-contract-equivalent terms (a contract is 100 shares),
// reflecting that the underlying's liquidity is driven by the options market makers hedging on it.
// When the stock itself is fixed for the session it's far more liquid (say ~10000 vs ~50 in the
// ITM options); when vol is fixed instead, stock and options liquidity are more comparable (~4000).
function stockSizeChoice() {
  const mode = APP.config.certaintyMode;
  if (mode === 'stock') return APP.util.choice([80, 90, 100, 110, 120]) * 100;
  if (mode === 'vol') return APP.util.choice([32, 36, 40, 44, 48]) * 100;
  return APP.util.choice([5, 10, 15, 20, 25]) * 100;
}

function refreshStockQuote() {
  if (APP.session.status !== 'running') return;
  const cell = APP.instruments.stock;
  clearCellTimer(cell);
  const bidSize = stockSizeChoice(), askSize = stockSizeChoice();
  let q;
  if (APP.config.certaintyMode === 'stock') {
    // the stock price is fixed for the whole session — generate it once and never again.
    if (!APP.market._fixedStockQuote) APP.market._fixedStockQuote = buildLiveQuoteForCell('stock', 0, Math.max(bidSize, askSize));
    q = APP.market._fixedStockQuote;
  } else {
    q = buildLiveQuoteForCell('stock', 0, Math.max(bidSize, askSize));
  }
  cell.status = 'live';
  cell.bid = q.bid; cell.ask = q.ask;
  cell.bidSize = bidSize; cell.askSize = askSize;
  cell.userBidSize = 0; cell.userAskSize = 0;
  cell._advantage = q.advantage;
  renderAll();
  const delay = tradePaceSec() * 1000 * APP.util.rand(0.4, 0.9); // the stock refreshes faster — it's the most liquid thing on the board
  const tid = setTimeout(refreshStockQuote, delay);
  cell._timer = tid;
  pushTimer(tid);
}

// ---- Ambient live quotes ---------------------------------------------------

function buildLiveQuoteForCell(kind, idx, size) {
  const mid = fairMid(kind, idx);
  const [lo, hi] = widthRange(kind, size);
  const liveWidth = APP.util.rand(lo, hi) * 0.6;
  let bid = mid - liveWidth / 2, ask = mid + liveWidth / 2;
  let advantage = 'neutral';
  const roll = Math.random();
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

const AMBIENT_SIZE_POOL = [5, 10, 15, 20, 25, 35, 50];

// Turns one eligible cell into a fresh two-sided live quote, and schedules its expiry.
function spawnLiveQuote(pick) {
  const { kind, idx, cell, book } = pick;
  const bidSize = APP.util.choice(AMBIENT_SIZE_POOL), askSize = APP.util.choice(AMBIENT_SIZE_POOL);
  const q = buildLiveQuoteForCell(kind, idx, Math.max(bidSize, askSize));
  cell.status = 'live';
  cell.bid = q.bid; cell.ask = q.ask;
  cell.bidSize = bidSize; cell.askSize = askSize;
  cell.userBidSize = 0; cell.userAskSize = 0;
  cell._advantage = q.advantage;
  cell._book = !!book; cell._kind = kind; cell._idx = idx;

  const duration = Math.max(3000, tradePaceSec() * 1000 * APP.util.rand(0.5, 1.5));
  const tid = setTimeout(() => expireAmbientQuote(kind, idx, book), duration);
  cell._timer = tid;
  pushTimer(tid);
}

// The 4 main option kinds shown on the board (not the spread book), across all 5 strikes.
const MAIN_OPTION_KINDS = ['ps', 'call', 'put', 'bw'];
function countLiveMainOptions() {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    MAIN_OPTION_KINDS.forEach(kind => { if (getCell(kind, i, false).status === 'live') n++; });
  }
  return n;
}

// Tops the board back up to at least 2 live main-option markets whenever a trade or expiry drops
// it below that floor, so the user is never left staring at an all-indicative/empty board.
function ensureMinimumLiveOptions() {
  if (APP.session.status !== 'running') return;
  let guard = 0;
  while (countLiveMainOptions() < 2 && guard < 20) {
    guard++;
    const candidates = [];
    for (let i = 0; i < 5; i++) {
      MAIN_OPTION_KINDS.forEach(kind => {
        const cell = getCell(kind, i, false);
        if (cell.status === 'empty' || cell.status === 'indicative') candidates.push({ kind, idx: i, cell, book: false });
      });
    }
    if (!candidates.length) break;
    spawnLiveQuote(APP.util.choice(candidates));
  }
}

function fireAmbientQuote() {
  if (APP.session.status !== 'running') return;

  // occasionally, other participants join a market the user has already posted, instead of a
  // brand new quote appearing elsewhere — this is what produces a total size bigger than the
  // user's own resting size.
  const joinable = eligibleJoinCandidates();
  if (joinable.length && Math.random() < 0.30) {
    const pick = APP.util.choice(joinable);
    const sides = [];
    if ((pick.cell.userBidSize || 0) > 0) sides.push('bid');
    if ((pick.cell.userAskSize || 0) > 0) sides.push('ask');
    const side = APP.util.choice(sides);
    if (Math.random() < 0.35) {
      // another participant prices through the user — we only ever show top of book, so the
      // user's now-uncompetitive quote on that side gets pulled.
      improveOverUserQuote(pick.kind, pick.idx, pick.book, side);
    } else {
      const extra = APP.util.choice([5, 10, 15, 20]);
      if (side === 'bid') pick.cell.bidSize = (pick.cell.bidSize || 0) + extra;
      else pick.cell.askSize = (pick.cell.askSize || 0) + extra;
      renderAll();
    }
    const delay = tradePaceSec() * 1000 * APP.util.rand(0.5, 1.5);
    pushTimer(setTimeout(fireAmbientQuote, delay));
    return;
  }

  const candidates = eligibleAmbientCandidates();
  if (candidates.length) {
    const pool = buildPool(candidates);
    const pick = APP.util.choice(pool);
    if (!pick.book || ensureSpreadBookSlot(pick.kind, pick.idx)) spawnLiveQuote(pick);
  }
  renderAll();
  const delay = tradePaceSec() * 1000 * APP.util.rand(0.5, 1.5);
  const nid = setTimeout(fireAmbientQuote, delay);
  pushTimer(nid);
}

// After a live 2-way quote gets a print on one side, that side either goes back out for a fresh
// quote (kept live) or settles to indicative right at the price it just traded — either way the
// untouched side is preserved as the reference rather than both sides being re-randomized.
function resolveTradedSide(kind, idx, book, tradedSide, tradedPrice) {
  const cell = getCell(kind, idx, book);
  const otherSide = tradedSide === 'bid' ? 'ask' : 'bid';
  const otherPrice = otherSide === 'bid' ? cell.bid : cell.ask;
  if (Math.random() < 0.5) {
    // Re-RFQ just the traded side; the other side stays fixed at its prior price as a reference.
    cell.status = 'rfq';
    cell.rfqSide = tradedSide;
    cell.rfqVolume = APP.util.choice(RFQ_VOLUME_POOL);
    if (tradedSide === 'bid') {
      cell.ask = otherPrice; cell._fixedAskSize = APP.util.choice(AMBIENT_SIZE_POOL); cell._fixedBidSize = null;
    } else {
      cell.bid = otherPrice; cell._fixedBidSize = APP.util.choice(AMBIENT_SIZE_POOL); cell._fixedAskSize = null;
    }
    cell._kind = kind; cell._idx = idx; cell._book = !!book;
    cell.bidSize = null; cell.askSize = null;
    cell.userBidSize = 0; cell.userAskSize = 0;
    cell._advantage = null;
  } else {
    // Go indicative, with the traded side marked right at the price it just traded.
    cell.status = 'indicative';
    if (tradedSide === 'bid') {
      cell.bid = tradedPrice; cell.ask = APP.util.round5c(Math.max(tradedPrice + 0.05, otherPrice));
    } else {
      cell.ask = tradedPrice; cell.bid = APP.util.round5c(Math.min(tradedPrice - 0.05, otherPrice));
    }
    clearLiveCellFields(cell);
  }
}

function expireAmbientQuote(kind, idx, book) {
  const cell = getCell(kind, idx, book);
  if (!cell || cell.status !== 'live') return;
  let p = 0.30;
  if (cell._advantage === 'good') p = 0.55;
  else if (cell._advantage === 'bad') p = 0.12;
  const takenByOther = Math.random() < p;

  if (takenByOther) {
    const isOption = (kind === 'call' || kind === 'put');
    let side = Math.random() < 0.5 ? 'buy' : 'sell'; // the customer's action
    if (isOption && cell.bid <= 0) side = 'buy'; // never let a customer "sell" into a worthless bid
    const priceSide = side === 'buy' ? 'ask' : 'bid';
    const price = side === 'buy' ? cell.ask : cell.bid;
    const size = side === 'buy' ? cell.askSize : cell.bidSize;
    const userSize = side === 'buy' ? (cell.userAskSize || 0) : (cell.userBidSize || 0);
    const verb = side === 'buy' ? 'bought' : 'sold';
    const involvesUser = userSize > 0;
    const suffix = involvesUser ? ' from you' : '';
    triggerAlert(`Customer ${verb} ${size} ${describeInstrument(kind, idx, book)} at ${APP.util.fmt(price)}${suffix}`, involvesUser ? 'red' : 'yellow');
    if (involvesUser) {
      const dealerSide = side === 'buy' ? 'sell' : 'buy'; // the user's side of the trade
      addTrade(kind, idx, dealerSide, userSize, price);
    }
    resolveTradedSide(kind, idx, book, priceSide, price);
  } else {
    cell.status = 'indicative';
    const q = makeIndicativeQuote(kind, idx);
    cell.bid = q.bid; cell.ask = q.ask;
    clearLiveCellFields(cell);
  }
  cell._timer = null;
  ensureMinimumLiveOptions();
  renderAll();
}

function handleTake(kind, idx, book, side) {
  if (APP.session.status !== 'running' || APP.session.boardFrozen) return;
  const cell = getCell(kind, idx, book);
  if (!cell || cell.status !== 'live') return;
  const userSize = side === 'buy' ? (cell.userAskSize || 0) : (cell.userBidSize || 0);
  const totalSize = side === 'buy' ? cell.askSize : cell.bidSize;
  const tradeable = totalSize - userSize;
  if (tradeable <= 0) return;
  const price = side === 'buy' ? cell.ask : cell.bid;
  clearCellTimer(cell);
  addTrade(kind, idx, side, tradeable, price);
  toast(`You ${side === 'buy' ? 'bought' : 'sold'} ${tradeable} ${describeInstrument(kind, idx, book)} @ ${APP.util.fmt(price)}`);

  if ((cell.userBidSize || 0) > 0 || (cell.userAskSize || 0) > 0) {
    // the user still has their own resting size on this cell — keep it live, just shrink the
    // side that was taken down to what's left (the user's own portion).
    if (side === 'buy') cell.askSize = userSize; else cell.bidSize = userSize;
    const duration = Math.max(3000, tradePaceSec() * 1000 * APP.util.rand(0.5, 1.5));
    cell._timer = setTimeout(() => expireAmbientQuote(kind, idx, book), duration);
    pushTimer(cell._timer);
  } else if (kind === 'stock') {
    refreshStockQuote(); // stock never goes back to indicative — it's always live
    return;
  } else {
    resolveTradedSide(kind, idx, book, side === 'buy' ? 'ask' : 'bid', price);
  }
  ensureMinimumLiveOptions();
  renderAll();
}

function handlePull(kind, idx, book) {
  if (APP.session.status !== 'running' || APP.session.boardFrozen) return;
  const cell = getCell(kind, idx, book);
  if (!cell || cell.status !== 'live') return;
  clearCellTimer(cell);
  cell.status = 'indicative';
  const q = makeIndicativeQuote(kind, idx);
  cell.bid = q.bid; cell.ask = q.ask;
  clearLiveCellFields(cell);
  toast(`You pulled your market in ${describeInstrument(kind, idx, book)}.`);
  ensureMinimumLiveOptions();
  renderAll();
}

// ---- Board / spread-book "ask for a market" (RFQ) --------------------------

function armRfq(pick) {
  const { kind, idx, cell, book } = pick;
  const sizes = [5, 10, 15, 20, 25];
  const rfqSide = pickRfqSide(cell.status);
  cell._kind = kind; cell._idx = idx; cell._book = !!book;
  cell.rfqSide = rfqSide;
  cell.rfqVolume = APP.util.choice(RFQ_VOLUME_POOL);
  cell._fixedBidSize = rfqSide === 'ask' ? APP.util.choice(sizes) : null;
  cell._fixedAskSize = rfqSide === 'bid' ? APP.util.choice(sizes) : null;
  cell.status = 'rfq';
}

function fireBoardRFQ() {
  if (APP.session.status !== 'running') return;
  const candidates = eligibleRfqCandidates();
  if (candidates.length) {
    const pick = APP.util.choice(candidates);
    if (!pick.book || ensureSpreadBookSlot(pick.kind, pick.idx)) armRfq(pick);
    renderAll();
  }
  const delay = tradePaceSec() * 3 * 1000 * APP.util.rand(0.5, 1.5);
  const id = setTimeout(fireBoardRFQ, delay);
  pushTimer(id);
}

// Whether `kind`/`idx` can be figured out from parity using what's already on the board (its
// direct parity partner — call<->ps or put<->bw — already showing an indicative price).
function isParityDerivable(kind, idx, book) {
  const partner = kind === 'call' ? 'ps' : kind === 'ps' ? 'call' : kind === 'put' ? 'bw' : kind === 'bw' ? 'put' : null;
  if (!partner) return false;
  const pCell = getCell(partner, idx, book);
  return !!pCell && pCell.status === 'indicative';
}

function fireInitialRFQs() {
  const n = 5;
  const all = eligibleRfqCandidates();
  const derivable = all.filter(c => isParityDerivable(c.kind, c.idx, c.book));
  const rest = all.filter(c => !derivable.includes(c));
  derivable.sort(() => Math.random() - 0.5);
  rest.sort(() => Math.random() - 0.5);
  const candidates = derivable.concat(rest); // prefer parity-derivable instruments first

  let armed = 0;
  for (let i = 0; i < candidates.length && armed < n; i++) {
    const pick = candidates[i];
    if (!pick.book || ensureSpreadBookSlot(pick.kind, pick.idx)) {
      armRfq(pick);
      armed++;
    }
  }
}

// Turn a confirmed market into a live, tradeable quote (board/spread-book), or resolve it as an
// IDB print. bid/ask/bidSize/askSize are already-parsed numbers.
function submitMarket(kind, idx, book, bid, ask, bidSize, askSize, isIdb) {
  if (APP.session.status !== 'running') return { error: 'Session is not running.' };
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
    renderAll();
    const delay = APP.util.rand(1500, 3200);
    pushTimer(setTimeout(() => resolveIdbDecision(), delay));
  } else {
    const cell = getCell(kind, idx, book);
    const side = cell.rfqSide || 'both';
    cell.bid = bid; cell.ask = ask;
    cell.bidSize = bidSize; cell.askSize = askSize;
    cell.userBidSize = (side === 'bid' || side === 'both') ? bidSize : 0;
    cell.userAskSize = (side === 'ask' || side === 'both') ? askSize : 0;
    cell.rfqSide = null; cell.rfqVolume = null; cell._fixedBidSize = null; cell._fixedAskSize = null;
    cell._advantage = 'neutral';
    cell.status = 'live';
    const duration = Math.max(3000, tradePaceSec() * 1000 * APP.util.rand(0.8, 1.6));
    cell._timer = setTimeout(() => expireAmbientQuote(kind, idx, book), duration);
    pushTimer(cell._timer);
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

function fireIDBRFQ() {
  if (APP.session.status !== 'running') return;
  if (APP.config.idbOn && !APP.idb.active) {
    const all = enumerateBoardCells().filter(c => c.kind !== 'stock');
    const pick = APP.util.choice(all);
    const boardCell = pick.cell; // just a reference for a fixed side — not mutated
    const sizes = [5, 10, 15, 20, 25];
    const rfqSide = pickRfqSide(boardCell.status);
    APP.session.boardFrozen = true;
    APP.idb.active = {
      kind: pick.kind, idx: pick.idx, status: 'awaiting_market',
      rfqSide, rfqVolume: APP.util.choice(RFQ_VOLUME_POOL),
      fixedBid: boardCell.bid, fixedBidSize: rfqSide === 'ask' ? APP.util.choice(sizes) : null,
      fixedAsk: boardCell.ask, fixedAskSize: rfqSide === 'bid' ? APP.util.choice(sizes) : null,
      bid: null, ask: null, bidSize: null, askSize: null,
    };
    renderAll();
  }
  const delay = tradePaceSec() * 5 * 1000 * APP.util.rand(0.5, 1.5);
  const id = setTimeout(fireIDBRFQ, delay);
  pushTimer(id);
}

function resolveIdbDecision() {
  const active = APP.idb.active;
  if (!active) return;
  const mid = fairMid(active.kind, active.idx);
  const decision = decideTrade(active.kind, mid, active.bid, active.ask);
  let msg;
  if (decision) {
    const dealerSide = decision === 'buy' ? 'sell' : 'buy';
    const price = decision === 'buy' ? active.ask : active.bid;
    const size = decision === 'buy' ? active.askSize : active.bidSize;
    addTrade(active.kind, active.idx, dealerSide, size, price);
    const verb = decision === 'buy' ? 'bought' : 'sold';
    msg = `IDB: customer ${verb} ${size} ${describeInstrument(active.kind, active.idx)} @ ${APP.util.fmt(price)}`;
    triggerAlert(`Customer ${verb} ${size} ${describeInstrument(active.kind, active.idx)} at ${APP.util.fmt(price)} from you`, 'red');
  } else {
    msg = `IDB: customer passed on ${describeInstrument(active.kind, active.idx)} (${APP.util.fmt(active.bid)} - ${APP.util.fmt(active.ask)})`;
  }
  APP.idb.log.unshift({ id: APP.util.uid(), text: msg, ts: APP.session.elapsedSec });
  APP.idb.active = null;
  APP.session.boardFrozen = false;
  renderAll();
}

// ---- session clock -----------------------------------------------------------

function tickClock() {
  if (APP.session.status !== 'running') return;
  APP.session.elapsedSec = (Date.now() - APP.session.startEpoch) / 1000;
  const total = APP.config.simLengthMin * 60;
  if (APP.session.elapsedSec >= total) {
    APP.session.elapsedSec = total;
    endSession();
    return;
  }
  renderClock();
  const id = setTimeout(tickClock, 500);
  pushTimer(id);
}

// ---- lifecycle ---------------------------------------------------------------

function clearAllTimers() {
  APP.session.timers.forEach(id => clearTimeout(id));
  APP.session.timers = [];
}

function startSession() {
  initMarket();
  buildSkeleton();
  applyInitialFill();
  APP.position.legs = [];
  APP.idb.log = [];
  APP.idb.active = null;
  APP.alerts = [];
  if (APP.config.startWithPosition) generateStartingPosition();
  APP.session.status = 'running';
  APP.session.startEpoch = Date.now();
  APP.session.elapsedSec = 0;
  APP.session.boardFrozen = false;
  fireInitialRFQs();
  ensureMinimumLiveOptions();
  renderAll();
  tickClock();
  refreshStockQuote();
  const a1 = setTimeout(fireAmbientQuote, tradePaceSec() * 1000 * APP.util.rand(0.4, 1.0));
  pushTimer(a1);
  const a2 = setTimeout(fireBoardRFQ, tradePaceSec() * 3 * 1000 * APP.util.rand(0.5, 1.5));
  pushTimer(a2);
  const a3 = setTimeout(fireIDBRFQ, tradePaceSec() * 5 * 1000 * APP.util.rand(0.5, 1.5));
  pushTimer(a3);
  const a4 = setTimeout(watchdogTick, APP.util.rand(8000, 13000));
  pushTimer(a4);
}

function endSession() {
  APP.session.status = 'ended';
  clearAllTimers();
  renderAll();
  const pnl = hasPosition() ? payoffAt(currentSpot()) : 0;
  document.getElementById('simFinalStats').textContent = `P&L at current spot: ${APP.util.fmtSigned(pnl)}`;
  showScreen('simResults');
}

// Stops the running session without touching which screen is shown — used when the user opens
// "Reset configuration" to go back and change settings.
function stopSession() {
  clearAllTimers();
  APP.session.status = 'idle';
  APP.session.boardFrozen = false;
}
