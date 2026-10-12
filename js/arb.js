// Same-strike replication & arbitrage engine, shared by the drills and the simulation.
//
// For a fixed strike K, every instrument is an affine function of two prices — the delta-1 price X
// (future or stock) and the put price P:
//     value(name) = a*X + b*P + c
// (parity: C = P + X - K [+ rc for stock], straddle = C + P, P+S = C - rc, B/W = P + rc).
// Any instrument can therefore be replicated from two others (or one, if they're parallel), and
// the cheapest/richest such replication brackets what its market can be without allowing an arb.

const ARB_EPS = 1e-9;

function arbVectors(delta1, K, rc) {
  if (delta1 === 'future') {
    return {
      stock: { a: 1, b: 0, c: 0 },
      put: { a: 0, b: 1, c: 0 },
      call: { a: 1, b: 1, c: -K },
      straddle: { a: 1, b: 2, c: -K },
    };
  }
  return {
    stock: { a: 1, b: 0, c: 0 },
    put: { a: 0, b: 1, c: 0 },
    call: { a: 1, b: 1, c: rc - K },
    ps: { a: 1, b: 1, c: -K },
    bw: { a: 0, b: 1, c: rc },
    straddle: { a: 1, b: 2, c: rc - K },
  };
}

// All ways to write `target` as constant + weighted sum of at most two of the other `avail` names.
function arbReplications(vecs, target, avail) {
  const t = vecs[target];
  const out = [];
  const names = avail.filter(n => n !== target && vecs[n]);
  names.forEach(n => {
    const v = vecs[n];
    if (Math.abs(t.a * v.b - t.b * v.a) > ARB_EPS) return; // not parallel to the target
    if (Math.abs(v.a) < ARB_EPS && Math.abs(v.b) < ARB_EPS) return;
    const w = Math.abs(v.a) > ARB_EPS ? t.a / v.a : t.b / v.b;
    if (Math.abs(w) < ARB_EPS) return;
    out.push({ w: { [n]: w }, c: t.c - w * v.c });
  });
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const u = vecs[names[i]], v = vecs[names[j]];
      const det = u.a * v.b - v.a * u.b;
      if (Math.abs(det) < ARB_EPS) continue;
      const wu = (t.a * v.b - v.a * t.b) / det;
      const wv = (u.a * t.b - t.a * u.b) / det;
      if (Math.abs(wu) < ARB_EPS || Math.abs(wv) < ARB_EPS) continue; // really a single-leg replication
      out.push({ w: { [names[i]]: wu, [names[j]]: wv }, c: t.c - wu * u.c - wv * v.c });
    }
  }
  return out;
}

// lo = what you'd receive selling the replication's package; hi = what you'd pay buying it.
// (A leg you hold long is sold at its bid; a leg you hold short is bought back at its ask.)
function arbReplBounds(rep, quotes) {
  let lo = rep.c, hi = rep.c;
  for (const n in rep.w) {
    const q = quotes[n], w = rep.w[n];
    if (!q || q.bid == null || q.ask == null) return null;
    if (w > 0) { lo += w * q.bid; hi += w * q.ask; }
    else { lo += w * q.ask; hi += w * q.bid; }
  }
  return { lo, hi };
}

// The best (tightest) two-way market for `target` implied by `quotes` (name -> {bid, ask}) of the others.
function bestMarketFromOthers(vecs, target, quotes) {
  const names = Object.keys(quotes).filter(n => n !== target);
  let bid = -Infinity, ask = Infinity, bidRep = null, askRep = null;
  arbReplications(vecs, target, names).forEach(rep => {
    const b = arbReplBounds(rep, quotes);
    if (!b) return;
    if (b.lo > bid) { bid = b.lo; bidRep = rep; }
    if (b.hi < ask) { ask = b.hi; askRep = rep; }
  });
  return { bid: isFinite(bid) ? bid : null, ask: isFinite(ask) ? ask : null, bidRep, askRep };
}

