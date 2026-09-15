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

  $('cfgTradePace').value = APP.config.tradesPerMinute;
  $('cfgTradePaceLabel').textContent = `${APP.config.tradesPerMinute.toFixed(1)}/min`;
  $('cfgTradePace').addEventListener('input', (e) => {
    APP.config.tradesPerMinute = parseFloat(e.target.value);
    $('cfgTradePaceLabel').textContent = `${APP.config.tradesPerMinute.toFixed(1)}/min`;
  });

  $('cfgFillPct').value = APP.config.fillPct;
  $('cfgFillPctLabel').textContent = `${APP.config.fillPct}%`;
  $('cfgFillPct').addEventListener('input', (e) => {
    APP.config.fillPct = parseInt(e.target.value, 10);
    $('cfgFillPctLabel').textContent = `${APP.config.fillPct}%`;
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
