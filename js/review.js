// End-of-session review. While a session runs this quietly records what the user did — every trade, every
// market they made, their risk over time, the arbitrages that were on the screen — and at the end it turns
// that into a score out of 10 with feedback. Put-call parity is the point of the exercise, so it carries
// the most weight: are your markets in line with what the other books at the strike imply, and did you
// take (rather than walk past) the prices that were out of line?
//
//   put-call parity — your markets in line with the other books at the strike ..... 3.0
//   put-call parity — arbitrages and parity gaps taken rather than passed ......... 1.5
//   a reasonable amount of edge in your markets ..................................... 1.0
//   staying vega neutral (and hedging, including by improving markets) ........... 1.0
//   staying delta neutral (the same) ................................................ 1.0
//   plus-EV trades (against fair value) ............................................. 1.0
//   trying to be top of book ........................................................ 0.5
//   profit ............................................................................ 1.0
//
// It's a judgement, not an exact science: a few of these (risk, profit) are read off what happened, not
// off what you intended.

APP.review = null;

function resetReview() {
  APP.review = { trades: [], quotes: [], samples: [], arbSeen: {}, arbMissed: [] };
}

function reviewStamp() {
  return { step: APP.config.mode === 'steps' ? APP.session.step : null, t: APP.session.elapsedSec, phase: APP.session.phase };
}
function reviewWhen(s) {
  if (s.phase === 'setup') return 'while you were setting up the board';
  if (s.step != null) return `at step ${s.step}`;
  return `at ${Math.floor(s.t / 60)}:${String(Math.floor(s.t % 60)).padStart(2, '0')}`;
}

// Quotes for the strike's other instruments that someone could actually trade against (a level that is
// only your own order can't be taken), excluding `excludeName`.
function tradableStrikeQuotes(idx, excludeName) {
  const vecs = arbVectors(APP.market.delta1, APP.market.strikes[idx], APP.market.rc);
  const quotes = {};
  Object.keys(vecs).forEach(name => {
    if (name === excludeName) return;
    const cell = name === 'stock' ? APP.instruments.stock : getCell(name, idx, false);
    if (!cell) return;
    const b = cell.bids[0], a = cell.asks[0];
    if (b && b.size > 0 && a && a.size > 0) quotes[name] = { bid: b.px, ask: a.px };
  });
  return { vecs, quotes };
}

const REVIEW_PARITY_KINDS = ['call', 'put', 'straddle', 'ps', 'bw'];

// target = c + Σ w·instrument — selling the package for `bid` uses each long leg's bid and each short
// leg's offer (buying it for `ask` is the other way round).
function reviewRepl(kind, idx, rep, side, quotes) {
  let val = rep.c;
  const parts = Object.entries(rep.w).map(([n, w]) => {
    const useBid = (side === 'bid') === (w > 0);
    const px = useBid ? quotes[n].bid : quotes[n].ask;
    val += w * px;
    return `${w > 0 ? '+' : '−'} ${Math.abs(w) === 1 ? '' : Math.abs(w) + ' × '}${describeInstrument(n, n === 'stock' ? 0 : idx, false)} ${useBid ? 'bid' : 'offer'} ${fmt(px)}`;
  });
  return { text: `${rep.c ? fmt(rep.c) + ' ' : ''}${parts.join(' ')} = ${fmt(val)}`, val };
}

// ---- recording ----------------------------------------------------------------------------

