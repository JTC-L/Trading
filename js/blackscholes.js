// Black-Scholes pricing & greeks for European options on a non-dividend-adjusted-at-strike basis.
const BS = (function () {
  function normPDF(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }

  // Abramowitz & Stegun approximation for the standard normal CDF.
  function normCDF(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
      a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
  }

  function d1d2(S, K, T, r, q, vol) {
    const vst = vol * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r - q + 0.5 * vol * vol) * T) / vst;
    const d2 = d1 - vst;
    return [d1, d2];
  }

  function price(S, K, T, r, q, vol, type) {
    const [d1, d2] = d1d2(S, K, T, r, q, vol);
    const eqT = Math.exp(-q * T), erT = Math.exp(-r * T);
    if (type === 'call') {
      return S * eqT * normCDF(d1) - K * erT * normCDF(d2);
    } else {
      return K * erT * normCDF(-d2) - S * eqT * normCDF(-d1);
    }
  }

  function greeks(S, K, T, r, q, vol, type) {
    const [d1, d2] = d1d2(S, K, T, r, q, vol);
    const eqT = Math.exp(-q * T), erT = Math.exp(-r * T);
    const pdf1 = normPDF(d1);
    const gamma = (eqT * pdf1) / (S * vol * Math.sqrt(T));
    const vega = S * eqT * pdf1 * Math.sqrt(T) / 100; // per 1 vol point (1%)
    let delta, theta, rho;
    if (type === 'call') {
      delta = eqT * normCDF(d1);
      theta = (-(S * eqT * pdf1 * vol) / (2 * Math.sqrt(T))
        - r * K * erT * normCDF(d2)
        + q * S * eqT * normCDF(d1)) / 365;
      rho = (K * T * erT * normCDF(d2)) / 100;
    } else {
      delta = -eqT * normCDF(-d1);
      theta = (-(S * eqT * pdf1 * vol) / (2 * Math.sqrt(T))
        + r * K * erT * normCDF(-d2)
        - q * S * eqT * normCDF(-d1)) / 365;
      rho = (-K * T * erT * normCDF(-d2)) / 100;
    }
    return { delta, gamma, vega, theta, rho };
  }

  function priceAndGreeks(S, K, T, r, q, vol, type) {
    const p = price(S, K, T, r, q, vol, type);
    const g = greeks(S, K, T, r, q, vol, type);
    return Object.assign({ price: p }, g);
  }

  return { normCDF, normPDF, price, greeks, priceAndGreeks };
})();
