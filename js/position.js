// Position tracking: decompose every trade into atomic legs, then derive payoff & greeks.
//
// Convention: stock legs' qty is always in raw SHARES. Option legs' (call/put) qty is always in
// CONTRACTS, each worth 100 shares — so any dollar/greek figure derived from an option leg must
// be scaled by 100, and any stock leg synthesized out of a combo trade (B/W, P+S) must convert
// the combo's contract count into shares by the same factor.

function addTrade(kind, idx, side, qty, price) {
  // side: 'buy' | 'sell' from the user's perspective. qty > 0.
  const s = qty * (side === 'buy' ? 1 : -1);
  const strikes = APP.market.strikes;
  const legs = [];
  switch (kind) {
    case 'stock':
      legs.push({ type: 'stock', qty: s, entryPrice: price });
      break;
    case 'call':
      legs.push({ type: 'call', strike: strikes[idx], qty: s, entryPrice: price });
      break;
    case 'put':
      legs.push({ type: 'put', strike: strikes[idx], qty: s, entryPrice: price });
      break;
    case 'bw': {
      // B/W = long stock + short call, but quoted strike-relative: traded price = Put + rc, so
      // the true debit (stock - call) is K - price. Buying B/W => +stock, -call.
      const stockPx = currentSpot();
      const trueDebit = strikes[idx] - price;
      legs.push({ type: 'stock', qty: s * 100, entryPrice: stockPx });
      legs.push({ type: 'call', strike: strikes[idx], qty: -s, entryPrice: stockPx - trueDebit });
      break;
    }
    case 'ps': {
      // P+S = long stock + long put, but quoted strike-relative: traded price = Call - rc, so
      // the true cost (stock + put) is price + K. Buying P+S => +stock, +put.
      const fs = currentSpot();
      const trueCost = price + strikes[idx];
      legs.push({ type: 'stock', qty: s * 100, entryPrice: fs });
      legs.push({ type: 'put', strike: strikes[idx], qty: s, entryPrice: trueCost - fs });
      break;
    }
    case 'callSpread': {
      // buy = long lower strike call, short higher strike call
      const kLo = strikes[idx], kHi = strikes[idx + 1];
      const fcHi = fairCall(kHi);
      legs.push({ type: 'call', strike: kLo, qty: s, entryPrice: price + fcHi });
      legs.push({ type: 'call', strike: kHi, qty: -s, entryPrice: fcHi });
      break;
    }
    case 'putSpread': {
      // buy = long higher strike put, short lower strike put
      const kLo = strikes[idx], kHi = strikes[idx + 1];
      const fpLo = fairPut(kLo);
      legs.push({ type: 'put', strike: kHi, qty: s, entryPrice: price + fpLo });
      legs.push({ type: 'put', strike: kLo, qty: -s, entryPrice: fpLo });
      break;
    }
    case 'straddle': {
      // buy = long call + long put, same strike
      const K = strikes[idx];
      const fp = fairPut(K);
      legs.push({ type: 'call', strike: K, qty: s, entryPrice: price - fp });
      legs.push({ type: 'put', strike: K, qty: s, entryPrice: fp });
      break;
    }
    case 'combo': {
      // Combo is quoted as |Call - Put|, same strike — call-minus-put if the call is richer, or
      // put-minus-call if the put is richer, so that buying the combo is always a debit you pay,
      // never a credit you're paid to take on. Whichever side is richer is the long leg.
      const K = strikes[idx];
      const fc = fairCall(K), fp = fairPut(K);
      if (fc >= fp) {
        legs.push({ type: 'call', strike: K, qty: s, entryPrice: price + fp });
        legs.push({ type: 'put', strike: K, qty: -s, entryPrice: fp });
      } else {
        legs.push({ type: 'put', strike: K, qty: s, entryPrice: price + fc });
        legs.push({ type: 'call', strike: K, qty: -s, entryPrice: fc });
      }
      break;
    }
    case 'strangle': {
      // buy = long put at the lower strike, long call at the upper strike
      const [i, j] = decodePair(idx);
      const kLo = strikes[i], kHi = strikes[j];
      const fc = fairCall(kHi);
      legs.push({ type: 'put', strike: kLo, qty: s, entryPrice: price - fc });
      legs.push({ type: 'call', strike: kHi, qty: s, entryPrice: fc });
      break;
    }
    case 'riskReversal': {
      // buy = long call at the upper strike, short put at the lower strike
      const [i, j] = decodePair(idx);
      const kLo = strikes[i], kHi = strikes[j];
      const fp = fairPut(kLo);
      legs.push({ type: 'call', strike: kHi, qty: s, entryPrice: price + fp });
      legs.push({ type: 'put', strike: kLo, qty: -s, entryPrice: fp });
      break;
    }
    case 'callSpreadWide': {
      // buy = long lower strike call, short higher strike call (non-adjacent strikes)
      const [i, j] = decodePair(idx);
      const kLo = strikes[i], kHi = strikes[j];
      const fcHi = fairCall(kHi);
      legs.push({ type: 'call', strike: kLo, qty: s, entryPrice: price + fcHi });
      legs.push({ type: 'call', strike: kHi, qty: -s, entryPrice: fcHi });
      break;
    }
    case 'putSpreadWide': {
      // buy = long higher strike put, short lower strike put (non-adjacent strikes)
      const [i, j] = decodePair(idx);
      const kLo = strikes[i], kHi = strikes[j];
      const fpLo = fairPut(kLo);
      legs.push({ type: 'put', strike: kHi, qty: s, entryPrice: price + fpLo });
      legs.push({ type: 'put', strike: kLo, qty: -s, entryPrice: fpLo });
      break;
    }
  }
  legs.forEach(l => { l.time = APP.session.elapsedSec; APP.position.legs.push(l); });
}