// Called from addTrade for every trade of yours (a take, a customer hitting your market, an IDB print...).
function reviewTrade(kind, idx, side, qty, price, source, meta, gBefore, gAfter) {
  const R = APP.review;
  if (!R) return;
  const t = tickSize();
  const fair = fairMid(kind, idx);
  const edge = side === 'buy' ? fair - price : price - fair;
  let parity = null;
  if (REVIEW_PARITY_KINDS.includes(kind)) {
    const { vecs, quotes } = tradableStrikeQuotes(idx, kind);
    const imp = bestMarketFromOthers(vecs, kind, quotes);
    // buying below what the others let you sell the same thing for, or selling above what they let you buy it for
    const gap = side === 'buy' ? (imp.bid != null ? imp.bid - price : null) : (imp.ask != null ? price - imp.ask : null);
    if (gap != null) parity = { gap, bidRep: imp.bidRep, askRep: imp.askRep, quotes, impBid: imp.bid, impAsk: imp.ask };
  }
  const lots = kind === 'stock' ? qty * delta1Multiplier() / 100 : qty; // count every trade in 100-unit lots, as the options are
  R.trades.push(Object.assign(reviewStamp(), {
    kind, idx, side, qty, lots, price, source, fair, edge, parity,
    vegaBefore: gBefore.vega, vegaAfter: gAfter.vega, deltaBefore: gBefore.delta, deltaAfter: gAfter.delta,
    improved: !!(meta && meta.improved),
  }));
  reviewSample();
}

// A market of yours: an answer to a request (`how` 'rfq') or an order you put in ('order').
function reviewQuote(info) {
  const R = APP.review;
  if (!R) return;
  const { kind, idx, side, bid, ask, volume } = info;
  const t = tickSize();
  const fair = fairMid(kind, idx);
  const hasBid = side === 'both' || side === 'bid', hasAsk = side === 'both' || side === 'ask';
  const q = Object.assign(reviewStamp(), info, { fair, hasBid, hasAsk });
  // edge asked: how far your prices sit from true value, and how wide the market is
  const bidEdge = hasBid ? fair - bid : null, askEdge = hasAsk ? ask - fair : null;
  q.bidEdge = bidEdge; q.askEdge = askEdge;
  q.width = hasBid && hasAsk ? ask - bid : null;
  if (info.how === 'rfq' && volume) q.typical = typicalWidth(kind, idx, volume);
  if (info.how === 'rfq') {
    let s = 1;
    const worst = Math.min(bidEdge == null ? Infinity : bidEdge, askEdge == null ? Infinity : askEdge);
    if (worst < -t) s = 0;                    // you're quoting through fair value: edge given away
    else if (worst < -t / 2 + 1e-9) s = 0.5;
    if (s > 0 && q.width != null && q.typical && q.width > 1.5 * Math.max(q.typical, t) + 1e-9) s = Math.min(s, 0.6); // greedy
    q.edgeScore = s;
  }
  // put-call parity: are your prices in line with what the other books at this strike imply?
  if (REVIEW_PARITY_KINDS.includes(kind)) {
    const { vecs, quotes } = strikeQuotes(idx, kind, true);
    const imp = bestMarketFromOthers(vecs, kind, quotes);
    const bidViol = hasBid && imp.bid != null ? bid - imp.bid : null;       // bidding above what you can sell the others' package for
    const askViol = hasAsk && imp.ask != null ? imp.ask - ask : null;       // offering below what you can buy it for
    const evaluated = [bidViol, askViol].filter(v => v != null);
    if (evaluated.length) {
      const viol = Math.max(...evaluated);
      const slack = Math.max(...[bidViol, askViol].filter(v => v != null).map(v => -v));
      let score;
      if (viol >= 2 * t - 1e-9) score = 0;
      else if (viol > t / 2 + 1e-9) score = 0.3;
      else score = slack <= 3 * t + 1e-9 ? 1 : (slack <= 6 * t + 1e-9 ? 0.8 : 0.6);
      q.parity = { score, viol, slack, bidViol, askViol, impBid: imp.bid, impAsk: imp.ask, bidRep: imp.bidRep, askRep: imp.askRep, quotes };
    }
  }
  R.quotes.push(q);
}

function reviewSample() {
  const R = APP.review;
  if (!R) return;
  const g = currentGreeksTotal();
  R.samples.push(Object.assign(reviewStamp(), { vega: g.vega, delta: g.delta }));
}

