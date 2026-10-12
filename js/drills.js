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
// Three drill flavours, per delta-1 mode (future | stock):
//   single price : one price is missing — work it out and type it (the original drill)
//   order book   : every instrument shows a 2-level book, and the questions alternate between
//     make   — one instrument's book is blank: enter a two-way market (scored vs. the best
//              market its replication from the other books allows), and
//     take   — every book is filled: hit the prices that form an arbitrage, or call "no arbitrage".

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

  const D = Math.round((callTrue - putTrue) * 10) / 10; // multiple of 0.1 (so C,P land on 0.05)
  let T = Math.round((callTrue + putTrue) * 10) / 10;   // multiple of 0.1
  if (T <= Math.abs(D) + 0.1) T = Math.abs(D) + 0.5;    // guard against a rounded-away straddle

  const rc = future ? 0 : Math.round((spotSeed * (Math.exp((r - q) * yrs) - 1)) * 20) / 20; // multiple of 0.05

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
  if (!q || q.type !== 'single') return;
  const val = parseFloat(e.target.value);
  if (isNaN(val)) return;
  if (Math.abs(val - q.answer) < 0.005) {
    addDrillScore(1);
    nextDrillQuestion();
  }
}

// ---- order-book drill: question generation --------------------------------------
//
// Three question types, each on a row of 3-level order books (sizes shown, bars proportional):
//   arb  (Arbitrage Opportunity) — tick the legs of the riskless trade, or call "No Arbitrage"
//   make (Make a Market)         — only two other instruments are shown; quote the blank one
//   take (Take Liquidity)        — one or a few thin quotes are off fair value; take just those legs
// Every price is taken in its entirety, so quantities/ratios never come into it. Only the best
// price on each side counts toward an arbitrage or a "correct leg" — deeper levels are depth.

const DRILL_LEVELS = 3;

// Typical size of a *good* best price per instrument; a bar is full at double the typical size
// (a straddle is worth about two options, so it's quoted at half the size).
function typicalSize(key) { return key === 'straddle' ? 100 : 200; }
function maxSize(key) { return 2 * typicalSize(key); }
function normalSize(key) { return Math.max(10, Math.round(typicalSize(key) * APP.util.rand(0.45, 1.1) / 10) * 10); }
// A stray quote is only somewhat smaller than a normal one — size is a strong hint, not a giveaway.
function thinSize(key) { return Math.max(5, Math.round(typicalSize(key) * APP.util.rand(0.33, 0.72) / 5) * 5); }
const shuffled = (arr) => arr.slice().sort(() => Math.random() - 0.5);

// Levels behind a best price: each a tick or two worse, and bigger than the one in front.
function deepen(px, size, dir, key) {
  const levels = [{ px: r2(px), size }];
  for (let i = 1; i < DRILL_LEVELS; i++) {
    const prev = levels[i - 1];
    levels.push({
      px: r2(prev.px + dir * 0.05 * APP.util.choice([1, 1, 2])),
      size: Math.min(maxSize(key), Math.round(prev.size * APP.util.rand(1.3, 2.0) / 5) * 5),
    });
  }
  return levels;
}

// A book from its best bid/offer (sizes optional). bid/ask/bidSize/askSize always mirror level 1.
function buildBook(bid, ask, key, bidSize, askSize) {
  const bs = bidSize != null ? bidSize : normalSize(key), as = askSize != null ? askSize : normalSize(key);
  return { bid: r2(bid), ask: r2(ask), bidSize: bs, askSize: as, bids: deepen(bid, bs, -1, key), asks: deepen(ask, as, +1, key) };
}

// A market around `mid`. Odd-tick widths sit a half-tick off-centre (both prices stay on the 0.05
// grid), so the displayed midpoint is sometimes not the fair value exactly — as in life.
function makeBook(mid, key) {
  const n = APP.util.choice([1, 2, 3, 4]); // total width in ticks: 0.05 .. 0.20
  const bidSteps = n % 2 === 0 ? n / 2 : (Math.random() < 0.5 ? (n - 1) / 2 : (n + 1) / 2);
  const bid = r2(mid - bidSteps * 0.05);
  return buildBook(bid, bid + n * 0.05, key);
}

