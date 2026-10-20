// Put-call parity speed drill (Zetamac-style).
//
// Model: for a fixed strike K and fixed carry rc (0 for a future), parity says C - P = X - K + rc,
// where X is the delta-1 price (future or stock). Writing D = C - P = X - K + rc and T = C + P
// (the straddle), every displayable quantity is an affine function of (D, T). P+S and B/W are
// quoted the way a floor combo actually trades — relative to the strike, not as a raw stock-scale
// dollar sum — so they reduce to a clean offset of their paired option with no strike needed:
//   delta1   =  D            + (K-rc)
//   call     =  0.5D + 0.5T
//   put      = -0.5D + 0.5T
//   ps       =  0.5D + 0.5T  - rc            (= call - rc)           [stock only]
//   bw       = -0.5D + 0.5T  + rc            (= put + rc)            [stock only]
//   straddle =        T
//   combo    = |D|                            (single-price stock drill only)
//
// Drill flavours, per delta-1 mode (future | stock) and tick (0.01 | 0.05 | 0.10):
//   single price : one price is missing — work it out and type it (the original drill)
//   order book   : every instrument shows a 3-level book, and the questions are
//     make    — one instrument's book is blank: enter a two-way market (scored vs. the best
//               market its replication from the other books allows),
//     arb     — every book is filled: hit the prices that form an arbitrage, or call "no arbitrage", and
//     improve — no arbitrage yet: tighten the one market that can be tightened into one, then complete it.

const DRILL_DEF = {
  stock: { a: 1, b: 0 },
  call: { a: 0.5, b: 0.5 },
  put: { a: -0.5, b: 0.5 },
  ps: { a: 0.5, b: 0.5 },
  bw: { a: -0.5, b: 0.5 },
  straddle: { a: 0, b: 1 },
};

const DRILL_FAMILIES_STOCK = { stock: ['stock'], call: ['call', 'ps'], put: ['put', 'bw'], straddle: ['straddle'] };
const DRILL_FAMILIES_FUTURE = { stock: ['stock'], call: ['call'], put: ['put'], straddle: ['straddle'] };

function drillFamilies() { return APP.drill.delta1 === 'future' ? DRILL_FAMILIES_FUTURE : DRILL_FAMILIES_STOCK; }
function drillBookKeys() { return APP.drill.delta1 === 'future' ? ['stock', 'call', 'put', 'straddle'] : ['stock', 'call', 'put', 'ps', 'bw', 'straddle']; }
function drillSingleKeys() { return APP.drill.delta1 === 'future' ? drillBookKeys() : drillBookKeys().concat('combo'); }
function drillName(key) {
  if (key === 'stock') return delta1LabelDrill();
  return { call: 'Call', put: 'Put', ps: 'P + S', bw: 'B/W', straddle: 'Straddle', combo: 'Combo' }[key];
}
function delta1LabelDrill() { return APP.drill.delta1 === 'future' ? 'Future' : 'Stock'; }

function drillConst(key, K, rc) {
  // the constant term of each quantity's affine formula (0 for call/put/straddle)
  if (key === 'stock') return K - rc;
  if (key === 'ps') return -rc;
  if (key === 'bw') return rc;
  return 0;
}

function drillFamilyOf(key) {
  const fams = drillFamilies();
  return Object.keys(fams).find(f => fams[f].includes(key));
}

function drillPartner(key) {
  if (APP.drill.delta1 === 'future') return null;
  if (key === 'call') return 'ps';
  if (key === 'ps') return 'call';
  if (key === 'put') return 'bw';
  if (key === 'bw') return 'put';
  return null;
}

// Picks two givens from two distinct families (one representative each) — guarantees a solvable,
// non-redundant pair every time, and gives the {delta-1, single option} case a real, guaranteed
// share rather than leaving it to chance.
function pickTwoFamilyGivens(familyNames) {
  const fams = drillFamilies();
  const shuffled = familyNames.slice().sort(() => Math.random() - 0.5);
  const g1 = APP.util.choice(fams[shuffled[0]]);
  const g2 = APP.util.choice(fams[shuffled[1]]);
  return Math.random() < 0.5 ? [g1, g2] : [g2, g1];
}

// Picks a minimal-but-sufficient set of "given" quantities (never including combo) for `target`.
function chooseDrillGivens(target) {
  const famNames = Object.keys(drillFamilies());
  if (target === 'combo') {
    if (Math.random() < 0.4) return ['stock']; // |D| reads straight off stock, no ambiguity
    return pickTwoFamilyGivens(famNames);
  }
  const partner = drillPartner(target);
  if (partner && Math.random() < 0.35) return [partner];
  const otherFamilies = famNames.filter(f => f !== drillFamilyOf(target));
  return pickTwoFamilyGivens(otherFamilies);
}

function solveDrillTarget(target, givens, values, K, rc) {
  if (givens.length === 1) {
    const g = givens[0];
    if (target === 'combo') return Math.abs(values[g] - drillConst(g, K, rc)); // g is 'stock' here, this is |D|
    const gd = DRILL_DEF[g], td = DRILL_DEF[target];
    const k = Math.abs(gd.a) > 1e-9 ? td.a / gd.a : td.b / gd.b;
    return k * (values[g] - drillConst(g, K, rc)) + drillConst(target, K, rc);
  }
  const [g1, g2] = givens;
  const d1 = DRILL_DEF[g1], d2 = DRILL_DEF[g2];
  const rhs1 = values[g1] - drillConst(g1, K, rc);
  const rhs2 = values[g2] - drillConst(g2, K, rc);
  const det = d1.a * d2.b - d2.a * d1.b;
  const D = (rhs1 * d2.b - rhs2 * d1.b) / det;
  const T = (d1.a * rhs2 - d2.a * rhs1) / det;
  if (target === 'combo') return Math.abs(D);
  const td = DRILL_DEF[target];
  return td.a * D + td.b * T + drillConst(target, K, rc);
}

// Bag randomizer: shuffle every kind, hand them out one at a time, reshuffle once empty.
// Guarantees every kind appears once per bag instead of long same-kind streaks.
function nextFromBag(name, items) {
  const bag = APP.drill.bags[name];
  if (!bag || bag.length === 0) APP.drill.bags[name] = items.slice().sort(() => Math.random() - 0.5);
  return APP.drill.bags[name].pop();
}

const r2 = (x) => Math.round(x * 100) / 100;