// Parity gaps on the screen that you could take (every price tradable, nothing of your own in them). Seen at
// `needSeen` samples running without being taken, they count as passed.
function reviewScanArbs(needSeen) {
  const R = APP.review;
  if (!R || APP.session.phase !== 'flow') return;
  const t = tickSize(), now = {};
  APP.market.strikes.forEach((K, i) => {
    const { vecs, quotes } = tradableStrikeQuotes(i, null);
    findArbs(vecs, quotes).forEach(a => { if (a.profit >= t - 1e-9) now[`${i}|${a.key}`] = { i, a }; });
  });
  Object.keys(R.arbSeen).forEach(k => { if (!now[k]) delete R.arbSeen[k]; });
  Object.keys(now).forEach(k => {
    const s = R.arbSeen[k] || (R.arbSeen[k] = { seen: 0, flagged: false });
    s.seen++;
    if (!s.flagged && s.seen >= needSeen) {
      s.flagged = true;
      const { i, a } = now[k];
      const legs = a.legs.map(l => `${l.side} ${l.qty > 1 ? l.qty + ' × ' : ''}the ${describeInstrument(l.name, l.name === 'stock' ? 0 : i, false)} at ${fmt(l.side === 'buy' ? quotesAsk(i, l.name) : quotesBid(i, l.name))}`).join(', ');
      R.arbMissed.push(Object.assign(reviewStamp(), { strike: APP.market.strikes[i], profit: a.profit, legs }));
    }
  });
}
function quotesBid(i, name) { const c = name === 'stock' ? APP.instruments.stock : getCell(name, i, false); return c && c.bids[0] ? c.bids[0].px : NaN; }
function quotesAsk(i, name) { const c = name === 'stock' ? APP.instruments.stock : getCell(name, i, false); return c && c.asks[0] ? c.asks[0].px : NaN; }

// ---- scoring ------------------------------------------------------------------------------

const avgOf = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// risk neutrality for one greek ('vega' | 'delta'): did you keep it near zero, and when you were
// carrying some, did your next trades take it down?
function neutralityScore(R, greek) {
  const T = R.trades;
  if (!T.length) return { score: 0.4, note: 'no trades, so nothing to judge', hedges: 0, viaQuote: 0, peak: 0 };
  const bf = (x) => Math.abs(x[greek + 'Before']), af = (x) => Math.abs(x[greek + 'After']);
  const typical = avgOf(T.map(x => Math.abs(x[greek + 'After'] - x[greek + 'Before']))) || 1;
  const risky = T.filter(x => bf(x) > 0.5 * typical);
  const hedges = risky.filter(x => af(x) < bf(x) - 1e-9);
  const viaQuote = hedges.filter(x => (x.source === 'fill' || x.source === 'reward') && x.improved);
  const peak = Math.max(...R.samples.map(s => Math.abs(s[greek])), 0);
  const fin = R.samples.length ? Math.abs(R.samples[R.samples.length - 1][greek]) : 0;
  const endRatio = fin / Math.max(peak, typical);
  const hedgeRate = risky.length ? hedges.length / risky.length : null;
  let s = (hedgeRate == null ? 0.5 : 0.5 * hedgeRate) + 0.5 * (1 - Math.min(1, endRatio));
  s = Math.min(1, s + Math.min(0.3, 0.15 * viaQuote.length));
  const name = greek === 'vega' ? 'vega' : 'delta';
  const unit = greek === 'vega' ? '' : ' shares';
  const note = `${hedges.length} of ${risky.length} trades that started with ${name} on cut it` +
    (viaQuote.length ? `, ${viaQuote.length} by improving a market and getting filled` : '') +
    `; you finished at ${fmt(R.samples.length ? R.samples[R.samples.length - 1][greek] : 0)}${unit}`;
  return { score: s, note, hedges: hedges.length, viaQuote: viaQuote.length, peak, riskyN: risky.length };
}