function booksToQuotes(books, skip) {
  const quotes = {};
  Object.keys(books).forEach(k => { if (k !== skip && books[k]) quotes[k] = { bid: books[k].bid, ask: books[k].ask }; });
  return quotes;
}

// Make a Market: show just two instruments from different families (enough to work the answer out).
function generateMakeQuestion() {
  for (let tries = 0; tries < 200; tries++) {
    const base = drillBase();
    const keys = drillBookKeys();
    const target = nextFromBag('make', keys);
    const others = Object.keys(drillFamilies()).filter(f => f !== drillFamilyOf(target));
    const givens = pickTwoFamilyGivens(others);
    const books = {};
    givens.forEach(k => { books[k] = makeBook(base.values[k], k); });
    const vecs = arbVectors(APP.drill.delta1, base.K, base.rc);
    const best = bestMarketFromOthers(vecs, target, booksToQuotes(books));
    if (best.bid == null || best.ask == null || best.ask - best.bid < 0.05 - 1e-9) continue;
    // you'd always buy an option for nothing, so an option's best bid is never below 0
    const isOption = target === 'call' || target === 'put' || target === 'straddle';
    let bestBid = r2(APP.util.floor5c(best.bid));
    if (isOption && bestBid < 0) bestBid = 0;
    const bestAsk = r2(APP.util.ceil5c(best.ask));
    if (bestAsk <= bestBid) continue;
    return {
      type: 'make', K: base.K, rc: base.rc, books, target, givens,
      best: { bid: bestBid, ask: bestAsk, fair: (best.bid + best.ask) / 2 },
    };
  }
  return generateMakeQuestion();
}

// Pushes one instrument's book off-market so it can be arbitraged against the replication from the
// other books: bid above what the rest can sell it for, or offer below what the rest can buy it for.
function shiftBookIntoArb(key, books, vecs) {
  const best = bestMarketFromOthers(vecs, key, booksToQuotes(books, key));
  const e = APP.util.choice([0.05, 0.05, 0.10, 0.10, 0.15, 0.20]);
  const n = APP.util.choice([1, 2, 3, 4]);
  const wantBid = Math.random() < 0.5;
  if (wantBid && best.ask != null) {
    let bid = APP.util.ceil5c(best.ask + e);
    if (bid <= best.ask + 1e-9) bid += 0.05;
    books[key] = buildBook(bid, bid + n * 0.05, key);
  } else if (best.bid != null) {
    let ask = APP.util.floor5c(best.bid - e);
    if (ask >= best.bid - 1e-9) ask -= 0.05;
    books[key] = buildBook(ask - n * 0.05, ask, key);
  }
}

// Arbitrage Opportunity: 80% of the time there's a riskless trade on the screen (at most 0.3).
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
    // option/future prices must stay positive (P+S and B/W are strike-relative and may be negative)
    if (keys.some(k => k !== 'ps' && k !== 'bw' && books[k].bids[DRILL_LEVELS - 1].px <= 0)) continue;
    const arbs = findArbs(vecs, booksToQuotes(books));
    if (wantArb ? (arbs.length > 0 && arbs[0].profit <= 0.3 + 1e-9) : arbs.length === 0) {
      return { type: 'arb', K: base.K, rc: base.rc, books, arbs };
    }
  }
  return generateArbQuestion();
}

// Moves one leg off fair value: a stray quote in front of the book, with the normal book behind it.
function shiftLegOffFair(books, values, leg, comparableSize) {
  const key = leg.name, fair = values[key];
  const e = APP.util.choice([0.05, 0.10, 0.15, 0.20]);   // the edge you'd capture
  const w = APP.util.choice([0.05, 0.10, 0.15]);         // how far the rest of that book sits from the stray
  const strayLen = () => comparableSize ? normalSize(key) : thinSize(key); // print questions give no size clue
  const behind = (px, dir) => deepen(px, normalSize(key), dir, key); // the normal book resumes behind the stray
  if (leg.side === 'buy') {
    const stray = r2(fair - e);
    const normalAsk = r2(fair + APP.util.choice([0.05, 0.10]));
    books[key] = {
      bid: r2(stray - w), ask: stray,
      bids: behind(stray - w, -1),
      asks: [{ px: stray, size: strayLen() }].concat(behind(normalAsk, +1).slice(0, DRILL_LEVELS - 1)),
    };
  } else {
    const stray = r2(fair + e);
    const normalBid = r2(fair - APP.util.choice([0.05, 0.10]));
    books[key] = {
      bid: stray, ask: r2(stray + w),
      bids: [{ px: stray, size: strayLen() }].concat(behind(normalBid, -1).slice(0, DRILL_LEVELS - 1)),
      asks: behind(stray + w, +1),
    };
  }
  books[key].bidSize = books[key].bids[0].size;
  books[key].askSize = books[key].asks[0].size;
}