// A scenario grounded in the same (pseudo) Black-Scholes engine the simulation uses, so Call/Put
// behave like genuine option prices. Futures are undiscounted (r = q = 0) and carry no r/c; for a
// stock r and q are each randomized independently (q can exceed r), which is also what lets the
// implied carry rc come out negative, like a high-dividend name in real life.
function drillBase() {
  const future = APP.drill.delta1 === 'future';
  const K = APP.util.choice([60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140]);
  const spotSeed = K * APP.util.rand(0.85, 1.15);
  const vol = APP.util.rand(0.15, 0.45);
  const yrs = APP.util.rand(10, 90) / 365;
  const r = future ? 0 : APP.util.rand(0.02, 0.05);
  const q = future ? 0 : APP.util.rand(0, 0.08);

  const callTrue = BS.price(spotSeed, K, yrs, r, q, vol, 'call');
  const putTrue = BS.price(spotSeed, K, yrs, r, q, vol, 'put');

  // D and T are multiples of two ticks, so that the call and put (half their sum and difference) land on the tick
  const t = dtick(), step = 2 * t;
  const D = r2(Math.round((callTrue - putTrue) / step) * step);
  let T = r2(Math.round((callTrue + putTrue) / step) * step);
  if (T <= Math.abs(D) + step) T = r2(Math.abs(D) + 5 * step);    // guard against a rounded-away straddle

  const rc = future ? 0 : r2(Math.round((spotSeed * (Math.exp((r - q) * yrs) - 1)) / t) * t); // a multiple of the tick

  const values = {};
  Object.keys(DRILL_DEF).forEach(k => {
    if (future && (k === 'ps' || k === 'bw')) return;
    const d = DRILL_DEF[k];
    values[k] = r2(d.a * D + d.b * T + drillConst(k, K, rc));
  });
  values.combo = r2(Math.abs(D));
  return { K, rc, D, T, values };
}

// ---- single-price drill ---------------------------------------------------------

function generateSingleQuestion() {
  const { K, rc, values } = drillBase();
  const target = nextFromBag('single', drillSingleKeys());
  const givens = chooseDrillGivens(target);
  const answer = r2(solveDrillTarget(target, givens, values, K, rc));
  return { type: 'single', K, rc, values, target, givens, answer };
}

function drillShowFor(key) {
  const q = APP.drill.question;
  if (key === q.target) return '?';
  if (q.givens.includes(key)) return APP.util.fmt(q.values[key]);
  return '—';
}

function singleBoardHtml() {
  const q = APP.drill.question;
  const col = (key, label, style, extra) =>
    `<div class="drill-col" style="${style}"><div class="drill-collabel">${label}</div><div class="drill-cell ${extra || ''} ${q.target === key ? 'drill-target' : ''}">${drillShowFor(key)}</div></div>`;
  const strike = (style) => `<div class="drill-col" style="${style}"><div class="drill-collabel">Strike</div><div class="drill-cell strike">${q.K}</div></div>`;
  if (APP.drill.delta1 === 'future') {
    return `<div id="drillGrid" class="grid3">
      ${col('stock', 'Future', 'grid-column:2; grid-row:1;', 'big')}
      ${col('call', 'Call', 'grid-column:1; grid-row:2;')}
      ${strike('grid-column:2; grid-row:2;')}
      ${col('put', 'Put', 'grid-column:3; grid-row:2;')}
      ${col('straddle', 'Straddle', 'grid-column:2; grid-row:3;')}
    </div>`;
  }
  return `<div id="drillGrid">
    ${col('stock', 'Stock', 'grid-column:3; grid-row:1;', 'big')}
    <div class="drill-col" style="grid-column:4 / span 2; grid-row:1;"><div class="drill-collabel">R/C</div><div class="drill-cell rc">${APP.util.fmtSigned(q.rc)}</div></div>
    ${col('ps', 'P + S', 'grid-column:1; grid-row:2;')}
    ${col('call', 'Call', 'grid-column:2; grid-row:2;')}
    ${strike('grid-column:3; grid-row:2;')}
    ${col('put', 'Put', 'grid-column:4; grid-row:2;')}
    ${col('bw', 'B/W', 'grid-column:5; grid-row:2;')}
    ${col('straddle', 'Straddle', 'grid-column:2; grid-row:3;')}
    ${col('combo', 'Combo', 'grid-column:4; grid-row:3;')}
  </div>`;
}

function handleDrillAnswerInput(e) {
  const q = APP.drill.question;
  if (!q || q.type !== 'single' || APP.drill.paused) return;
  const val = parseFloat(e.target.value);
  if (isNaN(val)) return;
  if (Math.abs(val - q.answer) < 0.005) {
    addDrillScore(1, { value: val });
    nextDrillQuestion();
  }
}

// ---- order-book drill: question generation --------------------------------------
//
// Three question types, each on a row of 3-level order books (sizes shown, bars proportional):
//   arb     (Arbitrage Opportunity) — tick the legs of the riskless trade, or call "No Arbitrage"
//   make    (Make a Market)         — only two other instruments are shown; quote the blank one
//   improve (Improve a Market)      — no arbitrage yet, but one market can be tightened to create one:
//                                     improve it, get the trade, then complete the other legs
// Every price is taken in its entirety, so quantities/ratios never come into it (except the size of the
// market you improve). Only the best price on each side counts toward an arbitrage — deeper levels are depth.

const DRILL_LEVELS = 3;

// The drills' price tick (0.01 / 0.05 / 0.10), fixed for a drill at its start.
function dtick() { return APP.drill.tick || 0.05; }
const dft = (x) => r2(Math.floor(x / dtick() + 1e-9) * dtick());   // down to the tick
const dct = (x) => r2(Math.ceil(x / dtick() - 1e-9) * dtick());    // up to the tick

// Typical size of a *good* best price per instrument; a bar is full at double the typical size
// (a straddle is worth about two options, so it's quoted at half the size).
function typicalSize(key) { return key === 'straddle' ? 100 : 200; }
function maxSize(key) { return 2 * typicalSize(key); }
function normalSize(key) { return Math.max(10, Math.round(typicalSize(key) * APP.util.rand(0.45, 1.1) / 10) * 10); }
const shuffled = (arr) => arr.slice().sort(() => Math.random() - 0.5);

// Levels behind a best price: each a tick or two worse, and bigger than the one in front.
function deepen(px, size, dir, key) {
  const levels = [{ px: r2(px), size }];
  for (let i = 1; i < DRILL_LEVELS; i++) {
    const prev = levels[i - 1];
    levels.push({
      px: r2(prev.px + dir * dtick() * APP.util.choice([1, 1, 2])),
      size: Math.min(maxSize(key), Math.round(prev.size * APP.util.rand(1.3, 2.0) / 5) * 5),
    });
  }
  return levels;
}

// The same, for books with big or odd sizes (no cap, and rounded to a sensible unit).
function deepenFree(px, size, dir) {
  const unit = size >= 5000 ? 1000 : (size >= 500 ? 100 : 10);
  const levels = [{ px: r2(px), size }];
  for (let i = 1; i < DRILL_LEVELS; i++) {
    const prev = levels[i - 1];
    levels.push({
      px: r2(prev.px + dir * dtick() * APP.util.choice([1, 1, 2])),
      size: Math.max(unit, Math.round(prev.size * APP.util.rand(1.3, 2.0) / unit) * unit),
    });
  }
  return levels;
}

// A book from its best bid/offer (sizes optional). bid/ask/bidSize/askSize always mirror level 1.
function buildBook(bid, ask, key, bidSize, askSize) {
  const bs = bidSize != null ? bidSize : normalSize(key), as = askSize != null ? askSize : normalSize(key);
  return { bid: r2(bid), ask: r2(ask), bidSize: bs, askSize: as, bids: deepen(bid, bs, -1, key), asks: deepen(ask, as, +1, key) };
}