function buildReview() {
  const R = APP.review || { trades: [], quotes: [], samples: [], arbMissed: [] };
  const t = tickSize();
  const rows = [];
  const add = (key, label, weight, score, note) => rows.push({ key, label, weight, score: Math.max(0, Math.min(1, score)), note });

  // put-call parity: your markets
  const pq = R.quotes.filter(q => q.parity);
  const inLine = pq.filter(q => q.parity.viol <= t / 2 + 1e-9);
  add('pcpQuotes', 'Put-call parity: your markets', 3.0, pq.length ? avgOf(pq.map(q => q.parity.score)) : 0.4,
    pq.length ? `${inLine.length} of ${pq.length} of your prices were in line with what the other books at the strike imply` : 'you made no markets in an option we could check against parity');

  // put-call parity: arbitrages and gaps taken
  const caught = R.trades.filter(x => (x.source === 'take' || x.source === 'reward') && x.parity && x.parity.gap >= t / 2 - 1e-9);
  const passed = R.arbMissed;
  const arbScore = caught.length + passed.length ? caught.length / (caught.length + passed.length) : 0.6;
  add('pcpArbs', 'Put-call parity: spotting arbitrage', 1.5, caught.length ? 0.5 + 0.5 * arbScore : arbScore,
    caught.length + passed.length ? `${caught.length} parity gap${caught.length === 1 ? '' : 's'} taken, ${passed.length} left on the screen` : 'no clear gaps appeared on the screen');

  // edge asked
  const eq = R.quotes.filter(q => q.edgeScore != null);
  add('edge', 'A reasonable edge', 1.0, eq.length ? avgOf(eq.map(q => q.edgeScore)) : 0.4,
    eq.length ? `${eq.filter(q => q.edgeScore >= 1).length} of ${eq.length} markets had you on the right side of fair value without being greedy` : 'no markets to judge');

  // risk
  const vega = neutralityScore(R, 'vega'), delta = neutralityScore(R, 'delta');
  add('vega', 'Staying vega neutral', 1.0, vega.score, vega.note);
  add('delta', 'Staying delta neutral', 1.0, delta.score, delta.note);

  // plus-EV trades
  const T = R.trades;
  let evScore = 0.3, evNote = 'no trades';
  if (T.length) {
    const vol = T.reduce((s, x) => s + x.lots, 0);
    const good = T.filter(x => x.edge >= -t / 4).reduce((s, x) => s + x.lots, 0);
    const total = T.reduce((s, x) => s + x.edge * x.lots, 0);
    evScore = (good / vol) * (total >= 0 ? 1 : 0.6);
    evNote = `${Math.round(100 * good / vol)}% of your volume was at or better than fair value (${total >= 0 ? '+' : '−'}${fmt(Math.abs(total) * 100)} of edge in all)`;
  }
  add('ev', 'Plus-EV trades', 1.0, evScore, evNote);

  // top of book
  const placed = R.quotes.filter(q => q.top != null);
  const tops = placed.filter(q => q.top);
  add('top', 'Trying to be top of book', 0.5, placed.length ? tops.length / placed.length : 0.4,
    placed.length ? `${tops.length} of ${placed.length} of your prices were the best in their book` : 'no markets made');

  // profit
  const pnl = hasPosition() ? bsPnlAt(currentSpot()) : 0;
  const S = Math.max(50, 40 * T.length);
  add('profit', 'Making money', 1.0, T.length ? 0.5 + 0.5 * Math.tanh(pnl / S) : 0.4,
    T.length ? `${pnl >= 0 ? '+' : '−'}${fmt(Math.abs(pnl))} marked to fair value` : 'no trades');

  const score = rows.reduce((s, r) => s + r.weight * r.score, 0);
  return { rows, score, pnl, moments: reviewMoments(R, pq, inLine, caught, passed, eq), caught, passed, pq, inLine };
}

// ---- walking through a good moment and a not-so-good one ------------------------------------