// Every price (any level) whose edge against fair value is positive.
function positiveEdgeLegs(books, values) {
  const legs = [];
  Object.keys(books).forEach(k => {
    books[k].asks.forEach((l, i) => { if (values[k] - l.px > 1e-9) legs.push({ name: k, side: 'buy', level: i }); });
    books[k].bids.forEach((l, i) => { if (l.px - values[k] > 1e-9) legs.push({ name: k, side: 'sell', level: i }); });
  });
  return legs;
}
const legKey = (l) => `${l.name}:${l.side}:${l.level || 0}`;

// ---- is a Take Liquidity question actually answerable? ------------------------------
// A careful reader looks for a fair value (a point in the put-call-parity family); any book that
// doesn't bracket it is a stray, and the leg to take is whichever side of the stray sits beyond
// that fair value. Each plausible fair value on a fine grid gives one such "reading". Three kinds
// of evidence choose between readings:
//   prices  — exactly one reading with the fewest strays
//   sizes   — the true strays are clearly thinner than any other reading's (trade the smaller legs)
//   a print — a big trade inside X's market pins X's fair value (see generateLiquidityQuestion)
function drillFairAt(k, D, T, base) {
  const d = DRILL_DEF[k];
  return d.a * D + d.b * T + drillConst(k, base.K, base.rc);
}

function allStrayReadings(base, books, keys, pin) {
  const found = {};
  for (let i = -20; i <= 20; i++) {
    for (let j = -20; j <= 20; j++) {
      const D = base.D + i * 0.05, T = base.T + j * 0.05;
      if (T <= Math.abs(D)) continue; // a straddle can't be worth less than |call - put|
      if (pin && Math.abs(drillFairAt(pin.name, D, T, base) - pin.px) > 1e-6) continue;
      const legs = [];
      for (const k of keys) {
        const f = drillFairAt(k, D, T, base), b = books[k];
        if (f > b.ask + 1e-9) legs.push(`${k}:buy:0`);
        else if (f < b.bid - 1e-9) legs.push(`${k}:sell:0`);
      }
      legs.sort();
      found[legs.join('|')] = legs;
    }
  }
  return Object.values(found);
}

function l1Size(books, legStr) {
  const [k, side] = legStr.split(':');
  return side === 'buy' ? books[k].asks[0].size : books[k].bids[0].size;
}
// how big a reading's stray quotes are on average, relative to a typical quote in each instrument
function readingCost(books, legs) {
  if (!legs.length) return 0;
  return legs.reduce((s, x) => s + l1Size(books, x) / typicalSize(x.split(':')[0]), 0) / legs.length;
}
function fewestStrays(readings) {
  const m = Math.min(...readings.map(r => r.length));
  return readings.filter(r => r.length === m);
}

// basis: 'price' — the stray quotes are normally sized, so only prices can find them; 'size' — prices
// alone are ambiguous and the stray quotes are noticeably thinner; null — either will do.
function takeQuestionIsFair(base, books, keys, trueLegs, pin, basis) {
  const margin = trueLegs.length > 1 ? 1.0 : 0.92;
  const trueStr = trueLegs.map(l => `${l.name}:${l.side}:0`).sort().join('|');
  const same = (c) => c.slice().sort().join('|') === trueStr;
  const all = allStrayReadings(base, books, keys, null);
  const priceSettles = () => { const f = fewestStrays(all); return f.length === 1 && same(f[0]); };
  const sizeSettles = () => {
    const t = readingCost(books, trueLegs.map(l => `${l.name}:${l.side}:0`));
    return all.some(same) && all.every(c => same(c) || t < margin * readingCost(books, c));
  };
  const plainOk = priceSettles() || sizeSettles();
  if (!pin) return basis === 'price' ? priceSettles() : (basis === 'size' ? sizeSettles() : plainOk);
  // a print question: sizes are no help and prices alone are ambiguous — the print has to settle it
  if (plainOk) return false;
  const pinned = fewestStrays(allStrayReadings(base, books, keys, pin));
  return pinned.length === 1 && same(pinned[0]);
}

