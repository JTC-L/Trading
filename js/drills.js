// Put-call parity speed drill (Zetamac-style).
//
// Model: for a fixed strike K and fixed carry rc, parity says C - P = S - K + rc. Writing
// D = C - P = S - K + rc and T = C + P (the straddle), every displayable quantity is an affine
// function of (D, T). P+S and B/W are quoted the way a floor combo actually trades — relative to
// the strike, not as a raw stock-scale dollar sum — so they reduce to a clean offset of their
// paired option with no strike needed at all:
//   stock    =  D            + (K-rc)
//   call     =  0.5D + 0.5T
//   put      = -0.5D + 0.5T
//   ps       =  0.5D + 0.5T  - rc            (= call - rc; true stock+put cost is ps + K)
//   bw       = -0.5D + 0.5T  + rc            (= put + rc;  true stock-call debit is K - bw)
//   straddle =        T
//   combo    = |D|                            (never shown as a given — see below)
//
// Every quantity belongs to one of four families — {stock}, {call,ps}, {put,bw}, {straddle} —
// grouped by which two are "the same fact restated" (e.g. ps = call - rc, no solving needed,
// and no strike needed either). Two quantities from *different* families always pin down (D,T)
// uniquely via a 2x2 linear solve, which is enough to derive anything else, including combo.
// That 2x2 solve is also what lets a target be read off just {stock, one option} — e.g. for
// straddle: V = 2P + (S-K) + rc, or V = 2C - (S-K) - rc — since stock fixes D and the option
// then fixes T. Combo is deliberately never used as a *given*, since |D| alone can't tell you
// the sign of D and would make some puzzles unsolvable.

const DRILL_DEF = {
  stock: { a: 1, b: 0 },
  call: { a: 0.5, b: 0.5 },
  put: { a: -0.5, b: 0.5 },
  ps: { a: 0.5, b: 0.5 },
  bw: { a: -0.5, b: 0.5 },
  straddle: { a: 0, b: 1 },
};

const DRILL_FAMILIES = {
  stock: ['stock'],
  call: ['call', 'ps'],
  put: ['put', 'bw'],
  straddle: ['straddle'],
};

function drillConst(key, K, rc) {
  // the constant term of each quantity's affine formula (0 for call/put/straddle)
  if (key === 'stock') return K - rc;
  if (key === 'ps') return -rc;
  if (key === 'bw') return rc;
  return 0;
}

function drillFamilyOf(key) {
  return Object.keys(DRILL_FAMILIES).find(f => DRILL_FAMILIES[f].includes(key));
}

function drillPartner(key) {
  if (key === 'call') return 'ps';
  if (key === 'ps') return 'call';
  if (key === 'put') return 'bw';
  if (key === 'bw') return 'put';
  return null;
}

// Picks two givens from two distinct families (one representative each) — guarantees a solvable,
// non-redundant pair every time, and gives the {stock, single option} case (see comment above) a
// real, guaranteed share rather than leaving it to chance.
function pickTwoFamilyGivens(familyNames) {
  const shuffled = familyNames.slice().sort(() => Math.random() - 0.5);
  const g1 = APP.util.choice(DRILL_FAMILIES[shuffled[0]]);
  const g2 = APP.util.choice(DRILL_FAMILIES[shuffled[1]]);
  return Math.random() < 0.5 ? [g1, g2] : [g2, g1];
}