// A market around `mid`. Odd-tick widths sit a half-tick off-centre (both prices stay on the tick
// grid), so the displayed midpoint is sometimes not the fair value exactly — as in life.
function makeBook(mid, key) {
  const n = APP.util.choice([1, 2, 3, 4]); // total width in ticks
  const bidSteps = n % 2 === 0 ? n / 2 : (Math.random() < 0.5 ? (n - 1) / 2 : (n + 1) / 2);
  const bid = r2(mid - bidSteps * dtick());
  return buildBook(bid, bid + n * dtick(), key);
}

function booksToQuotes(books, skip) {
  const quotes = {};
  Object.keys(books).forEach(k => { if (k !== skip && books[k]) quotes[k] = { bid: books[k].bid, ask: books[k].ask }; });
  return quotes;
}

// ---- what a market can look like -------------------------------------------------------
// Every market has bid < ask (and each deeper level is strictly worse), and nothing is ever bid for
// less than its intrinsic value: an option is worth at least that, so you'd always pay it. With
// D = call - put (= X - K + rc), parity gives call >= D, put >= -D and straddle >= |D|, so those are
// the floors (P+S and B/W are the call and the put shifted by r/c). Nothing is bid for nothing at all.
function drillFloors(base) {
  const D = base.D, rc = base.rc;
  const f = { stock: -Infinity, call: Math.max(0, D), put: Math.max(0, -D), straddle: Math.abs(D) };
  if (APP.drill.delta1 === 'stock') { f.ps = Math.max(0, D) - rc; f.bw = Math.max(0, -D) + rc; }
  Object.keys(f).forEach(k => { if (isFinite(f[k])) f[k] = r2(f[k]); });
  return f;
}

function bookIsSane(b) {
  if (!b || !b.bids.length || !b.asks.length) return false;
  if (!(b.bids[0].px < b.asks[0].px - 1e-9)) return false;
  for (let i = 1; i < b.bids.length; i++) if (!(b.bids[i].px < b.bids[i - 1].px - 1e-9)) return false;
  for (let i = 1; i < b.asks.length; i++) if (!(b.asks[i].px > b.asks[i - 1].px + 1e-9)) return false;
  return Math.abs(b.bid - b.bids[0].px) < 1e-9 && Math.abs(b.ask - b.asks[0].px) < 1e-9;
}

function booksRespectFloors(books, floors) {
  return Object.keys(books).every(k => {
    const b = books[k];
    if (!b) return true;
    const free = k === 'ps' || k === 'bw' || k === 'stock'; // strike-relative / the underlying: no "above nothing" rule
    const lo = Math.max(floors[k] == null ? -Infinity : floors[k], free ? -Infinity : 0.0001);
    return b.bids.every(l => l.px >= lo - 1e-9);
  });
}

function booksAreValid(books, floors) { return Object.keys(books).every(k => bookIsSane(books[k])) && booksRespectFloors(books, floors); }

// Make a Market: show just two instruments from different families (enough to work the answer out).
function generateMakeQuestion() {
  for (let tries = 0; tries < 200; tries++) {
    const base = drillBase();
    const keys = drillBookKeys();
    const target = nextFromBag('make', keys);
    const others = Object.keys(drillFamilies()).filter(f => f !== drillFamilyOf(target));
    const givens = pickTwoFamilyGivens(others);
    const floors = drillFloors(base);
    const books = {};
    givens.forEach(k => { books[k] = makeBook(base.values[k], k); });
    if (!booksAreValid(books, floors)) continue;
    const vecs = arbVectors(APP.drill.delta1, base.K, base.rc);
    const best = bestMarketFromOthers(vecs, target, booksToQuotes(books));
    if (best.bid == null || best.ask == null || best.ask - best.bid < dtick() - 1e-9) continue;
    // you'd always pay at least intrinsic value (and never less than nothing) for an option, so the
    // best bid is never below that, however low the replication says it could go
    let bestBid = dft(best.bid);
    const floorT = floors[target];
    if (isFinite(floorT) && bestBid < floorT) bestBid = floorT;
    const bestAsk = dct(best.ask);
    if (bestAsk <= bestBid) continue;
    return {
      type: 'make', K: base.K, rc: base.rc, D: base.D, T: base.T, values: base.values, floor: floorT, books, target, givens,
      best: { bid: bestBid, ask: bestAsk, fair: (best.bid + best.ask) / 2, rawBid: best.bid, rawAsk: best.ask, bidRep: best.bidRep, askRep: best.askRep },
    };
  }
  return generateMakeQuestion();
}

// Pushes one instrument's book off-market so it can be arbitraged against the replication from the
// other books: bid above what the rest can sell it for, or offer below what the rest can buy it for.
function shiftBookIntoArb(key, books, vecs) {
  const t = dtick();
  const best = bestMarketFromOthers(vecs, key, booksToQuotes(books, key));
  const e = t * APP.util.choice([1, 1, 2, 2, 3, 4]);
  const n = APP.util.choice([1, 2, 3, 4]);
  const wantBid = Math.random() < 0.5;
  if (wantBid && best.ask != null) {
    let bid = dct(best.ask + e);
    if (bid <= best.ask + 1e-9) bid += t;
    books[key] = buildBook(bid, bid + n * t, key);
  } else if (best.bid != null) {
    let ask = dft(best.bid - e);
    if (ask >= best.bid - 1e-9) ask -= t;
    books[key] = buildBook(ask - n * t, ask, key);
  }
}

// Arbitrage Opportunity: 80% of the time there's a riskless trade on the screen (at most six ticks).
function generateArbQuestion() {
  const wantArb = Math.random() < 0.8;
  for (let tries = 0; tries < 400; tries++) {
    const base = drillBase();
    const keys = drillBookKeys();
    const vecs = arbVectors(APP.drill.delta1, base.K, base.rc);
    const books = {};
    keys.forEach(k => { books[k] = makeBook(base.values[k], k); });
    if (wantArb) {
      shuffled(keys).slice(0, Math.random() < 0.4 ? 2 : 1).forEach(t => shiftBookIntoArb(t, books, vecs));
    }
    // every market sane (bid < ask), nothing bid below intrinsic value or for nothing (P+S and B/W are
    // strike-relative and may be negative)
    if (!booksAreValid(books, drillFloors(base))) continue;
    const arbs = findArbs(vecs, booksToQuotes(books));
    if (wantArb ? (arbs.length > 0 && arbs[0].profit <= 6 * dtick() + 1e-9) : arbs.length === 0) {
      return { type: 'arb', K: base.K, rc: base.rc, D: base.D, T: base.T, values: base.values, books, arbs };
    }
  }
  return generateArbQuestion();
}

// ---- Improve a Market ---------------------------------------------------------------------
// There's no arbitrage on the screen, but one market is wider than the other books imply, so it can be
// tightened — on the bid or the offer — to create one. A big order sits in the books (its size says so): the
// delta-1 for a customer who wants direction (so a deep in-the-money option gives the same exposure),
// an at-the-money option or straddle for a customer who wants vol (so you improve another ATM option).
// The customer needn't be informed: the order is firm, so you can always trade against it to hedge, and
// that anchors everything else. Improve the market, take the trade, then complete the other legs.