// Take Liquidity. Every book sits around fair value with healthy size, except the correct legs,
// where a stray quote sits in front of the book at an off-fair price (a cheap offer to buy, or a
// rich bid to sell); trading anything else gives away edge. Mix: 10% nothing worth taking; the rest
// 70% one right leg, otherwise two or three (e.g. buy the cheap calls AND sell the rich puts). About
// half of all questions carry news of a recent trade (see makePrint below). Stray quotes are only
// somewhat thinner than normal ones.
//
// attemptLiquidity makes ONE candidate question and returns it only if it's provably answerable
// (see takeQuestionIsFair); the driver below retries within a fixed budget, stepping down to fewer
// legs if a hard combination (e.g. three strays among futures' four instruments) won't come together.
function attemptLiquidity(mode, n, basis, relax, decorKind) {
  const base = drillBase();
  const keys = drillBookKeys();
  const vecs = arbVectors(APP.drill.delta1, base.K, base.rc);
  const books = {};
  keys.forEach(k => { // fair sits inside every book
    books[k] = buildBook(base.values[k] - APP.util.choice([0.05, 0.10]), base.values[k] + APP.util.choice([0.05, 0.10]), k);
  });
  let legs = [];
  if (n > 0) {
    if (n === 1) {
      legs = [{ name: APP.util.choice(keys), side: APP.util.choice(['buy', 'sell']) }];
    } else {
      const pkgs = candidatePackages(vecs, keys).filter(p => p.legs.length >= n);
      if (!pkgs.length) return null;
      legs = shuffled(APP.util.choice(pkgs).legs).slice(0, n);
    }
    legs.forEach(l => shiftLegOffFair(books, base.values, l, mode === 'print' || basis === 'price'));
  }
  if (keys.some(k => k !== 'ps' && k !== 'bw' && books[k].bids[DRILL_LEVELS - 1].px <= 0)) return null;
  const correct = positiveEdgeLegs(books, base.values);
  if (correct.length !== legs.length || !legs.every(l => correct.some(c => c.name === l.name && c.side === l.side && c.level === 0))) return null;

  // News: "a customer just traded a clip of Z at a price inside Z's market" (inside, or you could simply
  // replicate their trade). Z is never one of the stray quotes. Two kinds, because the size of the clip is
  // what tells you how much to believe it:
  //   big   — massive (5-10x a typical quote): the price is Z's true value, a reliable anchor
  //   small — about the size of the books themselves: just some price inside Z's market, so it's noise to
  //           be discounted, and it often points the wrong way
  const makePrint = (kind) => {
    const fine = keys.filter(k => !legs.some(l => l.name === k));
    if (!fine.length) return null;
    const z = APP.util.choice(fine);
    const fair = base.values[z], b = books[z];
    let px = fair, size;
    if (kind === 'big') {
      size = Math.round(typicalSize(z) * APP.util.choice([5, 6, 8, 10]) / 100) * 100;
    } else {
      size = Math.max(10, Math.round(typicalSize(z) * APP.util.rand(0.5, 1.5) / 10) * 10);
      const alts = [];
      for (let p = r2(b.bid + 0.05); p < b.ask - 1e-9; p = r2(p + 0.05)) if (Math.abs(p - fair) > 1e-6) alts.push(p);
      if (alts.length) px = APP.util.choice(alts);
    }
    const what = z === 'stock' ? drillName('stock') : `of the ${sheetHeaderFor(z, base.K)}`;
    return { pin: { name: z, px }, text: `Customer ${Math.random() < 0.5 ? 'bought' : 'sold'} ${size} ${what} for ${r2c(px)}` };
  };
  let alert = null, pin = null;
  if (mode === 'print') { // a massive one that's needed to settle the question
    const p = makePrint('big');
    if (!p) return null;
    pin = p.pin; alert = p.text;
  }
  if (!relax && !takeQuestionIsFair(base, books, keys, correct, pin, basis)) return null;
  if (!alert && decorKind === 'big') { // massive and consistent with the right answer — it confirms the anchor
    const p = makePrint('big');
    if (p) alert = p.text;
  } else if (!alert && decorKind === 'small') { // small: worth including only if it could really mislead
    const p = makePrint('small');
    if (!p) return null;
    const trueStr = correct.map(l => `${l.name}:${l.side}:0`).sort().join('|');
    const pinned = fewestStrays(allStrayReadings(base, books, keys, p.pin));
    const misleads = !(pinned.length === 1 && pinned[0].slice().sort().join('|') === trueStr);
    if (!misleads && Math.random() < 0.7) return null; // mostly retry until we find a real decoy
    alert = p.text;
  }
  return { type: 'take', K: base.K, rc: base.rc, books, correct, alert };
}

