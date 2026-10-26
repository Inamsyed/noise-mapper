'use strict';

/*
 * Noise Mapper
 * - Measures microphone loudness 10 times a second (Web Audio API).
 * - Tracks location with GPS (Geolocation API).
 * - Once a second, saves one row: average + peak loudness and the latest GPS fix.
 * - Rows are kept in the phone's browser storage and exported as CSV.
 * No audio is ever stored: each measurement is reduced to a single number.
 */

const SAMPLE_MS = 100;      // how often we measure the mic
const ROW_MS = 1000;        // how often we save a row
const CHART_POINTS = 120;   // seconds of history in the live chart
const ROWS_KEY = 'noiseMapper.rows.v1';
const OFFSET_KEY = 'noiseMapper.offset.v1';

const COLUMNS = [
  'timestamp_iso', 'unix_ms', 'session_id',
  'lat', 'lon', 'gps_accuracy_m', 'gps_age_s', 'speed_mps',
  'dbfs_avg', 'dbfs_max', 'db_avg', 'db_max', 'calibration_offset', 'mic_frames',
];
const DB_AVG_COL = COLUMNS.indexOf('db_avg');

const $ = (id) => document.getElementById(id);
const ui = {
  warning: $('warning'), dbValue: $('dbValue'), dbUnit: $('dbUnit'), dbBar: $('dbBar'),
  chart: $('chart'), status: $('status'), rowCount: $('rowCount'), elapsed: $('elapsed'),
  gps: $('gps'), mic: $('mic'), wake: $('wake'), sessionInput: $('sessionInput'),
  startBtn: $('startBtn'), downloadBtn: $('downloadBtn'), shareBtn: $('shareBtn'),
  clearBtn: $('clearBtn'), offsetInput: $('offsetInput'),
};

const app = {
  recording: false,
  rows: loadRows(),       // every saved row, across sessions, until "Clear"
  sessionId: '',
  offset: loadOffset(),
  audioCtx: null, stream: null, source: null, analyser: null, buffer: null,
  frames: [],             // mic measurements collected during the current second
  lastFix: null, geoWatchId: null,
  sampleTimer: null, rowTimer: null, clockTimer: null,
  wakeLock: null, startedAt: 0,
};

/* ---------- Loudness maths ---------- */

// Mean square of the signal -> decibels relative to full scale (dBFS).
// 0 dBFS is the loudest the mic can record; real sounds are negative.
function toDb(meanSquare) {
  return 10 * Math.log10(Math.max(meanSquare, 1e-12)); // floor at -120 dBFS
}

function round1(x) {
  return x === null ? '' : x.toFixed(1);
}

/* ---------- Microphone ---------- */

async function startAudio() {
  stopAudioStream();
  // Ask iOS not to "clean up" the sound, so we measure what is really there.
  app.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false,
  });
  app.source = app.audioCtx.createMediaStreamSource(app.stream);
  app.analyser = app.audioCtx.createAnalyser();
  app.analyser.fftSize = 4096; // about 85 ms of sound per measurement
  app.buffer = new Float32Array(app.analyser.fftSize);

  // Route through a silent gain node so Safari keeps processing audio
  // without playing anything through the speaker.
  const mute = app.audioCtx.createGain();
  mute.gain.value = 0;
  app.source.connect(app.analyser);
  app.analyser.connect(mute);
  mute.connect(app.audioCtx.destination);
  await app.audioCtx.resume();

  // Show whether the phone actually honoured our "no processing" request.
  const track = app.stream.getAudioTracks()[0];
  const s = track.getSettings ? track.getSettings() : {};
  const onOff = (v) => (v === undefined ? '?' : v ? 'on' : 'off');
  ui.mic.textContent =
    `on · ${Math.round(app.audioCtx.sampleRate / 1000)} kHz · ` +
    `noise suppression ${onOff(s.noiseSuppression)} · auto gain ${onOff(s.autoGainControl)}`;
  ui.mic.className = 'ok';
  track.addEventListener('ended', () => {
    if (app.recording) { ui.mic.textContent = 'interrupted'; ui.mic.className = 'bad'; }
  });
}

