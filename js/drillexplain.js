// "Explain Last Answer" (drills). From the second question on, a button on the side of the screen pauses
// the timer and re-draws the last question read-only — the best trade marked right on the books — with
// an explanation of why that trade was the best one. Closing it restarts the timer.

const fx = (x) => APP.util.fmt(x);

function updateExplainButton() {
  const btn = document.getElementById('explainBtn');
  if (btn) btn.classList.toggle('hidden', !APP.drill.last || APP.ui.screen !== 'drill');
}

function openExplain() {
  const last = APP.drill.last;
  if (!last || APP.drill.paused) return;
  APP.drill.paused = true;
  if (APP.drill.timerId) { clearTimeout(APP.drill.timerId); APP.drill.timerId = null; }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const el = document.getElementById('drillExplain');
  el.innerHTML = explainHtml(last);
  el.classList.remove('hidden');
}

// `silent`: just shut it (the drill is starting or ending and manages its own timer).
function closeExplain(silent) {
  const el = document.getElementById('drillExplain');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
  if (!APP.drill.paused) return;
  APP.drill.paused = false;
  if (silent) return;
  if (APP.drill.timerId) clearTimeout(APP.drill.timerId);
  APP.drill.timerId = setTimeout(drillTick, 1000);
  const inp = document.getElementById('mkBid') || document.getElementById('drillAnswer');
  if (inp) inp.focus();
}

// ---- building the explanation ----------------------------------------------------------

const exName = (key, q) => sheetHeaderFor(key, q.K);
const exLeg = (l, q) => `${l.side === 'buy' ? 'buy' : 'sell'} the ${exName(l.name, q)}`;
const exParity = (q) => APP.drill.delta1 === 'future'
  ? `Call − Put = Future − ${q.K}`
  : `Call − Put = Stock − ${q.K} + R/C (${APP.util.fmtSigned(q.rc)})`;

function explainHtml(last) {
  const q = last.q, a = last.ans || {};
  const hl = {};
  const ctx = { q, hl, answer: a, user: null };
  let why = '';
  if (q.type === 'make') why = explainMake(q, a);
  else if (q.type === 'arb') why = explainArb(q, a, hl);
  else if (q.type === 'improve') why = explainImprove(q, a, hl, ctx);
  else why = explainSingle(q, a);

  let board = '';
  if (q.type !== 'single') {
    DRILL_CTX = ctx;
    try { board = bookBoardHtml(); } finally { DRILL_CTX = null; }
  }
  return `<div class="ex-card">
    <div class="ex-head">
      <h2>Last question — ${DRILL_TYPE_NAMES[q.type]}</h2>
      <span class="ex-paused">⏸ timer paused</span>
      <button class="ex-close" data-drill="close-explain">Back to the drill</button>
    </div>
    ${board}
    <div class="ex-why">${why}</div>
  </div>`;
}

// target = c + Σ w·instrument; selling the package for `bid` uses each long leg at its bid and each
// short leg at its offer (buying it for `ask` is the other way round).
function replText(q, rep, side) {
  let val = rep.c;
  const terms = Object.entries(rep.w).map(([n, w]) => {
    const useBid = (side === 'bid') === (w > 0);
    const px = useBid ? q.books[n].bid : q.books[n].ask;
    val += w * px;
    const coef = Math.abs(w) === 1 ? '' : `${Math.abs(w)} × `;
    return `${w > 0 ? '+' : '−'} ${coef}${exName(n, q)} ${useBid ? 'bid' : 'offer'} ${fx(px)}`;
  });
  const lead = rep.c ? `${fx(rep.c)} ` : '';
  return { html: `<span class="eq">${side} = ${lead}${terms.join(' ')} = ${fx(val)}</span>`, val };
}

function explainMake(q, a) {
  const t = exName(q.target, q), b = q.best;
  const bid = replText(q, b.bidRep, 'bid'), ask = replText(q, b.askRep, 'ask');
  let h = `<p>The <b>${t}</b> isn't on the screen, but it can be built from the two books that are, using put-call parity (<span class="eq">${exParity(q)}</span>; Straddle = Call + Put). A market in it should be as tight as that replication allows — never better, or the replication would beat you.</p>`;
  h += `<p><b>Bid:</b> if you buy the ${t} at your bid, you can sell the equivalent package into the other books for ${fx(bid.val)} — so you can bid up to that without risk. ${bid.html}</p>`;
  h += `<p><b>Offer:</b> if you sell the ${t} at your offer, you can buy the equivalent package for ${fx(ask.val)} — so you can offer down to that. ${ask.html}</p>`;
  const rounded = `${fx(dft(b.rawBid))} / ${fx(dct(b.rawAsk))}`;
  h += `<p>Rounded to the ${fx(dtick())} tick (bid down, offer up) that's ${rounded}`;
  if (isFinite(q.floor) && b.bid > dft(b.rawBid) + 1e-9) {
    h += `. But nobody bids less than an option's intrinsic value (${fx(q.floor)} here), so the bid is lifted to <b>${fx(b.bid)}</b>`;
  }
  h += `: the best market is <b class="good">${fx(b.bid)} / ${fx(b.ask)}</b>.</p>`;
  h += `<p>Scoring: any market at most 1.00 wide with the midpoint of that best market (${fx(b.fair)}) inside it earns 1 point; exactly ${fx(b.bid)} / ${fx(b.ask)} earns 2.</p>`;
  if (a.bid != null) h += `<p class="ex-you">You made ${fx(a.bid)} / ${fx(a.ask)} → +${a.pts}.</p>`;
  return h;
}