// The package that goes with improving `key` on `side`: you buy `key` at your bid (side 'bid') and sell
// the replicating package for the implied bid, or sell `key` at your offer and buy the package for the
// implied offer. Returns how many lots of `key` the other books can absorb (the limiting leg).
function improvePackageSize(books, rep, side) {
  let size = Infinity;
  Object.entries(rep.w).forEach(([n, w]) => {
    const lvl = ((side === 'bid') === (w > 0)) ? books[n].bids[0] : books[n].asks[0]; // the side the package leg trades on
    size = Math.min(size, lvl.size / Math.abs(w));
  });
  return Math.floor(size + 1e-9);
}

// Every market with room to be improved into an arbitrage. For a bid: the best price you can still bid
// and have the other books pay you more for the package (strictly below the implied bid, on the tick).
function improveOptions(books, vecs) {
  const t = dtick(), out = [];
  Object.keys(books).forEach(key => {
    const imp = bestMarketFromOthers(vecs, key, booksToQuotes(books, key));
    const b = books[key];
    if (imp.bid != null && imp.bidRep) {
      const maxPx = r2((Math.ceil(imp.bid / t - 1e-9) - 1) * t);
      const room = Math.round((maxPx - b.bid) / t);
      if (room >= 1 && maxPx < b.ask - 1e-9) out.push({ key, side: 'bid', limit: maxPx, room, implied: imp.bid, rep: imp.bidRep, size: improvePackageSize(books, imp.bidRep, 'bid') });
    }
    if (imp.ask != null && imp.askRep) {
      const minPx = r2((Math.floor(imp.ask / t + 1e-9) + 1) * t);
      const room = Math.round((b.ask - minPx) / t);
      if (room >= 1 && minPx > b.bid + 1e-9) out.push({ key, side: 'ask', limit: minPx, room, implied: imp.ask, rep: imp.askRep, size: improvePackageSize(books, imp.askRep, 'ask') });
    }
  });
  return out;
}

// The arbitrage packages you'd have once `user` ({key, side, px}) is filled: you buy (your bid is hit) or
// sell (your offer is lifted) at your price, and lay it off against the other books with the replicating
// package — whichever replications leave a profit. Legs are [{name, side, qty}], profit per package.
function improveArbs(q, user) {
  const vecs = arbVectors(APP.drill.delta1, q.K, q.rc);
  const quotes = booksToQuotes(q.books);
  const names = Object.keys(quotes).filter(n => vecs[n]);
  const tSide = user.side === 'bid' ? 'buy' : 'sell';
  const out = [];
  arbReplications(vecs, user.key, names).forEach(rep => {
    const b = arbReplBounds(rep, quotes);
    if (!b) return;
    const profit = tSide === 'buy' ? b.lo - user.px : user.px - b.hi;
    if (profit <= 1e-9) return;
    const raw = [{ name: user.key, side: tSide, qty: 1 }];
    Object.keys(rep.w).forEach(n => raw.push({ name: n, side: (tSide === 'sell') === (rep.w[n] > 0) ? 'buy' : 'sell', qty: Math.abs(rep.w[n]) }));
    const m = arbIntegerScale(raw.map(l => l.qty));
    if (!m) return;
    out.push({ legs: raw.map(l => ({ name: l.name, side: l.side, qty: Math.round(l.qty * m) })), profit: profit * m });
  });
  return out.sort((x, y) => y.profit - x.profit);
}

function generateImproveQuestion(depth) {
  const wantCue = Math.random() < 0.5 ? 'delta' : 'vol';
  for (let tries = 0; tries < 3000; tries++) {
    const base = drillBase();
    const t = dtick();
    const m = Math.abs(base.D) / base.T; // 0 = at the money
    const cue = wantCue;                  // half the questions are a view on direction, half on vol
    if (cue === 'delta' ? m < 0.4 : m > 0.2) continue;
    const keys = drillBookKeys();
    const floors = drillFloors(base);
    const vecs = arbVectors(APP.drill.delta1, base.K, base.rc);
    const dir = Math.random() < 0.5 ? 1 : -1;            // the large order: +1 buying, -1 selling
    const aggSide = dir > 0 ? 'bid' : 'ask';             // the side of the book the customer sits on
    const itmCall = base.D > 0;

    // who the large order is, and which market to improve
    let anchorKey, targetKey, targetSide;
    if (cue === 'delta') {
      anchorKey = 'stock';                                // an aggressive order in the delta-1 ...
      targetKey = itmCall ? 'call' : 'put';               // ... and the deep in-the-money option with the same exposure
      targetSide = itmCall ? aggSide : (aggSide === 'bid' ? 'ask' : 'bid');
    } else {
      anchorKey = APP.util.choice(['straddle', 'call', 'put']); // a vol order in an at-the-money option or straddle ...
      targetKey = APP.util.choice(['straddle', 'call', 'put'].filter(k => k !== anchorKey)); // ... improve another ATM option market
      targetSide = aggSide;                               // (every vega instrument moves together)
    }

    // fair-centred markets, a few ticks either side; the target's loose on one side
    const halfOf = (k) => k === 'stock' ? APP.util.choice([1, 1, 2]) : (k === 'straddle' ? APP.util.choice([3, 4, 5]) : APP.util.choice([2, 3]));
    // ordinary sizes — small, and nothing like the large order (the future's the deepest of them, but only
    // by a few times over the options)
    const sizeOf = (k) => k === 'stock' ? APP.util.choice([200, 300, 500, 800])
      : (k === 'straddle' ? APP.util.choice([100, 200, 300]) : APP.util.choice([50, 100, 100, 150, 200]));
    const books = {};
    keys.forEach(k => {
      const f = base.values[k], h = halfOf(k);
      let bid = r2(f - h * t), ask = r2(f + h * t);
      let bs = sizeOf(k), as = sizeOf(k);
      if (k === targetKey) { // too wide on the side to improve (and small, as an ordinary market is)
        const extra = t * APP.util.randInt(4, 9);
        if (targetSide === 'bid') bid = r2(bid - extra); else ask = r2(ask + extra);
      }
      const bidNormal = bs, askNormal = as; // what each side's depth is built from
      let big = 0;
      if (k === anchorKey) { // the large order: top of book on the customer's side, aggressive, and far bigger than anything else on the screen
        const e = t * APP.util.choice([0, 1]);
        big = anchorKey === 'stock' ? APP.util.choice([100000, 200000, 500000]) : APP.util.choice([50000, 100000]);
        if (aggSide === 'bid') { bid = r2(bid + e); bs = big; } else { ask = r2(ask - e); as = big; }
      }
      if (ask <= bid + 1e-9) ask = r2(bid + t);
      const bids = deepenFree(bid, bidNormal, -1), asks = deepenFree(ask, askNormal, +1);
      bids[0].size = bs; asks[0].size = as; // (the depth behind a large order is ordinary)
      books[k] = { bid, ask, bidSize: bs, askSize: as, bids, asks };
    });
    const aBook = books[anchorKey];
    (aggSide === 'bid' ? aBook.bids[0] : aBook.asks[0]).large = true; // (marks the anchor level for the explanation only: nothing is labelled on screen)

    if (!booksAreValid(books, floors)) continue;
    if (findArbs(vecs, booksToQuotes(books)).length) continue;            // nothing to take yet
    const targets = improveOptions(books, vecs);
    const intended = targets.find(o => o.key === targetKey && o.side === targetSide);
    if (!intended) continue;
    if (intended.room < 2 || intended.size < 20 || targets.length > 4) continue;
    // improving to the limit really does leave an arbitrage that includes the improved leg
    const q = { type: 'improve', K: base.K, rc: base.rc, D: base.D, T: base.T, values: base.values, floors, books, cue, dir, anchor: { key: anchorKey, side: aggSide }, targets, intended };
    if (!improveArbs(q, { key: intended.key, side: intended.side, px: intended.limit }).length) continue;
    // the sizes must make sense: the limiting leg is a real, round number of lots
    if (intended.size > 100000) continue;
    q.phase = 'quote'; q.user = null; q.history = []; q.attempts = 0; q.first = null;
    return q;
  }
  if ((depth || 0) > 2) return null;
  return generateImproveQuestion((depth || 0) + 1);
}