function stopAudioStream() {
  if (app.stream) app.stream.getTracks().forEach((t) => t.stop());
  if (app.source) app.source.disconnect();
  app.stream = null;
  app.source = null;
  app.analyser = null;
}

// Runs 10x per second: one loudness measurement.
function sampleMic() {
  if (!app.analyser || app.audioCtx.state !== 'running' || document.hidden) return;
  app.analyser.getFloatTimeDomainData(app.buffer);
  let sum = 0;
  for (let i = 0; i < app.buffer.length; i++) sum += app.buffer[i] * app.buffer[i];
  const meanSquare = sum / app.buffer.length;
  app.frames.push(meanSquare);
  showLevel(toDb(meanSquare));
}

/* ---------- GPS ---------- */

function startGps() {
  if (!('geolocation' in navigator)) {
    ui.gps.textContent = 'not available';
    ui.gps.className = 'bad';
    return;
  }
  ui.gps.textContent = 'searching…';
  ui.gps.className = 'warn';
  app.geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      app.lastFix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, speed: c.speed, time: pos.timestamp };
      ui.gps.textContent = `±${Math.round(c.accuracy)} m`;
      ui.gps.className = c.accuracy <= 20 ? 'ok' : 'warn';
    },
    (err) => {
      ui.gps.textContent = err.code === 1 ? 'permission denied' : 'no signal';
      ui.gps.className = 'bad';
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
}

function stopGps() {
  if (app.geoWatchId !== null) navigator.geolocation.clearWatch(app.geoWatchId);
  app.geoWatchId = null;
}

/* ---------- Saving rows ---------- */

// Runs once per second: combine this second's mic measurements with the latest GPS fix.
function saveRow() {
  const now = Date.now();
  const frames = app.frames;
  app.frames = [];

  let dbfsAvg = null;
  let dbfsMax = null;
  if (frames.length) {
    // Average the sound energy (not the dB values) - the standard way to average loudness.
    const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
    dbfsAvg = toDb(mean);
    dbfsMax = toDb(Math.max(...frames));
  }

  const fix = app.lastFix;
  const row = [
    new Date(now).toISOString(),
    now,
    app.sessionId,
    fix ? fix.lat.toFixed(6) : '',
    fix ? fix.lon.toFixed(6) : '',
    fix ? fix.acc.toFixed(1) : '',
    fix ? Math.max(0, (now - fix.time) / 1000).toFixed(1) : '',
    fix && fix.speed !== null && fix.speed >= 0 ? fix.speed.toFixed(2) : '',
    round1(dbfsAvg),
    round1(dbfsMax),
    dbfsAvg === null ? '' : round1(dbfsAvg + app.offset),
    dbfsMax === null ? '' : round1(dbfsMax + app.offset),
    app.offset,
    frames.length,
  ];
  app.rows.push(row);
  if (app.rows.length % 5 === 0) saveRows();
  ui.rowCount.textContent = app.rows.length;
  drawChart();
}

function loadRows() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROWS_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch (e) {
    return [];
  }
}

function saveRows() {
  try {
    localStorage.setItem(ROWS_KEY, JSON.stringify(app.rows));
  } catch (e) {
    showWarning('Could not save readings on the phone. Download the CSV soon so nothing is lost.');
  }
}

function loadOffset() {
  try {
    return parseFloat(localStorage.getItem(OFFSET_KEY)) || 0;
  } catch (e) {
    return 0;
  }
}

/* ---------- Keep the screen on ---------- */

async function keepScreenOn() {
  if (!('wakeLock' in navigator)) {
    ui.wake.textContent = 'set Auto-Lock to Never';
    ui.wake.className = 'warn';
    return;
  }
  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
    ui.wake.textContent = 'kept on while recording';
    ui.wake.className = 'ok';
    app.wakeLock.addEventListener('release', () => {
      if (app.recording) { ui.wake.textContent = 'may lock'; ui.wake.className = 'warn'; }
    });
  } catch (e) {
    ui.wake.textContent = 'set Auto-Lock to Never';
    ui.wake.className = 'warn';
  }
}

