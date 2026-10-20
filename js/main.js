// Bootstrap & control panel wiring.

function setConfigDisabled(disabled) {
  document.querySelectorAll('.cfg-input').forEach(el => { el.disabled = disabled; });
}

function bindConfigPanel() {
  const $ = (id) => document.getElementById(id);

  $('cfgSpreadsOn').checked = APP.config.spreadsOn;
  $('cfgSpreadsOn').addEventListener('change', (e) => { APP.config.spreadsOn = e.target.checked; });

  $('cfgSpreadBookOn').checked = APP.config.spreadBookOn;
  $('cfgSpreadBookOn').addEventListener('change', (e) => { APP.config.spreadBookOn = e.target.checked; });

  $('cfgIdbOn').checked = APP.config.idbOn;
  $('cfgIdbOn').addEventListener('change', (e) => { APP.config.idbOn = e.target.checked; });

  $('cfgShowPosition').checked = APP.config.showPosition;
  $('cfgShowPosition').addEventListener('change', (e) => { APP.config.showPosition = e.target.checked; });

  $('cfgStartWithPosition').checked = APP.config.startWithPosition;
  $('cfgStartWithPosition').addEventListener('change', (e) => { APP.config.startWithPosition = e.target.checked; });

  document.querySelectorAll('input[name="certaintyMode"]').forEach(r => {
    r.checked = (r.value === APP.config.certaintyMode);
    r.addEventListener('change', (e) => { if (e.target.checked) APP.config.certaintyMode = e.target.value; });
  });

  const syncFixedLabel = () => {
    $('fixedDelta1Label').textContent = APP.config.delta1 === 'future' ? 'Fixed future' : 'Fixed stock';
  };
  document.querySelectorAll('input[name="simDelta1"]').forEach(r => {
    r.checked = (r.value === APP.config.delta1);
    r.addEventListener('change', (e) => { if (e.target.checked) { APP.config.delta1 = e.target.value; syncFixedLabel(); } });
  });
  syncFixedLabel();

  $('cfgStrikes').value = APP.config.numStrikes;
  $('cfgStrikesLabel').textContent = String(APP.config.numStrikes);
  $('cfgStrikes').addEventListener('input', (e) => {
    APP.config.numStrikes = parseInt(e.target.value, 10);
    $('cfgStrikesLabel').textContent = String(APP.config.numStrikes);
  });

  document.querySelectorAll('input[name="simTick"]').forEach(r => {
    r.checked = (parseFloat(r.value) === APP.config.tick);
    r.addEventListener('change', (e) => { if (e.target.checked) APP.config.tick = parseFloat(e.target.value); });
  });

  // timed sessions have a pace and a length; step-by-step ones have a number of steps instead
  const syncModeRows = () => {
    const steps = APP.config.mode === 'steps';
    $('cfgPaceRow').classList.toggle('hidden', steps);
    $('cfgLengthRow').classList.toggle('hidden', steps);
    $('cfgStepsRow').classList.toggle('hidden', !steps);
  };
  document.querySelectorAll('input[name="simMode"]').forEach(r => {
    r.checked = (r.value === APP.config.mode);
    r.addEventListener('change', (e) => { if (e.target.checked) { APP.config.mode = e.target.value; syncModeRows(); } });
  });
  $('cfgSteps').value = APP.config.steps;
  $('cfgStepsLabel').textContent = String(APP.config.steps);
  $('cfgSteps').addEventListener('input', (e) => {
    APP.config.steps = parseInt(e.target.value, 10);
    $('cfgStepsLabel').textContent = String(APP.config.steps);
  });
  syncModeRows();

  $('cfgBookView').checked = APP.config.bookView;
  $('cfgBookView').addEventListener('change', (e) => { APP.config.bookView = e.target.checked; });

  document.querySelectorAll('input[name="drillDelta1"]').forEach(r => {
    r.checked = (r.value === APP.drillConfig.delta1);
    r.addEventListener('change', (e) => { if (e.target.checked) APP.drillConfig.delta1 = e.target.value; });
  });
  // the question-type toggles only apply to the order-book view
  const syncTypesRow = () => { $('drillTypesRow').classList.toggle('hidden', APP.drillConfig.view !== 'book'); };
  document.querySelectorAll('input[name="drillView"]').forEach(r => {
    r.checked = (r.value === APP.drillConfig.view);
    r.addEventListener('change', (e) => { if (e.target.checked) { APP.drillConfig.view = e.target.value; syncTypesRow(); } });
  });
  $('cfgTypeArb').checked = APP.drillConfig.types.arb;
  $('cfgTypeArb').addEventListener('change', (e) => { APP.drillConfig.types.arb = e.target.checked; });
  $('cfgTypeImprove').checked = APP.drillConfig.types.improve;
  $('cfgTypeImprove').addEventListener('change', (e) => { APP.drillConfig.types.improve = e.target.checked; });
  document.querySelectorAll('input[name="drillTick"]').forEach(r => {
    r.checked = (parseFloat(r.value) === APP.drillConfig.tick);
    r.addEventListener('change', (e) => { if (e.target.checked) APP.drillConfig.tick = parseFloat(e.target.value); });
  });
  syncTypesRow();

  $('cfgTradePace').value = APP.config.tradesPerMinute;
  $('cfgTradePaceLabel').textContent = `${APP.config.tradesPerMinute.toFixed(1)}/min`;
  $('cfgTradePace').addEventListener('input', (e) => {
    APP.config.tradesPerMinute = parseFloat(e.target.value);
    $('cfgTradePaceLabel').textContent = `${APP.config.tradesPerMinute.toFixed(1)}/min`;
  });

  $('cfgSimLength').value = APP.config.simLengthMin;
  $('cfgSimLengthLabel').textContent = `${APP.config.simLengthMin} min`;
  $('cfgSimLength').addEventListener('input', (e) => {
    APP.config.simLengthMin = parseInt(e.target.value, 10);
    $('cfgSimLengthLabel').textContent = `${APP.config.simLengthMin} min`;
  });

  $('cfgDrillMinutes').value = APP.drillConfig.minutes;
  $('cfgDrillMinutesLabel').textContent = `${APP.drillConfig.minutes} min`;
  $('cfgDrillMinutes').addEventListener('input', (e) => {
    APP.drillConfig.minutes = parseInt(e.target.value, 10);
    $('cfgDrillMinutesLabel').textContent = `${APP.drillConfig.minutes} min`;
  });

  $('chooseSimBtn').addEventListener('click', () => showScreen('simConfig'));
  $('chooseDrillBtn').addEventListener('click', () => showScreen('drillConfig'));
  $('simBackBtn').addEventListener('click', () => showScreen('home'));
  $('drillBackBtn').addEventListener('click', () => showScreen('home'));

  $('confirmStartBtn').addEventListener('click', () => beginCountdownThenStart(() => {
    startSession();
    renderConfigSummary();
    showScreen('session');
  }));
  $('restartBtn').addEventListener('click', () => { startSession(); renderConfigSummary(); });
  $('resetConfigBtn').addEventListener('click', () => { stopSession(); setConfigDisabled(false); showScreen('simConfig'); });

  $('simRetryBtn').addEventListener('click', () => { startSession(); renderConfigSummary(); showScreen('session'); });
  $('simReconfigBtn').addEventListener('click', () => { stopSession(); setConfigDisabled(false); showScreen('simConfig'); });
  $('simHomeBtn').addEventListener('click', () => { stopSession(); setConfigDisabled(false); showScreen('home'); });

  $('startDrillBtn').addEventListener('click', () => beginCountdownThenStart(() => {
    startDrill();
    showScreen('drill');
  }));
  $('drillRetryBtn').addEventListener('click', () => { startDrill(); showScreen('drill'); });
  $('drillReconfigBtn').addEventListener('click', () => showScreen('drillConfig'));
  $('drillHomeBtn').addEventListener('click', () => showScreen('home'));
}

function bindFullscreenButton() {
  const btn = document.getElementById('fullscreenBtn');
  const update = () => { btn.textContent = document.fullscreenElement ? '⛶ Exit fullscreen' : '⛶ Fullscreen'; };
  btn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', update);
  update();
}

function beginCountdownThenStart(onDone) {
  showScreen('countdown');
  const numEl = document.getElementById('countdownNumber');
  let n = 3;
  const showN = () => {
    numEl.textContent = n;
    numEl.style.animation = 'none';
    void numEl.offsetWidth; // restart the pulse animation
    numEl.style.animation = '';
  };
  showN();
  const tick = () => {
    n -= 1;
    if (n <= 0) { onDone(); return; }
    showN();
    setTimeout(tick, 800);
  };
  setTimeout(tick, 800);
}

document.addEventListener('DOMContentLoaded', () => {
  bindConfigPanel();
  bindEvents();
  bindDrillEvents();
  bindFullscreenButton();
  initMarket();
  buildSkeleton();
  showScreen('home');
});
