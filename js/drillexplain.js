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
  let why = '';
  if (q.type === 'make') why = explainMake(q, a);
  else if (q.type === 'arb') why = explainArb(q, a, hl);
  else if (q.type === 'take') why = explainTake(q, a, hl);
  else why = explainSingle(q, a);

  let board = '';
  if (q.type !== 'single') {
    DRILL_CTX = { q, hl, answer: a };
    try { board = bookBoardHtml(); } finally { DRILL_CTX = null; }
  }
  return `<div class="ex-card">
    <div class="ex-head">
      <h2>Last question — ${DRILL_TYPE_NAMES[q.type]}</h2>
      <span class="ex-paused">⏸ timer paused</span>
      <button class="ex-close" data-drill="close-explain">Back to the drill</button>
    </div>
    ${q.alert ? `<div class="ex-alert">${q.alert}</div>` : ''}
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
  const rounded = `${fx(APP.util.floor5c(b.rawBid))} / ${fx(APP.util.ceil5c(b.rawAsk))}`;
  h += `<p>Rounded to the 0.05 grid (bid down, offer up) that's ${rounded}`;
  if (isFinite(q.floor) && b.bid > APP.util.floor5c(b.rawBid) + 1e-9) {
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

function explainTake(q, a, hl) {
  const keys = Object.keys(q.books);
  q.correct.forEach(l => { hl[`${l.name}:${l.side}:${l.level || 0}`] = l.side; });
  let h = `<p>Every instrument has a fair value, and they all fit together by put-call parity (<span class="eq">${exParity(q)}</span>; Straddle = Call + Put). Here: Call − Put = ${fx(q.D)}, Straddle = ${fx(q.T)}, so`;
  h += keys.map(k => ` ${exName(k, q)} ${fx(q.values[k])}`).join(',') + '.</p>';
  if (!q.correct.length) {
    h += `<p><b>Nothing to take:</b> every book brackets its fair value — each bid is at or below it and each offer at or above — so any trade would give edge away.</p>`;
  } else {
    h += `<p><b>The best trade${q.correct.length > 1 ? 's' : ''}:</b></p><p>`;
    h += q.correct.map(l => {
      const lv = l.side === 'buy' ? q.books[l.name].asks[l.level || 0] : q.books[l.name].bids[l.level || 0];
      const edge = l.side === 'buy' ? q.values[l.name] - lv.px : lv.px - q.values[l.name];
      return `${exLeg(l, q)} at ${fx(lv.px)} (x${lv.size}): fair value is ${fx(q.values[l.name])}, so you ${l.side === 'buy' ? 'buy it' : 'sell it'} <span class="good">${fx(edge)}</span> ${l.side === 'buy' ? 'under' : 'over'} fair.`;
    }).join('<br>') + '</p>';
    h += `<p>The other books all sit around the same consistent set of fair values; these quotes are the ones standing out in front of their books (and a little thinner than normal). Hitting any other price gives away edge.</p>`;
  }
  if (q.news) {
    const n = q.news, z = exName(n.name, q);
    const what = n.why === 'delta' ? (n.name === 'stock' ? 'the delta-1 instrument, which you trade for direction' : 'an in-the-money option, which you trade for direction')
      : (n.name === 'straddle' ? 'an at-the-money straddle, which is a pure volatility trade' : 'an at-the-money option, which you trade for volatility');
    if (n.informed) {
      h += `<p><b>The news:</b> a massive clip (${n.size}) in ${what} — someone with a reason. A trade like that is informed, so its price (${fx(n.px)}) is the ${z}'s true value, and it anchors all the other fair values.</p>`;
    } else if (n.kind === 'noise') {
      h += `<p><b>The news:</b> a massive clip (${n.size}) — but in the ${z}, an out-of-the-money option (or an off-centre straddle) that nobody takes a view with. Size alone doesn't make a trade informed: it needs a reason as well (delta in the future or in-the-money options, vol in at-the-money options). So ${fx(n.px)} is just a price inside the market — ignore it.</p>`;
    } else {
      h += `<p><b>The news:</b> a clip of ${n.size} in the ${z} is only about the size of the books, so it says little — ${fx(n.px)} is just a price inside its market. A big trade in the right kind of instrument is what carries information.</p>`;
    }
  }
  if (a.hedge) {
    h += `<p class="ex-you">You took a price that isn't the best trade but belongs to a riskless package (${a.hedge.legs.map(l => exLeg(l, q)).join(', ')} locks in ${fx(a.hedge.profit)}) → +1.</p>`;
  } else if (a.none) {
    h += `<p class="ex-you">You called it correctly → +2.</p>`;
  } else if (a.legs) {
    h += `<p class="ex-you">You took ${a.legs.map(l => exLeg(l, q)).join(' and ')} → +${a.pts}.</p>`;
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
