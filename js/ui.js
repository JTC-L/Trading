// Rendering & DOM interaction layer.

const fmt = APP.util.fmt;
const fmtSigned = APP.util.fmtSigned;

function cellDomId(kind, idx, book) {
  if (kind === 'stock') return 'stockBox';
  return `cell-${kind}-${idx}${book ? '-book' : ''}`;
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
  const bidPx = rfqSide === 'ask'
    ? `<span class="fixedpx">${fmt(fixedBid)}<small>x${fixedBidSize}</small></span>`
    : `<input type="number" step="0.05" class="rfq-bid-px" placeholder="Bid" ${dis}>`;
  const askPx = rfqSide === 'bid'
    ? `<span class="fixedpx">${fmt(fixedAsk)}<small>x${fixedAskSize}</small></span>`
    : `<input type="number" step="0.05" class="rfq-ask-px" placeholder="Ask" ${dis}>`;
  const volLabel = rfqSide === 'both' ? `Mkt for ${volume}` : rfqSide === 'bid' ? `Bid for ${volume}` : `Offer for ${volume}`;
  return `
    <div class="rfqbox">
      <div class="rfq-vol">${volLabel}</div>
      <div class="rfq-row">${bidPx}<span class="dash">-</span>${askPx}</div>
      <button ${action} ${dis}>Confirm</button>
      <div class="rfq-err"></div>
    </div>`;
}

function liveSizeHtml(total, userAmt) {
  if (userAmt > 0 && total > userAmt) return `<span class="totalsz">x${total}</span>,<span class="usersz">x${userAmt}</span>`;
  if (userAmt > 0) return `<span class="usersz">x${userAmt}</span>`;
  return `<span class="totalsz">x${total}</span>`;
}

function cellHtml(kind, idx, book, cell) {
  const notRunning = APP.session.status !== 'running';
  const takeFrozen = APP.session.boardFrozen || notRunning; // Mine/Yours: also frozen during an IDB RFQ
  const rfqFrozen = notRunning; // making a market on the board stays enabled during an IDB RFQ
  const kb = `data-kind="${kind}" data-idx="${idx}" data-book="${book ? 1 : 0}"`;
  switch (cell.status) {
    case 'empty':
      return `<div class="px empty">—</div>`;
    case 'indicative':
      return `<div class="px indicative">${fmt(cell.bid)} - ${fmt(cell.ask)}</div>`;
    case 'live': {
      const userBid = cell.userBidSize || 0, userAsk = cell.userAskSize || 0;
      const bidTradeable = cell.bidSize - userBid;
      const askTradeable = cell.askSize - userAsk;
      const hasUserSize = userBid > 0 || userAsk > 0;
      return `
        <div class="takebtns">
          <button data-action="take" ${kb} data-side="sell" ${(takeFrozen || bidTradeable <= 0) ? 'disabled' : ''}>Yours</button>
          <button data-action="take" ${kb} data-side="buy" ${(takeFrozen || askTradeable <= 0) ? 'disabled' : ''}>Mine</button>
        </div>
        <div class="px live">${fmt(cell.bid)} - ${fmt(cell.ask)}</div>
        <div class="sizes"><span>${liveSizeHtml(cell.bidSize, userBid)}</span><span>${liveSizeHtml(cell.askSize, userAsk)}</span></div>
        ${hasUserSize ? `<button data-action="pull" class="pullbtn" ${kb} ${takeFrozen ? 'disabled' : ''}>Pull</button>` : ''}`;
    }
    case 'rfq':
      return rfqFormHtml({
        isIdb: false, kind, idx, book,
        rfqSide: cell.rfqSide,
        fixedBid: cell.bid, fixedBidSize: cell._fixedBidSize,
        fixedAsk: cell.ask, fixedAskSize: cell._fixedAskSize,
        volume: cell.rfqVolume,
        disabled: rfqFrozen,
      });
  }
  return '';
}

function renderCellDom(kind, idx, book) {
  const cell = getCell(kind, idx, book);
  const el = document.getElementById(cellDomId(kind, idx, book));
  if (!el || !cell) return;
  if (cell.status === 'rfq' && cell._domStatus === 'rfq') return; // don't clobber in-progress typing
  const priceChanged = cell.status === 'live' && cell._domStatus === 'live' &&
    (el.dataset.lastBid !== String(cell.bid) || el.dataset.lastAsk !== String(cell.ask));
  cell._domStatus = cell.status;
  el.innerHTML = cellHtml(kind, idx, book, cell);
  applyLiveFlash(el, cell, priceChanged);
}

