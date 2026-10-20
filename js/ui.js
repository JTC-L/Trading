// Rendering & DOM interaction layer.

const fmt = APP.util.fmt;
const fmtSigned = APP.util.fmtSigned;

function cellDomId(kind, idx, book) {
  if (kind === 'stock') return 'stockBox';
  return `cell-${kind}-${idx}${book ? '-book' : ''}`;
}

// The DOM element currently showing a cell (spread-book cells live in one of two generic slots).
function cellElement(kind, idx, book) {
  if (book) {
    const slot = APP.spreadBook.active.findIndex(a => a.kind === kind && a.idx === idx);
    return slot >= 0 ? document.getElementById(`sbCell-${slot}`) : null;
  }
  return document.getElementById(cellDomId(kind, idx, book));
}

// Shared markup for "make a market" forms — used by board/spread-book RFQ cells and the IDB
// panel. The customer always specifies a size up front (realistic: "I need a 2-way in 200 of
// the March 150 calls"), so only price is ever typed. A one-sided RFQ shows the non-solicited
// side as fixed reference text (its own existing price + size) instead of an input.
function rfqFormHtml({ isIdb, kind, idx, book, rfqSide, fixedBid, fixedBidSize, fixedAsk, fixedAskSize, volume, disabled }) {
  const dis = disabled ? 'disabled' : '';
  const action = isIdb
    ? `data-action="submit-idb-market"`
    : `data-action="submit-market" data-kind="${kind}" data-idx="${idx}" data-book="${book ? 1 : 0}"`;
  const step = tickSize();
  const bidPx = rfqSide === 'ask'
    ? `<span class="fixedpx">${fmt(fixedBid)}<small>x${fixedBidSize}</small></span>`
    : `<input type="number" step="${step}" class="rfq-bid-px" placeholder="Bid" ${dis}>`;
  const askPx = rfqSide === 'bid'
    ? `<span class="fixedpx">${fmt(fixedAsk)}<small>x${fixedAskSize}</small></span>`
    : `<input type="number" step="${step}" class="rfq-ask-px" placeholder="Ask" ${dis}>`;
  const volLabel = rfqSide === 'both' ? `Mkt for ${volume}` : rfqSide === 'bid' ? `Bid for ${volume}` : `Offer for ${volume}`;
  const mw = kind != null ? maxUserWidth(kind, idx, volume) : null;
  const maxW = mw != null ? `<small class="rfq-max">max ${mw >= 1 ? mw : fmt(mw)} wide</small>` : '';
  return `
    <div class="rfqbox">
      <div class="rfq-vol">${volLabel} ${maxW}</div>
      <div class="rfq-row">${bidPx}<span class="dash">-</span>${askPx}</div>
      <button ${action} ${dis}>Confirm</button>
      <div class="rfq-err"></div>
    </div>`;
}

// ---- order-book cells ------------------------------------------------------------
// Main-board markets look exactly like the drills' books: a staircase ladder with offers stacked on
// the right of a thick centre divider and bids on the left, every level an outlined cell with a size
// bar growing out from the divider and a square Yours / Mine button. Two levels each side, plus an
// empty level in the middle with a box on each side for quoting a new top-of-book price.

// What size fills a bar completely, per instrument.
function simMaxSize(kind) {
  if (kind === 'stock') { const m = APP.config.certaintyMode; return (m === 'stock' ? 12500 : (m === 'vol' ? 5000 : 2000)) / delta1Multiplier(); }
  return 100;
}

function simBarStyle(kind, size, side) {
  const pct = Math.min(100, Math.round(size / simMaxSize(kind) * 100));
  return side === 'bid'
    ? `background:linear-gradient(to left, rgba(34,160,80,0.34) ${pct}%, transparent ${pct}%)`
    : `background:linear-gradient(to right, rgba(214,48,48,0.30) ${pct}%, transparent ${pct}%)`;
}

// "(x40)", with your own portion called out in green when part of it is yours
function simSizeHtml(lv) {
  const total = lv.size + lv.user;
  return `<span class="sz">(x${total}${lv.user > 0 && lv.size > 0 ? `<span class="usersz"> you ${lv.user}</span>` : ''})</span>`;
}

function simHalfHtml(kind, idx, book, cell, side, level, rolling) {
  const arr = side === 'bid' ? cell.bids : cell.asks;
  const lv = arr[level];
  const kb = `data-kind="${kind}" data-idx="${idx}" data-book="${book ? 1 : 0}" data-side="${side}" data-level="${level}"`;
  if (!lv) {
    const mark = level === 0 ? (side === 'bid' ? cell.markBid : cell.markAsk) : null;
    if (mark != null) return `<td class="half ${side} has mark"><div class="hr"><span class="px">${fmt(mark)}</span></div></td>`;
    return `<td class="half ${side}"></td>`;
  }
  const takeFrozen = APP.session.boardFrozen || !running();
  const own = lv.size <= 0 && lv.user > 0; // nothing here but your own order
  const btn = own
    ? `<button class="dbtn own" data-action="own-btn" ${kb}>Pull</button>`
    : `<button class="dbtn ${side === 'bid' ? 'yours' : 'mine'}" data-action="take-btn" ${kb} ${(takeFrozen || level > 0) ? 'disabled' : ''}>${side === 'bid' ? 'Yours' : 'Mine'}</button>`;
  const px = `<span class="px">${fmt(lv.px)}</span>`;
  const inner = side === 'bid' ? simSizeHtml(lv) + px + btn : btn + px + simSizeHtml(lv);
  const roll = rolling ? ` ${side === 'bid' ? 'roll-dn' : 'roll-up'}` : '';
  return `<td class="half ${side} has${level === 0 ? ' best' : ''}${lv.user > 0 ? ' hasuser' : ''}" style="${simBarStyle(kind, lv.size + lv.user, side)}"><div class="hr${roll}">${inner}</div></td>`;
}