// Picks a minimal-but-sufficient set of "given" quantities (never including combo) for `target`.
function chooseDrillGivens(target) {
  if (target === 'combo') {
    if (Math.random() < 0.4) return ['stock']; // |D| reads straight off stock, no ambiguity
    return pickTwoFamilyGivens(['stock', 'call', 'put', 'straddle']);
  }
  const partner = drillPartner(target);
  if (partner && Math.random() < 0.35) return [partner];
  const otherFamilies = Object.keys(DRILL_FAMILIES).filter(f => f !== drillFamilyOf(target));
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

// Bag randomizer for the target: shuffle all 7 kinds, hand them out one at a time, reshuffle once
// empty. Guarantees every kind appears once per 7 questions instead of long same-kind streaks.
function nextDrillTarget() {
  if (!APP.drill.targetBag || APP.drill.targetBag.length === 0) {
    APP.drill.targetBag = ['stock', 'call', 'put', 'bw', 'ps', 'straddle', 'combo']
      .sort(() => Math.random() - 0.5);
  }
  return APP.drill.targetBag.pop();
}

function generateDrillQuestion() {
  const K = APP.util.choice([60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140]);

  // Ground the scenario in real (pseudo) Black-Scholes pricing, the same engine the simulation
  // uses, so Call/Put behave like genuine option prices — comfortably positive and sensibly
  // scaled to moneyness/vol/time — rather than being sampled out of thin air. r and q are each
  // randomized independently (q can exceed r), which is also what lets the implied carry rc come
  // out negative, same as a high-dividend name would in real life.
  const spotSeed = K * APP.util.rand(0.85, 1.15);
  const vol = APP.util.rand(0.15, 0.45);
  const yrs = APP.util.rand(10, 90) / 365;
  const r = APP.util.rand(0.02, 0.05);
  const q = APP.util.rand(0, 0.08);

  const callTrue = BS.price(spotSeed, K, yrs, r, q, vol, 'call');
  const putTrue = BS.price(spotSeed, K, yrs, r, q, vol, 'put');

  let D = Math.round((callTrue - putTrue) * 10) / 10; // multiple of 0.1 (so C,P land on 0.05)
  let T = Math.round((callTrue + putTrue) * 10) / 10; // multiple of 0.1
  if (T <= Math.abs(D) + 0.1) T = Math.abs(D) + 0.5;  // guard against a rounded-away straddle

  const rc = Math.round((spotSeed * (Math.exp((r - q) * yrs) - 1)) * 20) / 20; // multiple of 0.05

  const values = {};
  Object.keys(DRILL_DEF).forEach(k => {
    const d = DRILL_DEF[k];
    values[k] = Math.round((d.a * D + d.b * T + drillConst(k, K, rc)) * 100) / 100;
  });
  values.combo = Math.round(Math.abs(D) * 100) / 100;

  const target = nextDrillTarget();
  const givens = chooseDrillGivens(target);
  const answer = Math.round(solveDrillTarget(target, givens, values, K, rc) * 100) / 100;

  return { K, rc, values, target, givens, answer };
}

// ---- drill session lifecycle --------------------------------------------------

APP.drill = {
  score: 0,
  totalSec: 120,
  remainingSec: 120,
  question: null,
  timerId: null,
  targetBag: [],
};

function drillShowFor(key) {
  const q = APP.drill.question;
  if (key === q.target) return '?';
  if (q.givens.includes(key)) return APP.util.fmt(q.values[key]);
  return '—';
}

function renderDrillQuestion() {
  const q = APP.drill.question;
  document.getElementById('drillStock').textContent = drillShowFor('stock');
  document.getElementById('drillRc').textContent = APP.util.fmtSigned(q.rc);
  document.getElementById('drillStrike').textContent = q.K;
  document.getElementById('drillPS').textContent = drillShowFor('ps');
  document.getElementById('drillCall').textContent = drillShowFor('call');
  document.getElementById('drillPut').textContent = drillShowFor('put');
  document.getElementById('drillBW').textContent = drillShowFor('bw');
  document.getElementById('drillStraddle').textContent = drillShowFor('straddle');
  document.getElementById('drillCombo').textContent = drillShowFor('combo');
  document.querySelectorAll('.drill-cell').forEach(el => {
    const isTarget = el.textContent === '?';
    el.classList.toggle('drill-target', isTarget);
  });
}

function nextDrillQuestion() {
  APP.drill.question = generateDrillQuestion();
  renderDrillQuestion();
  const input = document.getElementById('drillAnswer');
  input.value = '';
  input.focus();
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
  APP.drill.score = 0;
  APP.drill.totalSec = APP.drillConfig.minutes * 60;
  APP.drill.remainingSec = APP.drill.totalSec;
  APP.drill.targetBag = [];
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

function handleDrillAnswerInput(e) {
  const q = APP.drill.question;
  if (!q) return;
  const val = parseFloat(e.target.value);
  if (isNaN(val)) return;
  if (Math.abs(val - q.answer) < 0.005) {
    APP.drill.score += 1;
    document.getElementById('drillScoreVal').textContent = String(APP.drill.score);
    nextDrillQuestion();
  }
}

function bindDrillEvents() {
  document.getElementById('drillAnswer').addEventListener('input', handleDrillAnswerInput);
}