// Tracks each live cell's last-rendered bid/ask so a genuine price change (not just a size
// change) can trigger a brief flash — 2s, light yellow, per instrument.
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

function buildSkeleton() {
  const strikes = APP.market.strikes;

  document.getElementById('rcBox').innerHTML = `
    <div class="rc-label">R/C</div>
    <div class="rc-value">${fmtSigned(APP.market.rc)}</div>`;

  let main = '';
  for (let i = 0; i < 5; i++) main += `<div class="cell" id="cell-ps-${i}" style="grid-column:1; grid-row:${i + 1};"></div>`;
  for (let i = 0; i < 4; i++) main += `<div class="cell spreadcell callSpreadItem" id="cell-callSpread-${i}" style="grid-column:2; grid-row:${i + 1} / span 2;"></div>`;
  for (let i = 0; i < 5; i++) main += `<div class="cell" id="cell-call-${i}" style="grid-column:3; grid-row:${i + 1};"></div>`;
  for (let i = 0; i < 5; i++) main += `
    <div class="strikecell" style="grid-column:4; grid-row:${i + 1};">
      <div class="strikeval">${strikes[i]}</div>
      <div class="calldelta" id="callDelta-${i}"></div>
    </div>`;
  for (let i = 0; i < 5; i++) main += `<div class="cell" id="cell-put-${i}" style="grid-column:5; grid-row:${i + 1};"></div>`;
  for (let i = 0; i < 4; i++) main += `<div class="cell spreadcell putSpreadItem" id="cell-putSpread-${i}" style="grid-column:6; grid-row:${i + 1} / span 2;"></div>`;
  for (let i = 0; i < 5; i++) main += `<div class="cell" id="cell-bw-${i}" style="grid-column:7; grid-row:${i + 1};"></div>`;
  document.getElementById('mainRow').innerHTML = main;

  document.getElementById('colHeaders').innerHTML = `
    <div style="grid-column:1">P + S</div><div style="grid-column:2"></div>
    <div style="grid-column:3">Calls</div><div style="grid-column:4">Strikes</div>
    <div style="grid-column:5">Puts</div><div style="grid-column:6"></div>
    <div style="grid-column:7">B/W</div>`;

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
  renderCellDom('stock', 0, false);
  for (let i = 0; i < 5; i++) {
    renderCellDom('ps', i, false);
    renderCellDom('call', i, false);
    renderCellDom('put', i, false);
    renderCellDom('bw', i, false);
    const d = document.getElementById(`callDelta-${i}`);
    if (d) d.textContent = 'Δ ' + fmt(BS.greeks(currentSpot(), APP.market.strikes[i], APP.market.T, APP.CONST.R, APP.CONST.Q, currentVol(), 'call').delta * 100);
  }
  if (APP.config.spreadsOn) {
    for (let i = 0; i < 4; i++) {
      renderCellDom('callSpread', i, false);
      renderCellDom('putSpread', i, false);
    }
  }
  if (APP.config.spreadBookOn) renderSpreadBookPanel();
  if (APP.config.idbOn) renderIDBPanel();
  renderAlerts();
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
    if (!active) {
      labelEl.textContent = '—';
      cellEl.innerHTML = `<div class="px empty">no active market</div>`;
      continue;
    }
    const cell = spreadBookCellFor(active.kind, active.idx);
    labelEl.textContent = describeInstrument(active.kind, active.idx, false);
    if (cell.status === 'rfq' && cell._domSlotStatus === 'rfq') continue; // preserve in-progress typing
    const priceChanged = cell.status === 'live' && cell._domSlotStatus === 'live' &&
      (cellEl.dataset.lastBid !== String(cell.bid) || cellEl.dataset.lastAsk !== String(cell.ask));
    cell._domSlotStatus = cell.status;
    cellEl.innerHTML = cellHtml(active.kind, active.idx, true, cell);
    applyLiveFlash(cellEl, cell, priceChanged);
  }
}