function reviewMoments(R, pq, inLine, caught, passed, eq) {
  const t = tickSize();
  const fm = fmt;
  const nameOf = (x) => describeInstrument(x.kind, x.idx, !!x.book);

  // GOOD: a parity gap you took > a tight, in-line market > a hedge > a plus-EV trade
  let good = null;
  if (caught.length) {
    const x = caught.slice().sort((a, b) => b.parity.gap * b.lots - a.parity.gap * a.lots)[0];
    const rep = x.side === 'buy' ? x.parity.bidRep : x.parity.askRep;
    const r = rep ? reviewRepl(x.kind, x.idx, rep, x.side === 'buy' ? 'bid' : 'ask', x.parity.quotes) : null;
    good = `${capFirst(reviewWhen(x))} you ${x.side === 'buy' ? 'bought' : 'sold'} ${x.qty} ${nameOf(x)} at ${fm(x.price)}. Put-call parity, using the other books at that strike, said it was worth ${fm(x.side === 'buy' ? x.parity.impBid : x.parity.impAsk)}`
      + (r ? ` (${r.text})` : '') + `, so you took a ${fm(x.parity.gap)} gap that was out of line — exactly what the exercise is about.`;
  }
  if (!good) {
    const best = inLine.filter(q => q.parity.score >= 1 && q.how === 'rfq').sort((a, b) => (b.parity.impBid != null && b.parity.impAsk != null) - (a.parity.impBid != null && a.parity.impAsk != null))[0];
    if (best) {
      const p = best.parity;
      const rep = p.bidRep && best.hasBid ? reviewRepl(best.kind, best.idx, p.bidRep, 'bid', p.quotes) : (p.askRep ? reviewRepl(best.kind, best.idx, p.askRep, 'ask', p.quotes) : null);
      good = `${capFirst(reviewWhen(best))} you were asked for ${nameOf(best)} (${best.volume} lots) and quoted ${best.hasBid ? fm(best.bid) : ''}${best.hasBid && best.hasAsk ? ' – ' : ''}${best.hasAsk ? fm(best.ask) : ''}. The other books at that strike imply ${p.impBid != null ? fm(p.impBid) : '—'} – ${p.impAsk != null ? fm(p.impAsk) : '—'}`
        + (rep ? ` (${rep.text})` : '') + `, so your market sat right on put-call parity: no one could pick you off by trading the strike against itself, and you still kept a sensible edge.`;
    }
  }
  if (!good) {
    const h = R.trades.filter(x => ['vega', 'delta'].some(g => Math.abs(x[g + 'Before']) > 0 && Math.abs(x[g + 'After']) < Math.abs(x[g + 'Before'])))[0];
    if (h) good = `${capFirst(reviewWhen(h))} you traded ${h.qty} ${nameOf(h)} and it cut your risk (vega ${fm(h.vegaBefore)} → ${fm(h.vegaAfter)}, delta ${fm(h.deltaBefore)} → ${fm(h.deltaAfter)}) — good habit.`;
  }
  if (!good) {
    const e = R.trades.filter(x => x.edge > 0).sort((a, b) => b.edge * b.lots - a.edge * a.lots)[0];
    if (e) good = `${capFirst(reviewWhen(e))} you ${e.side === 'buy' ? 'bought' : 'sold'} ${e.qty} ${nameOf(e)} at ${fm(e.price)}, ${fm(e.edge)} ${e.side === 'buy' ? 'under' : 'over'} fair value — a plus-EV trade.`;
  }

  // BAD: a market off parity > a parity gap you passed > a market through fair value > one that was too wide
  let bad = null;
  const off = pq.filter(q => q.parity.viol > t / 2 + 1e-9).sort((a, b) => b.parity.viol - a.parity.viol)[0];
  if (off) {
    const p = off.parity;
    const bidSide = p.bidViol != null && p.bidViol >= (p.askViol == null ? -Infinity : p.askViol);
    const rep = bidSide ? p.bidRep : p.askRep;
    const r = rep ? reviewRepl(off.kind, off.idx, rep, bidSide ? 'bid' : 'ask', p.quotes) : null;
    bad = `${capFirst(reviewWhen(off))} you ${off.how === 'rfq' ? 'were asked for' : 'put in'} ${nameOf(off)}${off.how === 'rfq' ? ` (${off.volume} lots)` : ''} and showed ${bidSide ? 'a bid' : 'an offer'} of ${fm(bidSide ? off.bid : off.ask)}. `
      + `Put-call parity, from the other books at that strike, gave ${fm(bidSide ? p.impBid : p.impAsk)}${r ? ` (${r.text})` : ''} — so your price was ${fm(p.viol)} ${bidSide ? 'above' : 'below'} it. `
      + `A customer could ${bidSide ? 'sell it to you' : 'buy it from you'} and trade the other instruments the other way for a risk-free profit. ${bidSide ? 'A bid' : 'An offer'} of ${fm(bidSide ? p.impBid : p.impAsk)} or ${bidSide ? 'lower' : 'higher'} would have been in line.`;
  } else if (passed.length) {
    const m = passed.slice().sort((a, b) => b.profit - a.profit)[0];
    bad = `${capFirst(reviewWhen(m))} the ${m.strike} strike had a put-call parity gap on the screen worth ${fm(m.profit)}: ${m.legs}. Those prices don't fit together, so trading them all locks in a profit — and it was still there when you moved on. Look for the combination where the call, put and ${delta1Name().toLowerCase()} don't add up.`;
  } else {
    const thru = eq.filter(q => q.edgeScore === 0).sort((a, b) => Math.min(a.bidEdge == null ? 9 : a.bidEdge, a.askEdge == null ? 9 : a.askEdge) - Math.min(b.bidEdge == null ? 9 : b.bidEdge, b.askEdge == null ? 9 : b.askEdge))[0];
    if (thru) bad = `${capFirst(reviewWhen(thru))} you made ${nameOf(thru)} ${thru.hasBid ? fm(thru.bid) : ''}${thru.hasBid && thru.hasAsk ? ' – ' : ''}${thru.hasAsk ? fm(thru.ask) : ''} when fair value was about ${fm(thru.fair)}: you were quoting through fair value, giving the edge away.`;
    else {
      const wide = eq.filter(q => q.edgeScore != null && q.edgeScore < 1).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      if (wide) bad = `${capFirst(reviewWhen(wide))} your market in ${nameOf(wide)} (${fm(wide.bid)} – ${fm(wide.ask)}, ${fm(wide.width)} wide) was wider than the ${fm(wide.typical)} that's typical for ${wide.volume} lots — customers go elsewhere when you're greedy.`;
    }
  }
  return { good, bad };
}