function bookHtml(kind, idx, book, cell) {
  const anim = cell._anim || {};
  const kb = `data-kind="${kind}" data-idx="${idx}" data-book="${book ? 1 : 0}"`;
  let rows = '';
  for (let i = 1; i >= 0; i--) { // offers: worst on top, best nearest the middle
    rows += `<tr><td class="half bid"></td><td class="mid"></td>${simHalfHtml(kind, idx, book, cell, 'ask', i, anim.ask)}</tr>`;
  }
  // the empty middle level: type a price, press Enter, then say how many
  const st = tickSize();
  rows += `<tr class="midrow"><td class="half bid has qin"><input class="px-in" type="number" step="${st}" placeholder="bid" data-side="bid" ${kb} autocomplete="off"></td>`
    + `<td class="mid"></td><td class="half ask has qin"><input class="px-in" type="number" step="${st}" placeholder="offer" data-side="ask" ${kb} autocomplete="off"></td></tr>`;
  for (let i = 0; i < 2; i++) { // bids: best nearest the middle
    rows += `<tr>${simHalfHtml(kind, idx, book, cell, 'bid', i, anim.bid)}<td class="mid"></td><td class="half ask"></td></tr>`;
  }
  return `<div class="simbook"><table class="ladder sim">${rows}</table></div>`;
}

// Everything that isn't a full order book (verticals, the spread book): just the top prices, as
//   (x100) 10.50 - 10.60 (x150)     with Yours / Mine underneath
function topLineHtml(cell) {
  const bl = cell.bids[0], al = cell.asks[0];
  const sz = (lv) => lv ? `<sub class="szs">(x${lv.size + lv.user})</sub>` : '';
  return `<div class="topline">${sz(bl)} <span class="pxr">${bl ? fmt(bl.px) : '—'} - ${al ? fmt(al.px) : '—'}</span> ${sz(al)}</div>`;
}

function cellHtml(kind, idx, book, cell) {
  const notRunning = !running();
  const takeFrozen = APP.session.boardFrozen || notRunning; // Mine/Yours: also frozen during an IDB RFQ
  const rfqFrozen = notRunning; // making a market on the board stays enabled during an IDB RFQ
  const kb = `data-kind="${kind}" data-idx="${idx}" data-book="${book ? 1 : 0}"`;

  if (cell.rfqSide) {
    return rfqFormHtml({
      isIdb: false, kind, idx, book,
      rfqSide: cell.rfqSide,
      fixedBid: cell._refBid ? cell._refBid.px : null, fixedBidSize: cell._refBid ? cell._refBid.size : null,
      fixedAsk: cell._refAsk ? cell._refAsk.px : null, fixedAskSize: cell._refAsk ? cell._refAsk.size : null,
      volume: cell.rfqVolume,
      disabled: rfqFrozen,
    });
  }
  if (levelCap(kind, book) > 1) return bookHtml(kind, idx, book, cell);

  // top prices only — with a small bid / offer box underneath to quote (improve) the market
  const st = tickSize();
  const qrow = `<div class="qrow"><input class="px-in" type="number" step="${st}" placeholder="bid" data-side="bid" ${kb} autocomplete="off">`
    + `<input class="px-in" type="number" step="${st}" placeholder="offer" data-side="ask" ${kb} autocomplete="off"></div>`;
  if (!hasLevels(cell)) {
    if (cell.status === 'indicative') return `<div class="topline mark">${cell.bid != null ? fmt(cell.bid) : '—'} - ${cell.ask != null ? fmt(cell.ask) : '—'}</div>${qrow}`;
    return `<div class="topline empty">—</div>${qrow}`;
  }
  const bl = cell.bids[0], al = cell.asks[0];
  const hasUserSize = userHasOrders(cell);
  return `
    ${topLineHtml(cell)}
    <div class="takebtns">
      <button class="dbtn yours" data-action="take" ${kb} data-side="sell" ${(takeFrozen || !bl || bl.size <= 0) ? 'disabled' : ''}>Yours</button>
      <button class="dbtn mine" data-action="take" ${kb} data-side="buy" ${(takeFrozen || !al || al.size <= 0) ? 'disabled' : ''}>Mine</button>
    </div>
    ${qrow}
    ${hasUserSize ? `<button data-action="pull" class="pullbtn" ${kb} ${takeFrozen ? 'disabled' : ''}>Pull</button>` : ''}`;
}

// Only a *new best price* rolls its side's levels (the new best pushes the rest back): bids roll down,
// offers roll up, and only the side that got the update moves. Trades and removals don't animate.
function sideRoll(side, prev, cur) {
  if (!prev || cur[0] === undefined || prev[0] === cur[0]) return false;
  if (prev[0] === undefined) return true;
  return side === 'bid' ? cur[0] > prev[0] : cur[0] < prev[0];
}

// A typed-but-unsubmitted quote (and the caret) must survive the constant re-rendering.
function captureQuoteInputs(el) {
  const saved = {};
  el.querySelectorAll('.px-in').forEach(inp => {
    saved[inp.dataset.side] = { value: inp.value, focus: document.activeElement === inp, caret: inp.selectionStart };
  });
  return saved;
}
function restoreQuoteInputs(el, saved) {
  el.querySelectorAll('.px-in').forEach(inp => {
    const s = saved[inp.dataset.side];
    if (!s) return;
    if (s.value !== '') inp.value = s.value;
    if (s.focus) { inp.focus(); try { inp.setSelectionRange(s.caret, s.caret); } catch (e) { /* number inputs don't expose a caret */ } }
  });
}