// ---- order-book drill: rendering --------------------------------------------------

function r2c(x) { return APP.util.fmt(x); }

function sheetKeys() {
  return APP.drill.delta1 === 'future'
    ? ['stock', 'call', 'put', 'straddle']
    : ['stock', 'ps', 'call', 'put', 'bw', 'straddle'];
}

function sheetHeaderFor(key, K) {
  return key === 'stock' ? drillName('stock') : `${K} ${drillName(key)}`;
}

// The board is drawn for the live question — or, for "Explain Last Answer", for the last one: read-only,
// with the best prices marked. DRILL_CTX = { q, hl: {'key:side:level': 'buy'|'sell'}, answer: {bid, ask} }.
let DRILL_CTX = null;
function rq() { return DRILL_CTX ? DRILL_CTX.q : APP.drill.question; }
function sheetHeader(key) { return sheetHeaderFor(key, rq().K); }

// A level's fill grows out from the centre divider in proportion to its size (full at double the
// typical size): bids to the left in green, offers to the right in red.
function barStyle(key, size, side) {
  const pct = Math.min(100, Math.round(size / maxSize(key) * 100));
  return side === 'bid'
    ? `background:linear-gradient(to left, rgba(34,160,80,0.34) ${pct}%, transparent ${pct}%)`
    : `background:linear-gradient(to right, rgba(214,48,48,0.30) ${pct}%, transparent ${pct}%)`;
}

function pickBtnHtml(key, side, level) {
  const picked = !!APP.drill.sel[`${key}:${side}:${level}`];
  return `<button class="dbtn ${side === 'sell' ? 'yours' : 'mine'} ${picked ? 'picked' : ''}" data-drill="pick" data-name="${key}" data-side="${side}" data-level="${level}">${side === 'sell' ? 'Yours' : 'Mine'}</button>`;
}

// One half of a ladder row. bids: [size  price  Yours] | asks: [Mine  price  size]
function halfHtml(key, book, side, level, withBtn, input) {
  const lv = side === 'bid' ? book.bids[level] : book.asks[level];
  const cls = side === 'bid' ? 'bid' : 'ask';
  if (input) {
    if (DRILL_CTX) { // explaining: show the best market (and what was typed) where the answer boxes were
      const a = DRILL_CTX.answer || {};
      const best = DRILL_CTX.q.best;
      const v = side === 'bid' ? best.bid : best.ask, mine = side === 'bid' ? a.bid : a.ask;
      return `<td class="half ${cls} has target"><div class="hr"><span class="px">${r2c(v)}</span></div><div class="ansnote">${mine != null && !isNaN(mine) ? `you: ${r2c(mine)}` : 'best'}</div></td>`;
    }
    return `<td class="half ${cls} has target"><input id="${side === 'bid' ? 'mkBid' : 'mkAsk'}" type="number" step="${dtick()}" placeholder="${side === 'bid' ? 'Bid' : 'Ask'}" autocomplete="off"></td>`;
  }
  if (!lv) return `<td class="half ${cls}"></td>`;
  const sz = `<span class="sz">(x${lv.size})</span>`, px = `<span class="px">${r2c(lv.px)}</span>`;
  const act = side === 'bid' ? 'sell' : 'buy';
  let btn = withBtn ? pickBtnHtml(key, act, level) : '';
  let hl = '';
  if (lv.you) { hl = ' you'; btn = `<span class="hlbadge you">You</span>`; } // the market you've improved
  else if (DRILL_CTX) {
    const on = DRILL_CTX.hl[`${key}:${act}:${level}`];
    if (on) { hl = ` hl hl-${act}`; btn = `<span class="hlbadge ${act}">${act === 'sell' ? 'Yours' : 'Mine'} ✔</span>`; }
  }
  const inner = side === 'bid' ? sz + px + btn : btn + px + sz;
  return `<td class="half ${cls} has${level === 0 ? ' best' : ''}${hl}" style="${barStyle(key, lv.size, side)}"><div class="hr">${inner}</div></td>`;
}

// The book as drawn: for an Improve question, your improved market sits on top of its instrument's book.
function viewBook(q, key) {
  const b = q.books[key];
  const u = DRILL_CTX ? DRILL_CTX.user : q.user;
  if (q.type !== 'improve' || !u || u.key !== key) return b;
  const lvl = { px: u.px, size: u.size, you: true };
  return u.side === 'bid'
    ? Object.assign({}, b, { bids: [lvl].concat(b.bids.slice(0, DRILL_LEVELS - 1)) })
    : Object.assign({}, b, { asks: [lvl].concat(b.asks.slice(0, DRILL_LEVELS - 1)) });
}

// The ladder: offers stacked above the divider's right side (worst on top), bids below on the left.
function ladderHtml(key, target) {
  const q = rq();
  // Make: nothing to tick. Improve: only once you've improved a market, and never on the market you improved.
  const withBtn = q.type !== 'make' && !DRILL_CTX && !(q.type === 'improve' && (q.phase !== 'legs' || (q.user && q.user.key === key)));
  const book = target ? { bids: [], asks: [] } : viewBook(q, key);
  let rows = '';
  for (let i = DRILL_LEVELS - 1; i >= 0; i--) {
    rows += `<tr><td class="half bid"></td><td class="mid"></td>${halfHtml(key, book, 'ask', i, withBtn, target && i === 0)}</tr>`;
  }
  for (let i = 0; i < DRILL_LEVELS; i++) {
    rows += `<tr>${halfHtml(key, book, 'bid', i, withBtn, target && i === 0)}<td class="mid"></td><td class="half ask"></td></tr>`;
  }
  return `<table class="ladder">${rows}</table>`;
}