function generateLiquidityQuestion(forceMode) {
  const r = Math.random();
  const mode = forceMode || (r < 0.10 ? 'none' : (Math.random() < 0.25 ? 'print' : 'plain'));
  // how many right legs: decided once, so hard cases aren't crowded out by easy ones on retry
  let n = mode === 'none' ? 0
    : mode === 'print' ? (Math.random() < 0.8 ? APP.util.choice([2, 3]) : 1)
    : (Math.random() < 0.7 ? 1 : (Math.random() < 0.6 ? 2 : 3));
  const BUDGET = 90; // attempts per stage — each is ~1ms, so the worst case is a fraction of a second
  // About half of all questions carry news, 75% of it massive and 25% small. The "needed" prints
  // (mode 'print', always massive) already make up ~22% of questions; the rest are added here, kind
  // decided once so a hard-to-find decoy can't quietly turn into a massive print.
  let decorKind = null;
  if (mode === 'none' || mode === 'plain') {
    const r = Math.random();
    decorKind = r < 0.175 ? 'big' : (r < 0.33 ? 'small' : null);
  }
  let m = mode, tried = 0;
  for (;;) {
    // half the single-leg plain questions can only be solved from prices (no size clue at all); the
    // rest, and every multi-leg one (where prices alone are ambiguous), lean on size
    const basis = m === 'plain' ? (n === 1 && Math.random() < 0.5 ? 'price' : 'size') : null;
    for (let i = 0; i < BUDGET; i++) {
      const q = attemptLiquidity(m, n, basis, false, decorKind);
      if (q) return q;
    }
    tried++;
    if (n > 1) { n--; continue; }               // step down: 3 legs -> 2 -> 1
    if (m === 'print') { m = 'plain'; n = 1; continue; }
    if (tried > 6) break;                        // (can't happen in practice)
    m = 'plain';
  }
  return attemptLiquidity('plain', 1, 'size', true, null) || generateLiquidityQuestion('plain'); // last resort: skip the check
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
function sheetHeader(key) { return sheetHeaderFor(key, APP.drill.question.K); }

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
    return `<td class="half ${cls} has target"><input id="${side === 'bid' ? 'mkBid' : 'mkAsk'}" type="number" step="0.05" placeholder="${side === 'bid' ? 'Bid' : 'Ask'}" autocomplete="off"></td>`;
  }
  if (!lv) return `<td class="half ${cls}"></td>`;
  const sz = `<span class="sz">(x${lv.size})</span>`, px = `<span class="px">${r2c(lv.px)}</span>`;
  const btn = withBtn ? pickBtnHtml(key, side === 'bid' ? 'sell' : 'buy', level) : '';
  const inner = side === 'bid' ? sz + px + btn : btn + px + sz;
  return `<td class="half ${cls} has${level === 0 ? ' best' : ''}" style="${barStyle(key, lv.size, side)}"><div class="hr">${inner}</div></td>`;
}

// The ladder: offers stacked above the divider's right side (worst on top), bids below on the left.
function ladderHtml(key, target) {
  const q = APP.drill.question;
  const withBtn = q.type !== 'make';
  const book = target ? { bids: [], asks: [] } : q.books[key];
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
  const q = APP.drill.question;
  const isTarget = q.type === 'make' && q.target === key;
  const hidden = q.type === 'make' && !isTarget && !q.books[key];
  const body = hidden ? `<div class="hid-box">—</div>` : ladderHtml(key, isTarget);
  return `<div class="instr${isTarget ? ' target' : ''}${hidden ? ' hidden-instr' : ''}">
    <div class="ih">${sheetHeader(key)}</div>${body}</div>`;
}