// Smallest integer multiple of the weights (target = 1) so every leg is a whole number of units.
function arbIntegerScale(weights) {
  for (const m of [1, 2, 3, 4, 6]) {
    if (weights.every(w => Math.abs(w * m - Math.round(w * m)) < 1e-6)) return m;
  }
  return null;
}

// Every riskless package available in `quotes` (name -> {bid, ask}), as integer-unit leg lists.
// A leg's side is the user's action: 'buy' lifts the ask ("Mine"), 'sell' hits the bid ("Yours").
// Packages needing more than 2 units of any leg are ignored (the drill only lets you pick 1 or 2).
function findArbs(vecs, quotes) {
  const names = Object.keys(quotes).filter(n => vecs[n] && quotes[n].bid != null && quotes[n].ask != null);
  const byKey = {};
  const add = (target, tSide, rep, profit) => {
    const raw = [{ name: target, side: tSide, qty: 1 }];
    for (const n in rep.w) {
      const w = rep.w[n];
      const side = (tSide === 'sell') === (w > 0) ? 'buy' : 'sell';
      raw.push({ name: n, side, qty: Math.abs(w) });
    }
    const m = arbIntegerScale(raw.map(l => l.qty));
    if (!m) return;
    const legs = raw.map(l => ({ name: l.name, side: l.side, qty: Math.round(l.qty * m) }));
    const key = legs.map(l => `${l.name}:${l.side}:${l.qty}`).sort().join('|');
    const p = profit * m;
    if (!byKey[key] || p > byKey[key].profit) byKey[key] = { legs, profit: p, key };
  };
  names.forEach(t => {
    arbReplications(vecs, t, names).forEach(rep => {
      const b = arbReplBounds(rep, quotes);
      if (!b) return;
      const q = quotes[t];
      if (q.bid - b.hi > 1e-9) add(t, 'sell', rep, q.bid - b.hi); // sell it rich, buy the synthetic
      if (b.lo - q.ask > 1e-9) add(t, 'buy', rep, b.lo - q.ask);  // buy it cheap, sell the synthetic
    });
  });
  return Object.values(byKey).sort((x, y) => y.profit - x.profit);
}

// Every leg set that *could* form a replication package, whatever the prices: for each target and
// each way of replicating it, buying the target means selling the replication and vice versa.
// Used to pick coherent multi-leg misalignments for the drill. Legs are [{name, side}].
function candidatePackages(vecs, names) {
  const out = [];
  names.forEach(t => {
    arbReplications(vecs, t, names).forEach(rep => {
      ['buy', 'sell'].forEach(tSide => {
        const legs = [{ name: t, side: tSide }];
        for (const n in rep.w) legs.push({ name: n, side: (tSide === 'sell') === (rep.w[n] > 0) ? 'buy' : 'sell' });
        out.push({ legs });
      });
    });
  });
  return out;
}

// Quantities no longer matter (you always take a price's whole size): does the picked set of legs
// ([{name, side}]) equal the legs of one of `pkgs`? Returns that package or null.
function matchArbLegSet(sel, pkgs) {
  if (!sel.length) return null;
  for (const pkg of pkgs) {
    if (pkg.legs.length === sel.length && pkg.legs.every(l => sel.some(s => s.name === l.name && s.side === l.side))) return pkg;
  }
  return null;
}

// Does the user's picked legs ([{name, side, qty}]) exactly match one of `pkgs` (up to a uniform
// multiple)? Returns that package or null.
function matchArbSelection(sel, pkgs) {
  if (!sel.length) return null;
  for (const pkg of pkgs) {
    if (pkg.legs.length !== sel.length) continue;
    let k = null, ok = true;
    for (const l of pkg.legs) {
      const s = sel.find(x => x.name === l.name && x.side === l.side);
      if (!s) { ok = false; break; }
      const r = s.qty / l.qty;
      if (k === null) k = r; else if (Math.abs(k - r) > 1e-9) { ok = false; break; }
    }
    if (ok) return pkg;
  }
  return null;
}