function instrHtml(key) {
  const q = rq();
  const isTarget = q.type === 'make' && q.target === key;
  const hidden = q.type === 'make' && !isTarget && !q.books[key];
  const body = hidden ? `<div class="hid-box">—</div>` : ladderHtml(key, isTarget);
  return `<div class="instr${isTarget ? ' target' : ''}${hidden ? ' hidden-instr' : ''}">
    <div class="ih">${sheetHeader(key)}</div>${body}</div>`;
}

function bookBoardHtml() {
  const q = rq();
  const keys = sheetKeys();
  const rc = APP.drill.delta1 === 'stock'
    ? `<div class="rcchip"><b>R/C</b> ${APP.util.fmtSigned(q.rc)}</div>` : '';
  // six instruments (stock mode) don't fit in one row: stack two rows of three
  const rows = keys.length > 4 ? [keys.slice(0, 3), keys.slice(3)] : [keys];
  return `<div class="sheetwrap">${rc}${rows.map(r => `<div class="instr-row">${r.map(instrHtml).join('')}</div>`).join('')}</div>`;
}

const DRILL_TYPE_NAMES = { arb: 'Arbitrage Opportunity', make: 'Make a Market', improve: 'Improve a Market', single: 'Single Price' };

// "Improve a Market": the form to put in your improved market, or — once you have — the trade you were
// given and the legs left to do.
function improveFooterHtml(q, fb) {
  const keys = sheetKeys();
  const u = q.user;
  if (q.phase === 'legs') {
    const verb = u.side === 'bid' ? 'bought' : 'sold';
    return `<div class="imp-trade">You ${verb} <b>${u.size}</b> ${sheetHeaderFor(u.key, q.K)} at <b>${r2c(u.px)}</b>.</div>
      <div class="drill-hint">Now complete the arbitrage: tick the other prices to trade (you take each price's whole size). You can change your market first if you don't like it.</div>
      <div class="drill-actions"><button class="start-btn drill-btn" data-drill="make-trades">Make Trades</button>
      <button class="drill-btn gray" data-drill="improve-change">Change my market</button>
      <button class="drill-btn gray" data-drill="improve-skip">Skip</button></div>
      <div id="drillFeedback" class="drill-feedback">${fb}</div>`;
  }
  const pre = u || { key: '', side: 'bid', px: '', size: '' };
  const opts = keys.map(k => `<option value="${k}" ${pre.key === k ? 'selected' : ''}>${sheetHeaderFor(k, q.K)}</option>`).join('');
  return `<div class="drill-hint">Improve one market — put in a better bid or offer, in a size — so that, trading against the others (a large order can always be hedged against), you'd have an arbitrage. You'll be given the trade.</div>
    <div class="imp-form">
      <select id="impKey">${opts}</select>
      <select id="impSide"><option value="bid" ${pre.side === 'bid' ? 'selected' : ''}>Bid</option><option value="ask" ${pre.side === 'ask' ? 'selected' : ''}>Offer</option></select>
      <input id="impPx" type="number" step="${dtick()}" placeholder="Price" autocomplete="off" value="${pre.px}">
      <input id="impSize" type="number" step="1" min="1" placeholder="Size (lots)" autocomplete="off" value="${pre.size}">
      <button class="start-btn drill-btn" data-drill="improve">Improve market</button>
      ${u ? '<button class="drill-btn gray" data-drill="improve-cancel">Keep my market</button>' : '<button class="drill-btn gray" data-drill="improve-skip">Skip</button>'}
    </div><div id="drillFeedback" class="drill-feedback">${fb}</div>`;
}

function renderDrillQuestion(keepFeedback) {
  const q = APP.drill.question;
  const board = document.getElementById('drillBoard');
  const footer = document.getElementById('drillFooter');
  const fb = keepFeedback ? (document.getElementById('drillFeedback') || {}).innerHTML || '' : '';
  document.getElementById('drillTypeBox').textContent = DRILL_TYPE_NAMES[q.type];
  if (q.type === 'single') {
    board.innerHTML = singleBoardHtml();
    footer.innerHTML = `<input type="text" id="drillAnswer" inputmode="decimal" autocomplete="off" placeholder="Type the answer…">`;
    document.getElementById('drillAnswer').focus();
  } else if (q.type === 'make') {
    board.innerHTML = bookBoardHtml();
    footer.innerHTML = `<div class="drill-hint">Make a two-way market in the highlighted ${drillName(q.target)} from the two books shown — then press Enter.</div>
      <button class="start-btn drill-btn" data-drill="submit-make">Submit market</button><div id="drillFeedback" class="drill-feedback">${fb}</div>`;
    document.getElementById('mkBid').focus();
  } else if (q.type === 'arb') {
    board.innerHTML = bookBoardHtml();
    footer.innerHTML = `<div class="drill-hint">Tick the prices that make an arbitrage (you take each price's whole size), or call it.</div>
      <div class="drill-actions"><button class="start-btn drill-btn" data-drill="make-trades">Make Trades</button>
      <button class="drill-btn gray" data-drill="no-arb">No Arbitrage</button></div><div id="drillFeedback" class="drill-feedback">${fb}</div>`;
  } else { // improve
    board.innerHTML = bookBoardHtml();
    footer.innerHTML = improveFooterHtml(q, fb);
    const first = document.getElementById('impPx');
    if (first && q.phase === 'quote') first.focus();
  }
}

// ---- order-book drill: answering ---------------------------------------------------

function setDrillFeedback(text, good) {
  const el = document.getElementById('drillFeedback');
  if (el) el.innerHTML = `<span class="${good ? 'fb-good' : 'fb-bad'}">${text}</span>`;
}

// info is what the player did, kept for Explain Last Answer.
function addDrillScore(pts, info) {
  APP.drill.pending = Object.assign({ pts }, info || {});
  APP.drill.score += pts;
  document.getElementById('drillScoreVal').textContent = String(APP.drill.score);
}

// 2 points max: 1 if the fair midpoint sits inside your market (at most 1.00 wide), 2 if you have
// exactly the right bid and offer (the best market the other books allow).
function scoreMakeAnswer(q, bid, ask) {
  const fair = q.best.fair;
  if (ask - bid > 1 + 1e-9 || bid > fair + 1e-9 || ask < fair - 1e-9) return 0;
  const bidOK = Math.abs(bid - q.best.bid) < 1e-6, askOK = Math.abs(ask - q.best.ask) < 1e-6;
  return (bidOK && askOK) ? 2 : 1;
}

function submitMakeAnswer() {
  const q = APP.drill.question;
  if (!q || q.type !== 'make') return;
  const bid = parseFloat(document.getElementById('mkBid').value);
  const ask = parseFloat(document.getElementById('mkAsk').value);
  if (isNaN(bid) || isNaN(ask) || !(ask > bid)) { setDrillFeedback('Enter a bid and a higher offer.', false); return; }
  const pts = scoreMakeAnswer(q, bid, ask);
  if (pts === 0) { // the fair midpoint isn't inside the market (or it's more than 1.00 wide): try again
    document.getElementById('mkBid').value = '';
    document.getElementById('mkAsk').value = '';
    document.getElementById('mkBid').focus();
    setDrillFeedback(ask - bid > 1 + 1e-9 ? 'That market is too wide — try again.' : "The midpoint isn't inside your market — try again.", false);
    return;
  }
  addDrillScore(pts, { bid, ask });
  const correct = `${r2c(q.best.bid)} / ${r2c(q.best.ask)}`;
  nextDrillQuestion();
  setDrillFeedback(pts === 2 ? `+2 — spot on (${correct})` : `+${pts} — the best market was ${correct}`, pts === 2);
}