function renderStatusBanner() {
  const el = document.getElementById('statusBanner');
  if (!el) return;
  if (APP.session.status === 'ended') el.textContent = 'Session complete.';
  else if (APP.session.status === 'running') el.textContent = APP.session.boardFrozen ? 'IDB request in progress — board trading frozen.' : 'Session running.';
  else el.textContent = '';
  if (typeof setConfigDisabled === 'function') setConfigDisabled(APP.session.status === 'running');
}

function renderConfigSummary() {
  const el = document.getElementById('summaryText');
  if (!el) return;
  const c = APP.config;
  const certaintyLabel = c.certaintyMode === 'stock' ? 'fixed stock'
    : c.certaintyMode === 'vol' ? 'fixed vol' : 'neither fixed';
  const parts = [
    `Board fill: ${c.fillPct}%`,
    certaintyLabel,
    `Trade pace: ${c.tradesPerMinute.toFixed(1)}/min`,
    `Length: ${c.simLengthMin}m`,
    c.spreadsOn ? 'spreads on' : 'spreads off',
    c.spreadBookOn ? 'spread book on' : 'spread book off',
    c.idbOn ? 'IDB on' : 'IDB off',
    c.showPosition ? 'position shown' : 'position hidden',
    c.startWithPosition ? 'starting position' : '',
  ].filter(Boolean);
  el.textContent = parts.join(' · ');
}

function showScreen(name) {
  APP.ui.screen = name;
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
}

function renderClock() {
  const el = document.getElementById('sessionClock');
  if (!el) return;
  const total = APP.config.simLengthMin * 60;
  const rem = Math.max(0, total - APP.session.elapsedSec);
  const mm = Math.floor(rem / 60), ss = Math.floor(rem % 60);
  el.textContent = `${mm}:${ss.toString().padStart(2, '0')}`;
  const bar = document.getElementById('clockBar');
  if (bar) bar.style.width = `${100 * (1 - rem / total)}%`;
}