function explainArb(q, a, hl) {
  const vecs = arbVectors(APP.drill.delta1, q.K, q.rc);
  if (!q.arbs.length) {
    let h = `<p><b>No arbitrage.</b> Put-call parity (<span class="eq">${exParity(q)}</span>; Straddle = Call + Put) says every instrument can be built from the others. There's an arbitrage only if some market lies <em>outside</em> what the others imply — a bid above what you could buy the replication for, or an offer below what you could sell it for. Here each market overlaps its implied range:</p><p>`;
    const quotes = booksToQuotes(q.books);
    Object.keys(q.books).forEach(k => {
      const imp = bestMarketFromOthers(vecs, k, booksToQuotes(q.books, k));
      if (imp.bid == null || imp.ask == null) return;
      h += `${exName(k, q)}: market ${fx(quotes[k].bid)} – ${fx(quotes[k].ask)}, the others imply ${fx(imp.bid)} – ${fx(imp.ask)}<br>`;
    });
    return h + '</p>';
  }
  const best = q.arbs[0];
  best.legs.forEach(l => { hl[`${l.name}:${l.side}:0`] = l.side; });
  let cash = 0, ea = 0, eb = 0, ec = 0;
  best.legs.forEach(l => {
    const px = l.side === 'buy' ? q.books[l.name].ask : q.books[l.name].bid;
    const s = l.side === 'buy' ? 1 : -1, v = vecs[l.name];
    cash -= s * l.qty * px;
    ea += s * l.qty * v.a; eb += s * l.qty * v.b; ec += s * l.qty * v.c;
  });
  let h = `<p><b>The best arbitrage:</b> ${best.legs.map(l => `${l.qty > 1 ? l.qty + ' × ' : ''}${exLeg(l, q)} at ${fx(l.side === 'buy' ? q.books[l.name].ask : q.books[l.name].bid)}`).join(', ')}.</p>`;
  h += `<p>Why it's riskless: by put-call parity (<span class="eq">${exParity(q)}</span>; Straddle = Call + Put) these legs cancel each other's exposure completely — whatever the ${drillName('stock').toLowerCase()} does, the package is worth a fixed ${fx(ec)} at expiry. Today it ${cash >= 0 ? 'pays you' : 'costs you'} ${fx(Math.abs(cash))}, so you lock in <b class="good">${fx(cash + ec)}</b>. Every leg is at the best price on its side; you take each one's whole size.</p>`;
  if (q.arbs.length > 1) h += `<p>Other arbitrages on the screen were smaller (${q.arbs.slice(1, 4).map(p => fx(p.profit)).join(', ')}); the biggest earns the full 2 points.</p>`;
  if (a.pkg && a.pts === 1) h += `<p class="ex-you">You found a smaller one (${fx(a.pkg.profit)}) → +1.</p>`;
  else if (a.pts) h += `<p class="ex-you">You took it → +${a.pts}.</p>`;
  return h;
}