function toggleDrillPick(name, side, level) {
  const key = `${name}:${side}:${level}`;
  if (APP.drill.sel[key]) delete APP.drill.sel[key]; else APP.drill.sel[key] = 1;
  renderDrillQuestion(true);
}

function drillTakeWrong(msg) {
  APP.drill.sel = {};
  renderDrillQuestion(false);
  setDrillFeedback(msg, false);
}

function describeLeg(l) { return `${l.side === 'buy' ? 'buy' : 'sell'} ${sheetHeader(l.name)}`; }

function submitMakeTrades() {
  const q = APP.drill.question;
  if (!q || (q.type !== 'arb' && q.type !== 'improve')) return;
  const legs = Object.keys(APP.drill.sel).map(k => { const [name, side, level] = k.split(':'); return { name, side, level: parseInt(level, 10) }; });
  if (!legs.length) { setDrillFeedback('Tick the prices you want to trade first.', false); return; }

  if (q.type === 'improve') { improveMakeTrades(q, legs); return; }

  const pkg = legs.every(l => l.level === 0) ? matchArbLegSet(legs, q.arbs) : null; // an arbitrage lives at the best prices
  if (!pkg) { drillTakeWrong('Not an arbitrage — selections cleared, try again.'); return; }
  const best = pkg.profit >= q.arbs[0].profit - 1e-9;
  addDrillScore(best ? 2 : 1, { legs, pkg });
  nextDrillQuestion();
  setDrillFeedback(best ? `+2 — the best arbitrage (${r2c(pkg.profit)})` : `+1 — an arbitrage, but the best was ${r2c(q.arbs[0].profit)}`, best);
}

// ---- Improve a Market: answering ------------------------------------------------------------
// Four points: improving a correct market (first try), getting the price inside the arb-able band (first
// try), making the market as competitive as it can be in the right size while still leaving an arbitrage
// (your final market), and completing the other legs (first try). You're given the trade whatever you
// put in, and can change your market any time before you finish — you're never corrected, only told what
// the books said when it matters.

function improveForm() {
  const v = (id) => document.getElementById(id);
  return { key: v('impKey').value, side: v('impSide').value, px: parseFloat(v('impPx').value), size: parseInt(v('impSize').value, 10) };
}

function submitImprove() {
  const q = APP.drill.question;
  if (!q || q.type !== 'improve') return;
  const f = improveForm();
  const t = dtick(), b = q.books[f.key];
  if (isNaN(f.px)) { setDrillFeedback('Enter a price.', false); return; }
  if (Math.abs(f.px / t - Math.round(f.px / t)) > 1e-6) { setDrillFeedback(`Prices move in steps of ${t}.`, false); return; }
  if (!Number.isInteger(f.size) || f.size <= 0) { setDrillFeedback('Enter a size, in lots.', false); return; }
  const px = r2(f.px);
  if (f.side === 'bid') {
    if (px <= b.bid + 1e-9) { setDrillFeedback(`That doesn't improve the market — the best bid is ${r2c(b.bid)}.`, false); return; }
    if (px >= b.ask - 1e-9) { setDrillFeedback(`That crosses the market — the best offer is ${r2c(b.ask)}.`, false); return; }
  } else {
    if (px >= b.ask - 1e-9) { setDrillFeedback(`That doesn't improve the market — the best offer is ${r2c(b.ask)}.`, false); return; }
    if (px <= b.bid + 1e-9) { setDrillFeedback(`That crosses the market — the best bid is ${r2c(b.bid)}.`, false); return; }
  }
  q.user = { key: f.key, side: f.side, px, size: f.size };
  q.history.push(Object.assign({}, q.user));
  if (!q.first) { // what counts for "first try"
    const tg = q.targets.find(o => o.key === f.key && o.side === f.side);
    q.first = { key: f.key, side: f.side, px, size: f.size, correctMarket: !!tg, inBand: !!tg && (f.side === 'bid' ? px <= tg.limit + 1e-9 : px >= tg.limit - 1e-9) };
  }
  q.phase = 'legs';
  APP.drill.sel = {};
  renderDrillQuestion(false);
}

function improveScoring(q, completed, firstTry) {
  const f = q.first, u = q.user;
  const p1 = !!(f && f.correctMarket);
  const p2 = p1 && f.inBand;
  let p3 = false;
  if (u) { const tg = q.targets.find(o => o.key === u.key && o.side === u.side); p3 = !!tg && Math.abs(u.px - tg.limit) < 1e-9 && u.size === tg.size; }
  const p4 = !!(completed && firstTry);
  return { p1, p2, p3, p4, total: (p1 ? 1 : 0) + (p2 ? 1 : 0) + (p3 ? 1 : 0) + (p4 ? 1 : 0) };
}

function improveFeedback(q, sc, completed) {
  const mark = (ok, text) => `${ok ? '✓' : '✗'} ${text}`;
  const tg = q.targets.find(o => q.user && o.key === q.user.key && o.side === q.user.side) || q.intended;
  const best = `${tg.side === 'bid' ? 'a bid' : 'an offer'} of ${r2c(tg.limit)} in ${tg.size} ${sheetHeaderFor(tg.key, q.K)}`;
  return `+${sc.total} — ${mark(sc.p1, 'improved a good market')} · ${mark(sc.p2, 'price in the arb-able band')} · ${mark(sc.p3, 'most competitive, in the right size')} · ${mark(sc.p4, 'legs first try')}`
    + (sc.p3 ? '' : ` (the most competitive was ${best})`);
}

function finishImprove(q, completed, firstTry) {
  const sc = improveScoring(q, completed, firstTry);
  const msg = improveFeedback(q, sc, completed);
  addDrillScore(sc.total, { improve: { sc, first: q.first, user: q.user ? Object.assign({}, q.user) : null, history: q.history.slice(), completed, skipped: !completed } });
  nextDrillQuestion();
  setDrillFeedback(completed ? msg : `Skipped. ${msg}`, sc.total >= 3);
}