function renderIDBPanel() {
  const active = APP.idb.active;
  const box = document.getElementById('idbActive');
  if (active) {
    if (active.status === 'awaiting_market' && APP.idb._domStatus === 'awaiting_market') {
      // preserve in-progress typing
    } else {
      APP.idb._domStatus = active.status;
      if (active.status === 'awaiting_market') {
        box.innerHTML = `
          <div class="idb-request">RFQ from IDB: make a market in <b>${describeInstrument(active.kind, active.idx)}</b></div>
          ${rfqFormHtml({
            isIdb: true, rfqSide: active.rfqSide,
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

// ---- alerts & toasts --------------------------------------------------------

function triggerAlert(text, kind) {
  const a = { id: APP.util.uid(), text, kind: kind === 'red' ? 'red' : 'yellow' };
  APP.alerts.unshift(a);
  renderAlerts();
  setTimeout(() => {
    APP.alerts = APP.alerts.filter(x => x.id !== a.id);
    renderAlerts();
  }, 10000);
}

function renderAlerts() {
  const el = document.getElementById('alerts');
  if (!el) return;
  el.innerHTML = APP.alerts.map(a => `<div class="alertbox alert-${a.kind}">${a.text}</div>`).join('');
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

// ---- call/put spread connector lines -----------------------------------------

// sourceYFrac picks where within the (small, fixed-height) spread box the line starts — using a
// point close to the target row's edge, rather than the box's shared center, keeps the line from
// swinging through a steep angle toward each of its two calls/puts.
function lineBetween(idA, idB, crect, sideA, sideB, sourceYFrac) {
  const a = document.getElementById(idA), b = document.getElementById(idB);
  if (!a || !b || a.classList.contains('hidden') || b.classList.contains('hidden')) return '';
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  const x1 = (sideA === 'right' ? ra.right : ra.left) - crect.left;
  const y1 = ra.top + ra.height * sourceYFrac - crect.top;
  const x2 = (sideB === 'left' ? (rb.left + rb.width * 0.22) : (rb.right - rb.width * 0.22)) - crect.left;
  const y2 = rb.top + rb.height / 2 - crect.top;
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" />`;
}

function updateSpreadLines() {
  const svg = document.getElementById('spreadLinesSvg');
  const wrap = document.getElementById('boardGridWrap');
  if (!svg || !wrap) return;
  if (!APP.config.spreadsOn) { svg.innerHTML = ''; return; }
  const crect = wrap.getBoundingClientRect();
  svg.setAttribute('width', crect.width);
  svg.setAttribute('height', crect.height);
  let html = '';
  for (let i = 0; i < 4; i++) {
    html += lineBetween(`cell-callSpread-${i}`, `cell-call-${i}`, crect, 'right', 'left', 0.25);
    html += lineBetween(`cell-callSpread-${i}`, `cell-call-${i + 1}`, crect, 'right', 'left', 0.75);
    html += lineBetween(`cell-putSpread-${i}`, `cell-put-${i}`, crect, 'left', 'right', 0.25);
    html += lineBetween(`cell-putSpread-${i}`, `cell-put-${i + 1}`, crect, 'left', 'right', 0.75);
  }
  svg.innerHTML = html;
}

// ---- position panel: payoff chart + greeks ----------------------------------

function renderPositionPanel() {
  const canvas = document.getElementById('payoffChart');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const spot = currentSpot();
  const lo = spot * 0.6, hi = spot * 1.4;
  const N = 120;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const ST = lo + (hi - lo) * i / N;
    pts.push([ST, hasPosition() ? payoffAt(ST) : 0]);
  }
  const vals = pts.map(p => p[1]);
  const minV = Math.min(0, ...vals), maxV = Math.max(0, ...vals);
  const pad = 30;
  const xScale = (ST) => pad + (W - 2 * pad) * (ST - lo) / (hi - lo);
  const yScale = (v) => H - pad - (H - 2 * pad) * (v - minV) / ((maxV - minV) || 1);

  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, yScale(0)); ctx.lineTo(W - pad, yScale(0)); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(xScale(spot), pad); ctx.lineTo(xScale(spot), H - pad); ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#bbb'; ctx.stroke(); ctx.setLineDash([]);

  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach(([ST, v], i) => {
    const x = xScale(ST), y = yScale(v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = '#666';
  ctx.font = '11px sans-serif';
  ctx.fillText(fmt(lo), pad, H - 10);
  ctx.fillText(fmt(hi), W - pad - 30, H - 10);
  ctx.fillText(`spot ${fmt(spot)}`, xScale(spot) + 4, pad + 10);

  const g = currentGreeksTotal();
  document.getElementById('greeksRow').innerHTML = `
    <div><span>Delta</span><b>${fmt(g.delta)}</b></div>
    <div><span>Gamma</span><b>${fmt(g.gamma)}</b></div>
    <div><span>Vega</span><b>${fmt(g.vega)}</b></div>
    <div><span>Theta</span><b>${fmt(g.theta)}</b></div>
    <div><span>Rho</span><b>${fmt(g.rho)}</b></div>`;
}

// ---- event delegation --------------------------------------------------------

function bindEvents() {
  document.getElementById('app').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'take') {
      const { kind, idx, book, side } = btn.dataset;
      handleTake(kind, parseInt(idx, 10), book === '1', side);
    } else if (action === 'pull') {
      const { kind, idx, book } = btn.dataset;
      handlePull(kind, parseInt(idx, 10), book === '1');
    } else if (action === 'submit-market') {
      const { kind, idx, book } = btn.dataset;
      const cell = getCell(kind, parseInt(idx, 10), book === '1');
      const box = btn.closest('.rfqbox');
      const bidInput = box.querySelector('.rfq-bid-px');
      const askInput = box.querySelector('.rfq-ask-px');
      const bid = bidInput ? parseFloat(bidInput.value) : cell.bid;
      const ask = askInput ? parseFloat(askInput.value) : cell.ask;
      const bidSize = bidInput ? cell.rfqVolume : cell._fixedBidSize;
      const askSize = askInput ? cell.rfqVolume : cell._fixedAskSize;
      const res = submitMarket(kind, parseInt(idx, 10), book === '1', bid, ask, bidSize, askSize, false);
      if (res.error) box.querySelector('.rfq-err').textContent = res.error;
    } else if (action === 'submit-idb-market') {
      const active = APP.idb.active;
      const box = btn.closest('.rfqbox');
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
  window.addEventListener('resize', () => updateSpreadLines());
}