function renderCellDom(kind, idx, book) {
  const cell = getCell(kind, idx, book);
  const el = cellElement(kind, idx, book);
  if (!el || !cell) return;
  el.classList.toggle('rfq-active', !!cell.rfqSide);
  if (cell.rfqSide && cell._domRfq) return; // don't clobber in-progress typing
  cell._domRfq = !!cell.rfqSide;

  const sig = { bids: cell.bids.map(l => l.px), asks: cell.asks.map(l => l.px) };
  cell._anim = { bid: sideRoll('bid', el._sig && el._sig.bids, sig.bids), ask: sideRoll('ask', el._sig && el._sig.asks, sig.asks) };
  el._sig = sig;

  const singlePrice = levelCap(kind, book) === 1 && !cell.rfqSide;
  const priceChanged = singlePrice && cell.status === 'live' && cell._domStatus === 'live' &&
    (el.dataset.lastBid !== String(cell.bid) || el.dataset.lastAsk !== String(cell.ask));
  cell._domStatus = cell.status;
  const html = (kind === 'stock' ? `<div class="ih">${delta1Name()}</div>` : '') + cellHtml(kind, idx, book, cell);
  // nothing changed on screen: leave the DOM alone (keeps animations running and typing undisturbed)
  const key = html.replace(/ roll-(?:dn|up)/g, '');
  if (key === el._htmlKey && !cell._anim.bid && !cell._anim.ask) return;
  const saved = captureQuoteInputs(el);
  el.innerHTML = html;
  el._htmlKey = key;
  restoreQuoteInputs(el, saved);
  if (singlePrice) applyLiveFlash(el, cell, priceChanged);
}