// iPhone pauses the mic when the page is hidden. When it comes back, restart what stopped.
document.addEventListener('visibilitychange', async () => {
  if (!app.recording) return;
  if (document.hidden) {
    setStatus('Paused (page hidden)', 'warn');
    saveRows();
    return;
  }
  setStatus('Recording', 'ok');
  keepScreenOn();
  const track = app.stream && app.stream.getAudioTracks()[0];
  try {
    if (!track || track.readyState === 'ended') await startAudio();
    else if (app.audioCtx.state !== 'running') await app.audioCtx.resume();
  } catch (e) {
    ui.mic.textContent = 'lost: ' + e.message;
    ui.mic.className = 'bad';
  }
});

window.addEventListener('pagehide', saveRows);

/* ---------- Start / stop ---------- */

async function start() {
  hideWarning();
  if (!window.isSecureContext || !navigator.mediaDevices) {
    showWarning('This page must be opened over HTTPS (or on localhost) to use the microphone and GPS.');
    return;
  }
  ui.startBtn.disabled = true;
  setStatus('Asking for permission…');

  // On iPhone the audio engine must be created inside the button tap.
  const Ctx = window.AudioContext || window.webkitAudioContext;
  app.audioCtx = new Ctx();
  app.audioCtx.resume();

  try {
    await startAudio();
  } catch (e) {
    showWarning('Microphone not available: ' + e.message + '. Check Settings → Safari → Microphone.');
    app.audioCtx.close();
    app.audioCtx = null;
    ui.startBtn.disabled = false;
    setStatus('Ready');
    return;
  }

  app.sessionId = ui.sessionInput.value.trim() || defaultSessionId();
  ui.sessionInput.value = app.sessionId;
  app.offset = parseFloat(ui.offsetInput.value) || 0;
  app.frames = [];
  app.recording = true;
  app.startedAt = Date.now();

  startGps();
  keepScreenOn();
  app.sampleTimer = setInterval(sampleMic, SAMPLE_MS);
  app.rowTimer = setInterval(saveRow, ROW_MS);
  app.clockTimer = setInterval(updateClock, 500);

  ui.startBtn.textContent = 'Stop recording';
  ui.startBtn.classList.add('recording');
  ui.startBtn.disabled = false;
  setControlsLocked(true);
  setStatus('Recording', 'ok');
}

function stop() {
  app.recording = false;
  clearInterval(app.sampleTimer);
  clearInterval(app.rowTimer);
  clearInterval(app.clockTimer);
  stopAudioStream();
  if (app.audioCtx) app.audioCtx.close();
  app.audioCtx = null;
  stopGps();
  if (app.wakeLock) app.wakeLock.release().catch(() => {});
  app.wakeLock = null;
  saveRows();

  ui.startBtn.textContent = 'Start recording';
  ui.startBtn.classList.remove('recording');
  ui.sessionInput.value = '';
  setControlsLocked(false);
  ui.mic.textContent = 'off'; ui.mic.className = '';
  ui.gps.textContent = 'off'; ui.gps.className = '';
  ui.wake.textContent = '-'; ui.wake.className = '';
  setStatus(`Stopped · ${app.rows.length} readings saved`);
}

function defaultSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `walk-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/* ---------- CSV export ---------- */

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv() {
  return [COLUMNS.join(','), ...app.rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
}

function csvFileName() {
  return `noise_data_${defaultSessionId().slice(5)}.csv`;
}

function downloadCsv() {
  if (!app.rows.length) return showWarning('No readings yet.');
  const blob = new Blob([buildCsv()], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// iPhone share sheet: lets you AirDrop / email / save the CSV directly.
async function shareCsv() {
  if (!app.rows.length) return showWarning('No readings yet.');
  const file = new File([buildCsv()], csvFileName(), { type: 'text/csv' });
  try {
    await navigator.share({ files: [file], title: 'Noise Mapper data' });
  } catch (e) {
    if (e.name !== 'AbortError') showWarning('Sharing failed: ' + e.message);
  }
}

function clearRows() {
  if (!app.rows.length) return;
  if (!confirm(`Delete all ${app.rows.length} readings from this phone? Download the CSV first if you need it.`)) return;
  app.rows = [];
  saveRows();
  ui.rowCount.textContent = 0;
  drawChart();
  setStatus('Ready');
}

/* ---------- Display ---------- */

function showLevel(dbfs) {
  ui.dbValue.textContent = Math.round(dbfs + app.offset);
  // Map -90..0 dBFS onto the bar width.
  const pct = Math.min(100, Math.max(0, ((dbfs + 90) / 90) * 100));
  ui.dbBar.style.width = pct + '%';
  ui.dbBar.style.background = pct > 75 ? 'var(--bad)' : pct > 50 ? 'var(--warn)' : 'var(--ok)';
}

function updateUnit() {
  ui.dbUnit.textContent = app.offset ? 'dB (calibrated)' : 'dBFS';
}

function drawChart() {
  const canvas = ui.chart;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const values = app.rows.slice(-CHART_POINTS).map((r) => parseFloat(r[DB_AVG_COL]));
  const valid = values.filter((v) => !isNaN(v));
  if (valid.length < 2) return;
  const min = Math.min(...valid) - 2;
  const max = Math.max(...valid) + 2;
  const x = (i) => (i / (CHART_POINTS - 1)) * w;
  const y = (v) => h - ((v - min) / (max - min)) * h;

  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
  ctx.lineWidth = 2;
  ctx.beginPath();
  let drawing = false;
  const offsetX = CHART_POINTS - values.length;
  values.forEach((v, i) => {
    if (isNaN(v)) { drawing = false; return; } // leave gaps where data is missing
    const px = x(i + offsetX);
    const py = y(v);
    if (drawing) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    drawing = true;
  });
  ctx.stroke();

  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted');
  ctx.font = '11px sans-serif';
  ctx.fillText(Math.round(max), 2, 11);
  ctx.fillText(Math.round(min), 2, h - 3);
}

function updateClock() {
  const s = Math.floor((Date.now() - app.startedAt) / 1000);
  ui.elapsed.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setStatus(text, cls = '') {
  ui.status.textContent = text;
  ui.status.className = cls;
}

function setControlsLocked(locked) {
  ui.sessionInput.disabled = locked;
  ui.offsetInput.disabled = locked;
  ui.clearBtn.disabled = locked;
}

function showWarning(text) {
  ui.warning.textContent = text;
  ui.warning.hidden = false;
}

function hideWarning() {
  ui.warning.hidden = true;
}

/* ---------- Wire up the page ---------- */

ui.startBtn.addEventListener('click', () => (app.recording ? stop() : start()));
ui.downloadBtn.addEventListener('click', downloadCsv);
ui.shareBtn.addEventListener('click', shareCsv);
ui.clearBtn.addEventListener('click', clearRows);
ui.offsetInput.value = app.offset;
ui.offsetInput.addEventListener('change', () => {
  app.offset = parseFloat(ui.offsetInput.value) || 0;
  try { localStorage.setItem(OFFSET_KEY, String(app.offset)); } catch (e) { /* ignore */ }
  updateUnit();
});
window.addEventListener('beforeunload', (e) => {
  if (app.recording) { saveRows(); e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('resize', drawChart);

// Only show "Share" where the phone supports sharing files (iPhone Safari does).
try {
  const testFile = new File(['x'], 'test.csv', { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [testFile] })) ui.shareBtn.hidden = false;
} catch (e) { /* not supported */ }

updateUnit();
ui.rowCount.textContent = app.rows.length;
if (app.rows.length) setStatus(`${app.rows.length} saved readings · download or clear`);
drawChart();
if (!window.isSecureContext) {
  showWarning('Open this page over HTTPS (e.g. GitHub Pages) so the microphone and GPS work.');
}