function improveMakeTrades(q, legs) {
  const u = q.user;
  if (!u || q.phase !== 'legs') return;
  q.attempts += 1;
  const firstTry = q.attempts === 1;
  const arbs = improveArbs(q, u);
  if (!arbs.length) { // the market you made doesn't leave an arbitrage: say what the books said, and let them change it
    const imp = bestMarketFromOthers(arbVectors(APP.drill.delta1, q.K, q.rc), u.key, booksToQuotes(q.books, u.key));
    const name = sheetHeaderFor(u.key, q.K);
    drillTakeWrong(u.side === 'bid'
      ? `There's no arbitrage at a bid of ${r2c(u.px)}: the other books only pay ${r2c(imp.bid)} for the equivalent of a ${name}, so buying it at ${r2c(u.px)} can't be hedged for a profit. Change your market (or skip).`
      : `There's no arbitrage at an offer of ${r2c(u.px)}: the other books charge ${r2c(imp.ask)} for the equivalent of a ${name}, so selling it at ${r2c(u.px)} can't be hedged for a profit. Change your market (or skip).`);
    return;
  }
  const mine = { name: u.key, side: u.side === 'bid' ? 'buy' : 'sell' };
  const pkg = legs.every(l => l.level === 0 && l.name !== u.key) ? matchArbLegSet(legs.concat(mine), arbs) : null;
  if (!pkg) { drillTakeWrong('Those prices don\'t complete an arbitrage with your market — selections cleared, try again.'); return; }
  finishImprove(q, true, firstTry);
}

// Pulling the market back to change it (nothing is corrected: the trade just re-prices when you re-submit).
function improveChange() {
  const q = APP.drill.question;
  if (!q || q.type !== 'improve' || !q.user) return;
  q.phase = 'quote';
  APP.drill.sel = {};
  renderDrillQuestion(false);
}
function improveKeep() {
  const q = APP.drill.question;
  if (!q || q.type !== 'improve' || !q.user) return;
  q.phase = 'legs';
  renderDrillQuestion(false);
}
function improveSkip() {
  const q = APP.drill.question;
  if (!q || q.type !== 'improve') return;
  finishImprove(q, false, false);
}

function submitNoArb() {
  const q = APP.drill.question;
  if (!q || q.type !== 'arb') return;
  if (q.arbs.length) { drillTakeWrong('There was an arbitrage on the screen — selections cleared.'); return; }
  addDrillScore(2, { none: true });
  nextDrillQuestion();
  setDrillFeedback('+2 — correct, no arbitrage', true);
}

// ---- drill session lifecycle --------------------------------------------------

APP.drill = {
  score: 0,
  totalSec: 120,
  remainingSec: 120,
  question: null,
  timerId: null,
  bags: {},
  sel: {},
  delta1: 'future',
  view: 'book',
  types: { arb: true, improve: true },
  tick: 0.05,     // the drill's price tick, copied from the config at the start
  pending: null,  // what the player just did (set by addDrillScore) ...
  last: null,     // ... kept with its question as {q, ans} for Explain Last Answer
  paused: false,  // true while the explanation is open: the timer is stopped
};

function nextDrillQuestion() {
  APP.drill.sel = {};
  if (APP.drill.question && APP.drill.pending) APP.drill.last = { q: APP.drill.question, ans: APP.drill.pending };
  APP.drill.pending = null;
  if (APP.drill.view === 'single') {
    APP.drill.question = generateSingleQuestion();
  } else {
    // make-a-market is always in the mix; arbitrage / improve-a-market only if switched on in the config
    const mix = ['make', 'make'];
    if (APP.drill.types.arb) mix.push('arb', 'arb');
    if (APP.drill.types.improve) mix.push('improve', 'improve');
    const type = nextFromBag('type', mix);
    APP.drill.question = (type === 'make' ? generateMakeQuestion() : (type === 'arb' ? generateArbQuestion() : generateImproveQuestion())) || generateMakeQuestion();
  }
  renderDrillQuestion(false);
  updateExplainButton();
}

function drillTick() {
  if (APP.drill.paused) return;
  APP.drill.remainingSec -= 1;
  if (APP.drill.remainingSec <= 0) {
    APP.drill.remainingSec = 0;
    updateDrillTimerDisplay();
    endDrill();
    return;
  }
  updateDrillTimerDisplay();
  APP.drill.timerId = setTimeout(drillTick, 1000);
}

function updateDrillTimerDisplay() {
  const mm = Math.floor(APP.drill.remainingSec / 60), ss = APP.drill.remainingSec % 60;
  document.getElementById('drillTimer').textContent = `${mm}:${ss.toString().padStart(2, '0')}`;
}

function startDrill() {
  APP.drill.delta1 = APP.drillConfig.delta1;
  APP.drill.view = APP.drillConfig.view;
  APP.drill.tick = [0.01, 0.05, 0.1].includes(APP.drillConfig.tick) ? APP.drillConfig.tick : 0.05;
  APP.drill.types = Object.assign({}, APP.drillConfig.types);
  APP.drill.score = 0;
  APP.drill.totalSec = APP.drillConfig.minutes * 60;
  APP.drill.remainingSec = APP.drill.totalSec;
  APP.drill.bags = {};
  APP.drill.question = null; APP.drill.pending = null; APP.drill.last = null; APP.drill.paused = false;
  closeExplain(true);
  document.getElementById('drillScoreVal').textContent = '0';
  updateDrillTimerDisplay();
  nextDrillQuestion();
  if (APP.drill.timerId) clearTimeout(APP.drill.timerId);
  APP.drill.timerId = setTimeout(drillTick, 1000);
}

function endDrill() {
  if (APP.drill.timerId) { clearTimeout(APP.drill.timerId); APP.drill.timerId = null; }
  closeExplain(true);
  document.getElementById('drillFinalScore').textContent = `Score: ${APP.drill.score}`;
  showScreen('drillResults');
}

function bindDrillEvents() {
  const screen = document.getElementById('drillScreen');
  screen.addEventListener('input', (e) => { if (e.target.id === 'drillAnswer') handleDrillAnswerInput(e); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && APP.drill.paused) closeExplain(); });
  screen.addEventListener('keydown', (e) => {
    if (APP.drill.paused) return;
    if (e.key === 'Enter' && (e.target.id === 'mkBid' || e.target.id === 'mkAsk')) {
      if (e.target.id === 'mkBid' && !document.getElementById('mkAsk').value) document.getElementById('mkAsk').focus();
      else submitMakeAnswer();
    }
    if (e.key === 'Enter' && (e.target.id === 'impPx' || e.target.id === 'impSize')) {
      if (e.target.id === 'impPx' && !document.getElementById('impSize').value) document.getElementById('impSize').focus();
      else submitImprove();
    }
  });
  // (on the whole app: the Explain button and its overlay sit outside the drill screen)
  document.getElementById('app').addEventListener('click', (e) => {
    const t = e.target.closest('[data-drill]');
    if (!t) return;
    const a = t.dataset.drill;
    if (a === 'explain') { openExplain(); return; }
    if (a === 'close-explain') { closeExplain(); return; }
    if (APP.drill.paused) return;
    if (a === 'pick') toggleDrillPick(t.dataset.name, t.dataset.side, parseInt(t.dataset.level, 10));
    else if (a === 'make-trades') submitMakeTrades();
    else if (a === 'no-arb') submitNoArb();
    else if (a === 'improve') submitImprove();
    else if (a === 'improve-change') improveChange();
    else if (a === 'improve-cancel') improveKeep();
    else if (a === 'improve-skip') improveSkip();
    else if (a === 'submit-make') submitMakeAnswer();
  });
}