function payoffAt(ST) {
  let total = 0;
  APP.position.legs.forEach(l => {
    if (l.type === 'stock') { total += l.qty * (ST - l.entryPrice); return; }
    const val = l.type === 'call' ? Math.max(ST - l.strike, 0) - l.entryPrice : Math.max(l.strike - ST, 0) - l.entryPrice;
    total += l.qty * 100 * val; // contracts -> shares
  });
  return total;
}

function currentGreeksTotal() {
  const S = currentSpot(), T = APP.market.T, r = APP.CONST.R, q = APP.CONST.Q, vol = currentVol();
  const tot = { delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  APP.position.legs.forEach(l => {
    if (l.type === 'stock') {
      tot.delta += l.qty;
    } else {
      const g = BS.greeks(S, l.strike, T, r, q, vol, l.type);
      const mult = l.qty * 100; // contracts -> shares
      tot.delta += mult * g.delta;
      tot.gamma += mult * g.gamma;
      tot.vega += mult * g.vega;
      tot.theta += mult * g.theta;
      tot.rho += mult * g.rho;
    }
  });
  return tot;
}

function hasPosition() { return APP.position.legs.length > 0; }

// Optional randomized starting position, generated at session start when config.startWithPosition
// is on — gives the user something to manage/hedge from minute one.
function generateStartingPosition() {
  const n = APP.util.randInt(1, 2);
  const strikes = APP.market.strikes;
  for (let i = 0; i < n; i++) {
    const kind = APP.util.choice(['stock', 'call', 'put']);
    const lots = APP.util.choice([5, 10, 15, 20]);
    const sign = Math.random() < 0.5 ? -1 : 1;
    if (kind === 'stock') {
      APP.position.legs.push({ type: 'stock', qty: lots * 100 * sign, entryPrice: APP.util.round5c(currentSpot()), time: 0 });
    } else {
      const strike = APP.util.choice(strikes);
      const price = kind === 'call' ? fairCall(strike) : fairPut(strike);
      APP.position.legs.push({ type: kind, strike, qty: lots * sign, entryPrice: APP.util.round5c(price), time: 0 });
    }
  }
}