function bookBoardHtml() {
  const q = APP.drill.question;
  const keys = sheetKeys();
  const rc = APP.drill.delta1 === 'stock'
    ? `<div class="rcchip"><b>R/C</b> ${APP.util.fmtSigned(q.rc)}</div>` : '';
  // six instruments (stock mode) don't fit in one row: stack two rows of three
  const rows = keys.length > 4 ? [keys.slice(0, 3), keys.slice(3)] : [keys];
  return `<div class="sheetwrap">${rc}${rows.map(r => `<div class="instr-row">${r.map(instrHtml).join('')}</div>`).join('')}</div>`;
}

const DRILL_TYPE_NAMES = { arb: 'Arbitrage Opportunity', make: 'Make a Market', take: 'Take Liquidity', single: 'Single Price' };

function renderDrillQuestion(keepFeedback) {
  const q = APP.drill.question;
  const board = document.getElementById('drillBoard');
  const footer = document.getElementById('drillFooter');
  const fb = keepFeedback ? (document.getElementById('drillFeedback') || {}).innerHTML || '' : '';
  document.getElementById('drillTypeBox').textContent = DRILL_TYPE_NAMES[q.type];
  const alertEl = document.getElementById('drillAlert');
  alertEl.textContent = q.alert || '';
  alertEl.classList.toggle('hidden', !q.alert);
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
  } else {
    board.innerHTML = bookBoardHtml();
    footer.innerHTML = `<div class="drill-hint">Tick the best price(s) to take — you take each price's whole size — or call it if there's nothing worth taking.</div>
      <div class="drill-actions"><button class="start-btn drill-btn" data-drill="make-trades">Make Trades</button>
      <button class="drill-btn gray" data-drill="no-trade">Nothing to Take</button></div>
      <div id="drillFeedback" class="drill-feedback">${fb}</div>`;
  }
}

// ---- order-book drill: answering ---------------------------------------------------

function setDrillFeedback(text, good) {
  const el = document.getElementById('drillFeedback');
  if (el) el.innerHTML = `<span class="${good ? 'fb-good' : 'fb-bad'}">${text}</span>`;
}

function addDrillScore(pts) {
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
  addDrillScore(pts);
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
  if (!q || (q.type !== 'arb' && q.type !== 'take')) return;
  const legs = Object.keys(APP.drill.sel).map(k => { const [name, side, level] = k.split(':'); return { name, side, level: parseInt(level, 10) }; });
  if (!legs.length) { setDrillFeedback('Tick the prices you want to trade first.', false); return; }

  if (q.type === 'arb') {
    const pkg = legs.every(l => l.level === 0) ? matchArbLegSet(legs, q.arbs) : null; // an arbitrage lives at the best prices
    if (!pkg) { drillTakeWrong('Not an arbitrage — selections cleared, try again.'); return; }
    const best = pkg.profit >= q.arbs[0].profit - 1e-9;
    addDrillScore(best ? 2 : 1);
    nextDrillQuestion();
    setDrillFeedback(best ? `+2 — the best arbitrage (${r2c(pkg.profit)})` : `+1 — an arbitrage, but the best was ${r2c(q.arbs[0].profit)}`, best);
    return;
  }

  // Take Liquidity: every ticked price must be one of the good ones — or a best price that is one leg of a
  // riskless package in these books (e.g. the straddle bid, when the call and put offers cost less): it can
  // be hedged for a locked-in profit, so it's a fair trade even though it isn't the best one. 1 point.
  const stray = legs.filter(l => !q.correct.some(c => legKey(c) === legKey(l)));
  if (stray.length) {
    const arbs = findArbs(arbVectors(APP.drill.delta1, q.K, q.rc), booksToQuotes(q.books));
    // the package to quote: the one sharing the most legs with what was ticked and with the best trade
    const known = legs.concat(q.correct);
    const overlap = (p) => p.legs.filter(pl => known.some(l => l.name === pl.name && l.side === pl.side)).length;
    const pkgOf = (l) => l.level !== 0 ? null : arbs
      .filter(p => p.legs.some(pl => pl.name === l.name && pl.side === l.side))
      .sort((a, b) => overlap(b) - overlap(a) || a.legs.length - b.legs.length || b.profit - a.profit)[0] || null;
    const pkgs = stray.map(pkgOf);
    if (pkgs.every(Boolean)) {
      const msg = `+1 — ${stray.map(describeLeg).join(' and ')} can be hedged for a riskless ${r2c(pkgs[0].profit)} (${pkgs[0].legs.map(describeLeg).join(', ')}), though the best trade was to take: ${q.correct.map(describeLeg).join(' and ') || 'nothing'}`;
      addDrillScore(1);
      nextDrillQuestion();
      setDrillFeedback(msg, false);
      return;
    }
    drillTakeWrong('One of those prices gives away edge — selections cleared, try again.');
    return;
  }
  const missing = q.correct.filter(c => !legs.some(l => legKey(l) === legKey(c)));
  const msg = missing.length
    ? `+1 — a right leg, but the best trade also had: ${missing.map(describeLeg).join(' and ')}`
    : '+2 — you took all the right legs';
  addDrillScore(missing.length ? 1 : 2);
  nextDrillQuestion();
  setDrillFeedback(msg, !missing.length);
}