// Single-price view only: a genuine price change (not just a size change) gets a brief 2s flash.
function applyLiveFlash(el, cell, priceChanged) {
  if (cell.status !== 'live') { delete el.dataset.lastBid; delete el.dataset.lastAsk; return; }
  el.dataset.lastBid = String(cell.bid);
  el.dataset.lastAsk = String(cell.ask);
  if (!priceChanged) return;
  el.classList.remove('price-flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('price-flash');
  setTimeout(() => el.classList.remove('price-flash'), 2000);
}

// ---- 3-second border flashes: the flow panel and the market where something just happened -----

function flashEl(el, color) {
  if (!el) return;
  ['flash-red', 'flash-green'].forEach(c => el.classList.remove(c));
  void el.offsetWidth; // restart the animation
  el.classList.add(`flash-${color}`);
  clearTimeout(el._flashT);
  el._flashT = setTimeout(() => el.classList.remove(`flash-${color}`), 3000);
}
function flashFlowPanel(color) { flashEl(document.getElementById('flowSection'), color); }
function flashCell(kind, idx, book, color) { flashEl(cellElement(kind, idx, book), color); }

// ---- board skeleton ------------------------------------------------------------

function buildSkeleton() {
  const strikes = APP.market.strikes;
  const N = strikes.length;
  const future = isFutureMode();

  const board = document.getElementById('boardArea');
  board.className = `n-${N}${APP.config.bookView ? ' bookview' : ''}${future ? ' future-mode' : ''}`;

  document.getElementById('rcBox').classList.toggle('hidden', future);
  document.getElementById('rcBox').innerHTML = `
    <div class="rc-label">R/C</div>
    <div class="rc-value">${fmtSigned(APP.market.rc)}</div>`;
  document.getElementById('stockBox').innerHTML = '';
  const sb = document.getElementById('stockBox');
  sb._sig = null;
  sb._htmlKey = null;

  const cols = future
    ? { callSpread: 1, call: 2, strike: 3, put: 4, putSpread: 5, straddle: 6 }
    : { ps: 1, callSpread: 2, call: 3, strike: 4, put: 5, putSpread: 6, bw: 7 };
  // the books need width (they're ladders), so the strike column and the spread gutters stay slim
  const tmpl = future ? '0.7fr 1fr 0.45fr 1fr 0.7fr 1fr' : '1fr 0.7fr 1fr 0.5fr 1fr 0.7fr 1fr';
  const mainRow = document.getElementById('mainRow');
  const colHeaders = document.getElementById('colHeaders');
  mainRow.style.gridTemplateColumns = tmpl;
  mainRow.style.gridTemplateRows = `repeat(${N}, minmax(0, 1fr))`;
  colHeaders.style.gridTemplateColumns = tmpl;

  let main = '';
  const mk = (kind, i, extraCls, rowStyle) => `<div class="cell ${extraCls || ''}" id="cell-${kind}-${i}" style="grid-column:${cols[kind]}; ${rowStyle || `grid-row:${i + 1};`}"></div>`;
  (future ? ['call', 'put', 'straddle'] : ['ps', 'call', 'put', 'bw']).forEach(kind => {
    for (let i = 0; i < N; i++) main += mk(kind, i);
  });
  for (let i = 0; i < N - 1; i++) {
    main += mk('callSpread', i, 'spreadcell callSpreadItem', `grid-row:${i + 1} / span 2;`);
    main += mk('putSpread', i, 'spreadcell putSpreadItem', `grid-row:${i + 1} / span 2;`);
  }
  for (let i = 0; i < N; i++) main += `
    <div class="strikecell" style="grid-column:${cols.strike}; grid-row:${i + 1};">
      <div class="strikeval">${strikes[i]}</div>
      <div class="calldelta" id="callDelta-${i}"></div>
      <div class="strikevega" id="strikeVega-${i}"></div>
    </div>`;
  mainRow.innerHTML = main;

  const hdr = future
    ? ['', 'Calls', 'Strikes', 'Puts', '', 'Straddles']
    : ['P + S', '', 'Calls', 'Strikes', 'Puts', '', 'B/W'];
  colHeaders.innerHTML = hdr.map((h, i) => `<div style="grid-column:${i + 1}">${h}</div>`).join('');

  document.getElementById('spreadBookRow').innerHTML = `
    <div class="spreadbook-item"><div class="spreadbook-label" id="sbLabel-0">—</div><div class="cell" id="sbCell-0"><div class="px empty">no active market</div></div></div>
    <div class="spreadbook-item"><div class="spreadbook-label" id="sbLabel-1">—</div><div class="cell" id="sbCell-1"><div class="px empty">no active market</div></div></div>`;

  document.querySelectorAll('.callSpreadItem').forEach(el => el.classList.toggle('hidden', !APP.config.spreadsOn));
  document.querySelectorAll('.putSpreadItem').forEach(el => el.classList.toggle('hidden', !APP.config.spreadsOn));
  document.getElementById('spreadBookSection').classList.toggle('hidden', !APP.config.spreadBookOn);
  document.getElementById('idbSection').classList.toggle('hidden', !APP.config.idbOn);
  document.getElementById('positionPanel').classList.toggle('hidden', !APP.config.showPosition);

  const noBottomRow = !APP.config.spreadBookOn && !APP.config.idbOn;
  document.getElementById('sessionScreen').classList.toggle('no-bottom-row', noBottomRow);
  document.getElementById('sidePanel').classList.toggle('no-position', !APP.config.showPosition);
  const bottomRow = document.getElementById('bottomRow');
  bottomRow.classList.toggle('spread-book-only', APP.config.spreadBookOn && !APP.config.idbOn);
  bottomRow.classList.toggle('idb-only', APP.config.idbOn && !APP.config.spreadBookOn);

  updateSpreadLines();
}

function renderAll() {
  renderClock();
  const N = APP.market.strikes.length;
  renderCellDom('stock', 0, false);
  const kinds = mainOptionKinds();
  for (let i = 0; i < N; i++) {
    kinds.forEach(kind => renderCellDom(kind, i, false));
    const d = document.getElementById(`callDelta-${i}`), v = document.getElementById(`strikeVega-${i}`);
    if (d || v) {
      const g = BS.greeks(currentSpot(), APP.market.strikes[i], APP.market.T, mktR(), mktQ(), currentVol(), 'call');
      if (d) d.textContent = 'Call Δ ' + fmt(g.delta * 100);       // per contract, in shares (the position panel's units)
      if (v) v.textContent = 'Vega ' + fmt(g.vega * 100);          // per contract, per vol point
    }
  }
  if (APP.config.spreadsOn) {
    for (let i = 0; i < N - 1; i++) {
      renderCellDom('callSpread', i, false);
      renderCellDom('putSpread', i, false);
    }
  }
  if (APP.config.spreadBookOn) renderSpreadBookPanel();
  if (APP.config.idbOn) renderIDBPanel();
  renderFlow();
  if (APP.config.showPosition) renderPositionPanel();
  renderStatusBanner();
  updateSpreadLines();
}

// Spread book only ever shows up to 2 instruments (APP.spreadBook.active), each rendered into a
// generic slot rather than a fixed per-instrument DOM id.
function renderSpreadBookPanel() {
  for (let slot = 0; slot < 2; slot++) {
    const active = APP.spreadBook.active[slot];
    const labelEl = document.getElementById(`sbLabel-${slot}`);
    const cellEl = document.getElementById(`sbCell-${slot}`);
    if (!labelEl || !cellEl) continue;
    const item = cellEl.closest('.spreadbook-item');
    if (!active) {
      labelEl.textContent = '—';
      cellEl.innerHTML = `<div class="px empty">no active market</div>`;
      if (item) item.classList.remove('rfq-active');
      cellEl._slotKey = null;
      cellEl._htmlKey = null;
      continue;
    }
    const cell = spreadBookCellFor(active.kind, active.idx);
    labelEl.textContent = describeInstrument(active.kind, active.idx, false);
    if (item) item.classList.toggle('rfq-active', !!cell.rfqSide);
    const key = `${active.kind}_${active.idx}`;
    if (cell.rfqSide && cell._domSlotRfq && cellEl._slotKey === key) continue; // preserve in-progress typing
    cellEl._slotKey = key;
    cell._domSlotRfq = !!cell.rfqSide;
    const priceChanged = cell.status === 'live' && cell._domSlotStatus === 'live' &&
      (cellEl.dataset.lastBid !== String(cell.bid) || cellEl.dataset.lastAsk !== String(cell.ask));
    cell._domSlotStatus = cell.status;
    const html = cellHtml(active.kind, active.idx, true, cell);
    if (html === cellEl._htmlKey) continue;
    const saved = captureQuoteInputs(cellEl); // keep a half-typed quote across re-renders
    cellEl.innerHTML = html;
    cellEl._htmlKey = html;
    restoreQuoteInputs(cellEl, saved);
    applyLiveFlash(cellEl, cell, priceChanged);
  }
}

function renderStatusBanner() {
  const el = document.getElementById('statusBanner');
  if (!el) return;
  if (APP.session.status === 'ended') el.textContent = 'Session complete.';
  else if (APP.session.status === 'running') {
    el.textContent = APP.session.boardFrozen ? 'IDB request in progress — board trading frozen.'
      : (APP.session.phase === 'setup' ? `Setting up: ${setupLeft()} to make — clock paused`
        : (APP.config.mode === 'steps' ? (APP.session.rfqActive ? 'Make the market you were asked for.' : 'Press Next step (or space) — take any price you like first.') : 'Session running.'));
  }
  else el.textContent = '';
  if (typeof setConfigDisabled === 'function') setConfigDisabled(APP.session.status === 'running');
}

// The top-left of the session bar used to repeat the configuration; it's left empty now.
function renderConfigSummary() {
  const el = document.getElementById('summaryText');
  if (!el) return;
  el.textContent = '';
  el.title = '';
}

function showScreen(name) {
  APP.ui.screen = name;
  if (name !== 'session') closeTicket();
  const ids = {
    home: 'homeScreen',
    simConfig: 'simConfigScreen',
    drillConfig: 'drillConfigScreen',
    countdown: 'countdownOverlay',
    session: 'sessionScreen',
    drill: 'drillScreen',
    drillResults: 'drillResultsScreen',
    simResults: 'simResultsScreen',
  };
  Object.entries(ids).forEach(([key, id]) => {
    document.getElementById(id).classList.toggle('hidden', key !== name);
  });
  // the Explain button belongs to a drill in progress (it sits outside the screen so it isn't scaled)
  const ex = document.getElementById('explainBtn');
  if (ex) ex.classList.toggle('hidden', name !== 'drill' || !APP.drill || !APP.drill.last);
  if (name !== 'drill' && typeof closeExplain === 'function' && APP.drill && APP.drill.paused) closeExplain(true);
}

function renderClock() {
  const el = document.getElementById('sessionClock');
  if (!el) return;
  const bar = document.getElementById('clockBar');
  const nextBtn = document.getElementById('nextStepBtn');
  const stepMode = APP.config.mode === 'steps';
  if (nextBtn) nextBtn.classList.toggle('hidden', !stepMode);
  if (stepMode) {
    const total = APP.config.steps, n = APP.session.step;
    const setup = APP.session.phase === 'setup';
    el.textContent = setup ? 'Set-up' : `Step ${n} / ${total}`;
    if (bar) bar.style.width = `${setup ? 0 : 100 * n / total}%`;
    if (nextBtn) {
      const waiting = !running() || setup || !!APP.session.rfqActive || APP.session.boardFrozen;
      nextBtn.disabled = waiting;
      nextBtn.textContent = n >= total ? 'Finish' : 'Next step ▶';
      nextBtn.title = setup ? 'Make the board first' : (APP.session.rfqActive ? 'Make the market you were asked for first' : 'Bring in the next event (space)');
    }
    return;
  }
  const total = APP.market.lenSec;
  const rem = Math.max(0, total - APP.session.elapsedSec);
  const mm = Math.floor(rem / 60), ss = Math.floor(rem % 60);
  el.textContent = `${mm}:${ss.toString().padStart(2, '0')}`;
  if (bar) bar.style.width = `${100 * (1 - rem / total)}%`;
}

function renderIDBPanel() {
  const active = APP.idb.active;
  const box = document.getElementById('idbActive');
  document.getElementById('idbSection').classList.toggle('rfq-active', !!active && active.status === 'awaiting_market');
  if (active) {
    if (active.status === 'awaiting_market' && APP.idb._domStatus === 'awaiting_market') {
      // preserve in-progress typing
    } else {
      APP.idb._domStatus = active.status;
      if (active.status === 'awaiting_market') {
        box.innerHTML = `
          <div class="idb-request">RFQ from IDB: make a market in <b>${describeInstrument(active.kind, active.idx)}</b></div>
          ${rfqFormHtml({
            isIdb: true, kind: active.kind, idx: active.idx, rfqSide: active.rfqSide,
            fixedBid: active.fixedBid, fixedBidSize: active.fixedBidSize,
            fixedAsk: active.fixedAsk, fixedAskSize: active.fixedAskSize,
            volume: active.rfqVolume,
            disabled: false,
          })}`;
      } else {
        box.innerHTML = `
          <div class="idb-request">Quoted <b>${describeInstrument(active.kind, active.idx)}</b>: ${fmt(active.bid)} x${active.bidSize} - ${fmt(active.ask)} x${active.askSize}</div>
          <div class="pending">awaiting customer decision…</div>`;
      }
    }
  } else {
    APP.idb._domStatus = null;
    box.innerHTML = `<div class="idb-idle">No active IDB request.</div>`;
  }
  const log = document.getElementById('idbLog');
  log.innerHTML = APP.idb.log.slice(0, 2).map(e => {
    const mm = Math.floor(e.ts / 60), ss = Math.floor(e.ts % 60);
    return `<div class="idb-logrow">[${mm}:${ss.toString().padStart(2, '0')}] ${e.text}</div>`;
  }).join('');
}

// ---- flow panel & toasts -----------------------------------------------------

// Every trade and every more-competitive customer price, newest first:
//   red = a trade with you, yellow = a trade between others, blue = you took a price,
//   green = a customer improved / posted a price.
function renderFlow() {
  const el = document.getElementById('flow');
  if (!el) return;
  // Step by step this is the Trading History: every completed step (newest first, tagged #1, #2 ...) and
  // everything you did between steps (tagged You). Timed sessions keep the plain Flow log.
  const steps = APP.config.mode === 'steps';
  const title = document.querySelector('#flowSection h2');
  if (title) title.textContent = steps ? 'Trading History' : 'Flow';
  const html = APP.history.slice(0, steps ? 300 : 80).map(h => {
    const mm = Math.floor(h.ts / 60), ss = Math.floor(h.ts % 60);
    const when = h.mine ? 'You' : (h.step != null ? (h.step > 0 ? `#${h.step}` : '·') : `${mm}:${ss.toString().padStart(2, '0')}`);
    return `<div class="flowbox flow-${h.color}${h.mine ? ' flow-mine' : ''}"><span class="flow-time">${when}</span> ${h.text}</div>`;
  }).join('');
  if (html === el._html) return;
  el._html = html;
  el.innerHTML = html;
}

function toast(text) {
  const el = document.getElementById('toasts');
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'toast';
  div.textContent = text;
  el.appendChild(div);
  setTimeout(() => div.remove(), 3800);
}

// ---- order ticket: take a level / rest an order / manage your own ----------------

function closeTicket() {
  APP.ui.ticket = null;
  const t = document.getElementById('ticket');
  if (t) { t.classList.add('hidden'); t.innerHTML = ''; }
}

function ticketHtml(t) {
  const desc = describeInstrument(t.kind, t.idx, t.book);
  const chips = [5, 10, 25, 50, 100].map(v => `<button class="tk-chip" data-action="tk-size" data-v="${v}">${v}</button>`).join('')
    + (t.maxQty ? `<button class="tk-chip" data-action="tk-size" data-v="${t.maxQty}">Max</button>` : '');
  if (t.mode === 'take') {
    const verb = t.side === 'buy' ? 'Buy' : 'Sell';
    return `
      <div class="tk-title">${verb} ${desc} @ <b>${fmt(t.px)}</b></div>
      <div class="tk-sub">${t.maxQty} available</div>
      <div class="tk-row"><label>Size <input id="tkSize" type="number" min="1" step="1" value="${t.defaultQty}"></label></div>
      <div class="tk-chips">${chips}</div>
      <div class="tk-row"><button class="tk-go" data-action="tk-confirm">${verb}</button>
        ${t.ownSize > 0 ? `<button data-action="tk-cancel-own">Pull my ${t.ownSize}</button>` : ''}
        <button data-action="tk-close">Close</button></div>
      <div class="tk-err" id="tkErr"></div>`;
  }
  if (t.mode === 'place') {
    return `
      <div class="tk-title">New ${t.side === 'bid' ? 'bid' : 'offer'} in ${desc}</div>
      <div class="tk-row"><label>Price <input id="tkPx" type="number" step="${tickSize()}" value="${t.defaultPx != null ? fmt(t.defaultPx) : ''}"></label>
        <label>Size <input id="tkSize" type="number" min="1" step="1" value="${t.defaultQty}"></label></div>
      <div class="tk-chips">${chips}</div>
      <div class="tk-row"><button class="tk-go" data-action="tk-confirm">Confirm</button><button data-action="tk-close">Close</button></div>
      <div class="tk-err" id="tkErr"></div>`;
  }
  return `
    <div class="tk-title">Your ${t.side === 'bid' ? 'bid' : 'offer'} in ${desc}</div>
    <div class="tk-sub">${t.ownSize} @ ${fmt(t.px)}</div>
    <div class="tk-row"><button class="tk-go" data-action="tk-cancel-own">Pull market</button><button data-action="tk-close">Close</button></div>
    <div class="tk-err" id="tkErr"></div>`;
}

function openTicket(t, anchorEl) {
  APP.ui.ticket = t;
  const el = document.getElementById('ticket');
  el.innerHTML = ticketHtml(t);
  el.classList.remove('hidden');
  const r = anchorEl.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = r.left + r.width / 2 - w / 2, top = r.bottom + 4;
  if (top + h > window.innerHeight - 6) top = Math.max(6, r.top - h - 4);
  left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const first = el.querySelector('#tkPx') || el.querySelector('#tkSize');
  if (first) { first.focus(); first.select(); }
}

// Clicking Yours / Mine on a book's best price opens the size ticket (you take that price, up to the
// other participants' size there). Clicking Pull on a level that's only yours opens the pull ticket.
function onTakeBtn(btn) {
  if (!running()) return;
  const d = btn.dataset;
  const kind = d.kind, idx = parseInt(d.idx, 10), book = d.book === '1', side = d.side;
  const cell = getCell(kind, idx, book);
  if (!cell || cell.rfqSide) return;
  const lvl = (side === 'bid' ? cell.bids : cell.asks)[0];
  if (!lvl || lvl.size <= 0) return;
  openTicket({
    mode: 'take', kind, idx, book, side: side === 'bid' ? 'sell' : 'buy', // Yours hits the bid, Mine lifts the offer
    px: lvl.px, maxQty: lvl.size, ownSize: lvl.user,
    defaultQty: kind === 'stock' ? Math.min(lvl.size, isFutureMode() ? 10 : 100) : lvl.size,
  }, btn);
}

function onOwnBtn(btn) {
  if (!running()) return;
  const d = btn.dataset;
  const kind = d.kind, idx = parseInt(d.idx, 10), book = d.book === '1', side = d.side, level = parseInt(d.level, 10);
  const cell = getCell(kind, idx, book);
  const lvl = cell && (side === 'bid' ? cell.bids : cell.asks)[level];
  if (!lvl) return;
  openTicket({ mode: 'own', kind, idx, book, side, px: lvl.px, ownSize: lvl.user }, btn);
}

// A price typed into the empty middle level: press Enter, then the ticket asks how many.
function onQuoteEnter(inp) {
  if (!running()) return;
  const px = parseFloat(inp.value);
  if (isNaN(px)) { toast('Type a price first.'); return; }
  const d = inp.dataset;
  const kind = d.kind, idx = parseInt(d.idx, 10), book = d.book === '1';
  openTicket({ mode: 'place', kind, idx, book, side: d.side, defaultPx: px, defaultQty: kind === 'stock' ? (isFutureMode() ? 10 : 100) : 20 }, inp);
}

function ticketConfirm() {
  const t = APP.ui.ticket;
  if (!t) return;
  const errEl = document.getElementById('tkErr');
  const size = parseInt(document.getElementById('tkSize').value, 10);
  let res;
  if (t.mode === 'take') res = executeUserTake(t.kind, t.idx, t.book, t.side, size);
  else res = placeUserOrder(t.kind, t.idx, t.book, t.side, parseFloat(document.getElementById('tkPx').value), size);
  if (res.error) { errEl.textContent = res.error; return; }
  if (t.mode === 'place') { // the quote went in: empty the box it came from
    document.querySelectorAll('.px-in').forEach(inp => {
      const d = inp.dataset;
      if (d.kind === t.kind && parseInt(d.idx, 10) === t.idx && (d.book === '1') === !!t.book && d.side === t.side) inp.value = '';
    });
  }
  closeTicket();
}

// ---- fitting the session screen to the window ---------------------------------------
// The session screen is a rigid set of proportions designed for at least REF_W x REF_H. In a smaller
// window (or a zoomed-in browser) the boxes would shrink while the text in them didn't, and things got
// cut off. So below that size the whole screen is laid out at the reference size and scaled down to fit.
const SESSION_REF_W = 1400, SESSION_REF_H = 900;
function appScale() { return APP.ui.scale || 1; }
function fitSession() {
  const s = Math.max(0.35, Math.min(1, window.innerWidth / SESSION_REF_W, window.innerHeight / SESSION_REF_H));
  APP.ui.scale = s;
  document.documentElement.style.setProperty('--s', s.toFixed(4));
  if (typeof updateSpreadLines === 'function') updateSpreadLines();
}

// ---- call/put spread connector lines -----------------------------------------

// sourceYFrac picks where within the (small, fixed-height) spread box the line starts — using a
// point close to the target row's edge, rather than the box's shared center, keeps the line from
// swinging through a steep angle toward each of its two calls/puts.
function lineBetween(idA, idB, crect, sideA, sideB, sourceYFrac) {
  const a = document.getElementById(idA), b = document.getElementById(idB);
  if (!a || !b || a.classList.contains('hidden') || b.classList.contains('hidden')) return '';
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  const s = appScale(); // the session screen may be scaled to fit the window: the SVG draws in its own, unscaled units
  const x1 = ((sideA === 'right' ? ra.right : ra.left) - crect.left) / s;
  const y1 = (ra.top + ra.height * sourceYFrac - crect.top) / s;
  const x2 = ((sideB === 'left' ? (rb.left + rb.width * 0.22) : (rb.right - rb.width * 0.22)) - crect.left) / s;
  const y2 = (rb.top + rb.height / 2 - crect.top) / s;
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" />`;
}

function updateSpreadLines() {
  const svg = document.getElementById('spreadLinesSvg');
  const wrap = document.getElementById('boardGridWrap');
  if (!svg || !wrap) return;
  if (!APP.config.spreadsOn) { svg.innerHTML = ''; return; }
  const crect = wrap.getBoundingClientRect();
  svg.setAttribute('width', crect.width / appScale());
  svg.setAttribute('height', crect.height / appScale());
  let html = '';
  for (let i = 0; i < APP.market.strikes.length - 1; i++) {
    html += lineBetween(`cell-callSpread-${i}`, `cell-call-${i}`, crect, 'right', 'left', 0.25);
    html += lineBetween(`cell-callSpread-${i}`, `cell-call-${i + 1}`, crect, 'right', 'left', 0.75);
    html += lineBetween(`cell-putSpread-${i}`, `cell-put-${i}`, crect, 'left', 'right', 0.25);
    html += lineBetween(`cell-putSpread-${i}`, `cell-put-${i + 1}`, crect, 'left', 'right', 0.75);
  }
  svg.innerHTML = html;
}

// ---- position panel: expiry payoff + today's Black-Scholes curve, plus greeks ------

function renderPositionPanel() {
  const canvas = document.getElementById('payoffChart');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // centred on the strikes, reaching only a little (10) beyond the outermost ones either side
  const spot = currentSpot();
  const strikes = APP.market.strikes;
  const margin = Math.max(10, 2 * APP.market.incr);
  const lo = Math.min(...strikes) - margin, hi = Math.max(...strikes) + margin;
  const N = 120;
  const has = hasPosition();
  const expiry = [], today = [];
  for (let i = 0; i <= N; i++) {
    const ST = lo + (hi - lo) * i / N;
    expiry.push([ST, has ? payoffAt(ST) : 0]);
    today.push([ST, has ? bsPnlAt(ST) : 0]);
  }
  const vals = expiry.concat(today).map(p => p[1]);
  const minV = Math.min(0, ...vals), maxV = Math.max(0, ...vals);
  const pad = 30;
  const xScale = (ST) => pad + (W - 2 * pad) * (ST - lo) / (hi - lo);
  const yScale = (v) => H - pad - (H - 2 * pad) * (v - minV) / ((maxV - minV) || 1);

  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, yScale(0)); ctx.lineTo(W - pad, yScale(0)); ctx.stroke();
  // faint verticals at each strike (labelled below), a dashed one at the spot price
  ctx.strokeStyle = '#e4e4e4';
  strikes.forEach(K => { ctx.beginPath(); ctx.moveTo(xScale(K), pad); ctx.lineTo(xScale(K), H - pad); ctx.stroke(); });
  if (spot >= lo && spot <= hi) {
    ctx.beginPath();
    ctx.moveTo(xScale(spot), pad); ctx.lineTo(xScale(spot), H - pad); ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#999'; ctx.stroke(); ctx.setLineDash([]);
  }

  const trace = (pts, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    pts.forEach(([ST, v], i) => {
      const x = xScale(ST), y = yScale(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  trace(today, '#f59e0b', 2);
  trace(expiry, '#2563eb', 2);

  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#666';
  ctx.textAlign = 'center';
  strikes.forEach(K => ctx.fillText(String(K), xScale(K), H - 12));
  ctx.textAlign = 'left';
  if (spot >= lo && spot <= hi) ctx.fillText(`spot ${fmt(spot)}`, xScale(spot) + 4, pad + 10);
  ctx.fillStyle = '#2563eb'; ctx.fillText('— Expiry', pad, 14);
  ctx.fillStyle = '#f59e0b'; ctx.fillText('— Today (BS)', pad + 64, 14);

  const g = currentGreeksTotal();
  document.getElementById('greeksRow').innerHTML = `
    <div><span>Delta</span><b>${fmt(g.delta)}</b></div>
    <div><span>Gamma</span><b>${fmt(g.gamma)}</b></div>
    <div><span>Vega</span><b>${fmt(g.vega)}</b></div>
    <div><span>Theta</span><b>${fmt(g.theta)}</b></div>`;
}

// ---- event delegation --------------------------------------------------------

function bindEvents() {
  document.getElementById('app').addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    const inTicket = e.target.closest('#ticket');
    if (!inTicket) closeTicket();
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'take-btn') {
      onTakeBtn(target);
    } else if (action === 'own-btn') {
      onOwnBtn(target);
    } else if (action === 'tk-close') {
      closeTicket();
    } else if (action === 'tk-confirm') {
      ticketConfirm();
    } else if (action === 'tk-size') {
      const inp = document.getElementById('tkSize');
      if (inp) inp.value = target.dataset.v;
    } else if (action === 'tk-cancel-own') {
      const t = APP.ui.ticket;
      if (t) {
        const bookSide = t.mode === 'own' ? t.side : (t.side === 'buy' ? 'ask' : 'bid');
        closeTicket();
        pullUserMarkets(t.kind, t.idx, t.book, bookSide);
      }
    } else if (action === 'take') {
      const { kind, idx, book, side } = target.dataset;
      handleTake(kind, parseInt(idx, 10), book === '1', side);
    } else if (action === 'pull') {
      const { kind, idx, book } = target.dataset;
      handlePull(kind, parseInt(idx, 10), book === '1');
    } else if (action === 'submit-market') {
      const { kind, idx, book } = target.dataset;
      const cell = getCell(kind, parseInt(idx, 10), book === '1');
      const box = target.closest('.rfqbox');
      const bidInput = box.querySelector('.rfq-bid-px');
      const askInput = box.querySelector('.rfq-ask-px');
      const bid = bidInput ? parseFloat(bidInput.value) : (cell._refBid ? cell._refBid.px : NaN);
      const ask = askInput ? parseFloat(askInput.value) : (cell._refAsk ? cell._refAsk.px : NaN);
      const bidSize = bidInput ? cell.rfqVolume : (cell._refBid ? cell._refBid.size : 0);
      const askSize = askInput ? cell.rfqVolume : (cell._refAsk ? cell._refAsk.size : 0);
      const res = submitMarket(kind, parseInt(idx, 10), book === '1', bid, ask, bidSize, askSize, false);
      if (res.error) box.querySelector('.rfq-err').textContent = res.error;
    } else if (action === 'submit-idb-market') {
      const active = APP.idb.active;
      const box = target.closest('.rfqbox');
      const bidInput = box.querySelector('.rfq-bid-px');
      const askInput = box.querySelector('.rfq-ask-px');
      const bid = bidInput ? parseFloat(bidInput.value) : active.fixedBid;
      const ask = askInput ? parseFloat(askInput.value) : active.fixedAsk;
      const bidSize = bidInput ? active.rfqVolume : active.fixedBidSize;
      const askSize = askInput ? active.rfqVolume : active.fixedAskSize;
      const res = submitMarket(active.kind, active.idx, false, bid, ask, bidSize, askSize, true);
      if (res.error) box.querySelector('.rfq-err').textContent = res.error;
    }
  });
  document.getElementById('nextStepBtn').addEventListener('click', () => advanceStep());
  document.addEventListener('keydown', (e) => {
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON');
    if (e.key === ' ' && !typing && APP.ui.screen === 'session' && APP.config.mode === 'steps') { e.preventDefault(); advanceStep(); return; }
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('px-in')) { onQuoteEnter(e.target); return; }
    if (!APP.ui.ticket) return;
    if (e.key === 'Escape') closeTicket();
    else if (e.key === 'Enter' && e.target.closest && e.target.closest('#ticket')) ticketConfirm();
  });
  window.addEventListener('resize', fitSession);
  fitSession();
}