function explainImprove(q, a, hl, ctx) {
  const imp = a.improve || {};
  const u = imp.user;
  // the market to explain: the one you ended on if it was a good one, otherwise the one the books point to
  const tg = (u && q.targets.find(o => o.key === u.key && o.side === u.side)) || q.intended;
  const name = exName(tg.key, q);
  const best = q.books[tg.key];
  const optimal = { key: tg.key, side: tg.side, px: tg.limit, size: tg.size };
  ctx.user = optimal; // the board shows the most competitive market on its instrument
  const arbs = improveArbs(q, optimal).sort((x, y) => y.profit - x.profit);
  const pkg = arbs[0];
  pkg.legs.forEach(l => { if (l.name !== tg.key) hl[`${l.name}:${l.side}:0`] = l.side; });

  const an = q.anchor, anName = exName(an.key, q);
  const anLvl = q.books[an.key][an.side === 'bid' ? 'bids' : 'asks'][0];
  let h = `<p><b>The large order</b> is a customer ${an.side === 'bid' ? 'bid' : 'offer'} of ${anLvl.size} in the ${anName}. It's firm — you can always trade against it to hedge — so the other markets are anchored on it. `;
  h += q.cue === 'delta'
    ? `A big, aggressive order in the ${drillName('stock').toLowerCase()} is someone who wants direction, and a deep in-the-money option gives the same exposure — so that's the kind of market to improve.</p>`
    : `A big order in an at-the-money option or straddle is someone who wants volatility, and another at-the-money option market moves with it — so that's the kind of market to improve.</p>`;

  const r = replText(q, tg.rep, tg.side);
  const curPx = tg.side === 'bid' ? best.bid : best.ask;
  h += `<p><b>The market to improve:</b> the ${name} ${tg.side === 'bid' ? 'bid' : 'offer'}. From the other books, the equivalent package can be ${tg.side === 'bid' ? 'sold for' : 'bought for'} <b>${fx(tg.implied)}</b> ${r.html}, but the ${name} ${tg.side === 'bid' ? 'bid' : 'offer'} is only ${fx(curPx)}.</p>`;
  h += `<p><b>The band:</b> any ${tg.side === 'bid' ? 'bid above ' + fx(curPx) + ' up to' : 'offer below ' + fx(curPx) + ' down to'} <b>${fx(tg.limit)}</b> is inside the arb-able band — you ${tg.side === 'bid' ? 'buy' : 'sell'} at your price and lay it off at ${fx(tg.implied)}, so there's a profit. The most competitive price is <b>${fx(tg.limit)}</b>.</p>`;

  // the size: whichever leg of the package runs out first
  const legSizes = Object.entries(tg.rep.w).map(([n, w]) => {
    const lvl = ((tg.side === 'bid') === (w > 0)) ? q.books[n].bids[0] : q.books[n].asks[0];
    return { n, size: lvl.size, w: Math.abs(w), cap: lvl.size / Math.abs(w) };
  }).sort((x, y) => x.cap - y.cap);
  const lim = legSizes[0];
  h += `<p><b>The size:</b> <b>${tg.size}</b> — the ${exName(lim.n, q)} (${lim.size} on the ${(tg.side === 'bid') === (tg.rep.w[lim.n] > 0) ? 'bid' : 'offer'}${lim.w !== 1 ? ', ' + lim.w + ' of it per ' + name : ''}) is the leg that runs out first, and a bigger market than that could not be fully hedged.</p>`;

  const qtyT = pkg.legs.find(l => l.name === tg.key).qty;
  const pkgs = Math.floor(tg.size / qtyT);
  h += `<p><b>The arbitrage:</b> ${tg.side === 'bid' ? 'buy' : 'sell'} ${tg.size} ${name} at ${fx(tg.limit)}, and ${pkg.legs.filter(l => l.name !== tg.key).map(l => `${l.side} ${l.qty * pkgs} ${exName(l.name, q)} at ${fx(l.side === 'buy' ? q.books[l.name].asks[0].px : q.books[l.name].bids[0].px)}`).join(', ')}. By put-call parity (<span class="eq">${exParity(q)}</span>; Straddle = Call + Put) the legs cancel exactly, so it locks in <b class="good">${fx(pkg.profit)}</b> per package, ${pkgs} times over.</p>`;

  const sc = imp.sc;
  if (sc) {
    const f = imp.first;
    const parts = [
      `${sc.p1 ? '✓' : '✗'} improved a good market (first try)`,
      `${sc.p2 ? '✓' : '✗'} price inside the arb-able band (first try)`,
      `${sc.p3 ? '✓' : '✗'} the most competitive price in the right size`,
      `${sc.p4 ? '✓' : '✗'} completed the other legs (first try)`,
    ];
    h += `<p class="ex-you">You${f ? ` first tried ${f.side === 'bid' ? 'a bid' : 'an offer'} of ${fx(f.px)} in ${f.size} ${exName(f.key, q)}` : ' skipped'}${imp.history && imp.history.length > 1 ? `, changed it ${imp.history.length - 1} time${imp.history.length > 2 ? 's' : ''}` : ''}${imp.skipped ? ', and skipped' : ''}. ${parts.join(' · ')} → +${sc.total}.</p>`;
  }
  return h;
}

function explainSingle(q, a) {
  const v = q.values, D = v.call - v.put;
  let h = `<p>Put-call parity ties the prices together: <span class="eq">${exParity(q)}</span>, and Straddle = Call + Put. Here Call − Put = ${fx(D)}, Straddle = ${fx(v.straddle)}.</p>`;
  h += `<p>The missing <b>${exName(q.target, q)}</b> works out to <b class="good">${fx(q.answer)}</b>.</p>`;
  if (a.value != null) h += `<p class="ex-you">You answered ${fx(a.value)} → +${a.pts}.</p>`;
  return h;
}