// Take Liquidity: "there's nothing worth taking" — right only if every price is fair.
function submitNoTrade() {
  const q = APP.drill.question;
  if (!q || q.type !== 'take') return;
  if (q.correct.length) { drillTakeWrong('There was a good trade on the screen — selections cleared.'); return; }
  addDrillScore(2);
  nextDrillQuestion();
  setDrillFeedback('+2 — correct, nothing worth taking', true);
}

function submitNoArb() {
  const q = APP.drill.question;
  if (!q || q.type !== 'arb') return;
  if (q.arbs.length) { drillTakeWrong('There was an arbitrage on the screen — selections cleared.'); return; }
  addDrillScore(2);
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
  types: { arb: true, take: true },
};

function nextDrillQuestion() {
  APP.drill.sel = {};
  if (APP.drill.view === 'single') {
    APP.drill.question = generateSingleQuestion();
  } else {
    // make-a-market is always in the mix; arbitrage / take-liquidity only if switched on in the config
    const mix = ['make', 'make'];
    if (APP.drill.types.arb) mix.push('arb', 'arb');
    if (APP.drill.types.take) mix.push('take', 'take');
    const type = nextFromBag('type', mix);
    APP.drill.question = type === 'make' ? generateMakeQuestion() : (type === 'arb' ? generateArbQuestion() : generateLiquidityQuestion());
  }
  renderDrillQuestion(false);
}

function drillTick() {
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
  APP.drill.types = Object.assign({}, APP.drillConfig.types);
  APP.drill.score = 0;
  APP.drill.totalSec = APP.drillConfig.minutes * 60;
  APP.drill.remainingSec = APP.drill.totalSec;
  APP.drill.bags = {};
  document.getElementById('drillScoreVal').textContent = '0';
  updateDrillTimerDisplay();
  nextDrillQuestion();
  if (APP.drill.timerId) clearTimeout(APP.drill.timerId);
  APP.drill.timerId = setTimeout(drillTick, 1000);
}

function endDrill() {
  if (APP.drill.timerId) { clearTimeout(APP.drill.timerId); APP.drill.timerId = null; }
  document.getElementById('drillFinalScore').textContent = `Score: ${APP.drill.score}`;
  showScreen('drillResults');
}

function bindDrillEvents() {
  const screen = document.getElementById('drillScreen');
  screen.addEventListener('input', (e) => { if (e.target.id === 'drillAnswer') handleDrillAnswerInput(e); });
  screen.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.id === 'mkBid' || e.target.id === 'mkAsk')) {
      if (e.target.id === 'mkBid' && !document.getElementById('mkAsk').value) document.getElementById('mkAsk').focus();
      else submitMakeAnswer();
    }
  });
  screen.addEventListener('click', (e) => {
    const t = e.target.closest('[data-drill]');
    if (!t) return;
    const a = t.dataset.drill;
    if (a === 'pick') toggleDrillPick(t.dataset.name, t.dataset.side, parseInt(t.dataset.level, 10));
    else if (a === 'make-trades') submitMakeTrades();
    else if (a === 'no-arb') submitNoArb();
    else if (a === 'no-trade') submitNoTrade();
    else if (a === 'submit-make') submitMakeAnswer();
  });
}