const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- the results page ---------------------------------------------------------------------------

function reviewHtml() {
  const rv = buildReview();
  const theme = APP.market.theme ? APP.market.theme.label : '';
  const pcp = rv.rows.filter(r => r.key.startsWith('pcp'));
  const pcpScore = pcp.reduce((s, r) => s + r.weight * r.score, 0), pcpMax = pcp.reduce((s, r) => s + r.weight, 0);
  const pcpLine = rv.pq.length || rv.caught.length || rv.passed.length
    ? `${rv.inLine.length} of your ${rv.pq.length} prices were in line with put-call parity; you took ${rv.caught.length} parity gap${rv.caught.length === 1 ? '' : 's'} and walked past ${rv.passed.length}.`
    : 'There was little to judge on put-call parity this time.';
  const bar = (r) => `<div class="rv-row"><div class="rv-label">${r.label}<small>${r.note}</small></div>`
    + `<div class="rv-bar"><div style="width:${Math.round(r.score * 100)}%"></div></div><div class="rv-pts">${(r.weight * r.score).toFixed(1)} / ${r.weight.toFixed(1)}</div></div>`;
  return `<div class="rv">
    <div class="rv-score"><span class="rv-big">${rv.score.toFixed(1)}</span><span class="rv-of"> / 10</span></div>
    <div class="rv-sub">${rv.pnl >= 0 ? '+' : '−'}${fmt(Math.abs(rv.pnl))} marked to fair value${theme ? ` · the customers' theme was ${theme}` : ''}</div>
    <div class="rv-main"><b>Put-call parity — the main thing — scored ${pcpScore.toFixed(1)} of ${pcpMax.toFixed(1)}.</b> ${pcpLine}</div>
    <div class="rv-rows">${rv.rows.map(bar).join('')}</div>
    ${rv.moments.good ? `<div class="rv-moment good"><b>A moment you did well</b><p>${rv.moments.good}</p></div>` : ''}
    ${rv.moments.bad ? `<div class="rv-moment bad"><b>A moment you could do better</b><p>${rv.moments.bad}</p></div>` : ''}
    <div class="rv-note">This is a judgement from what you did — the hedging and profit scores especially are read from the results, not your intentions.</div>
  </div>`;
}
