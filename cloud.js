/*
 * cloud.js: sends each Noise Mapper reading to Firebase Firestore in real time.
 *
 * - Each phone signs in anonymously, so every reading carries a random user ID.
 * - Each walk becomes one document in "sessions".
 * - Each one-second reading becomes one document in "readings".
 * - Firestore keeps unsent readings on the phone (IndexedDB) and uploads them
 *   when the connection comes back.
 *
 * app.js calls window.NoiseCloud.startSession / uploadReading / endSession.
 * If this file fails to load (e.g. no internet), the app still records locally.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, collection, doc, setDoc, addDoc, updateDoc,
  serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// These identify the Firebase project. They are meant to be public;
// access is controlled by the Firestore security rules (firestore.rules).
const firebaseConfig = {
  apiKey: 'AIzaSyCAHpbF-E-jVQd0mE441nHOJlxVeW3MxCg',
  authDomain: 'noise-mapper-861b1.firebaseapp.com',
  projectId: 'noise-mapper-861b1',
  storageBucket: 'noise-mapper-861b1.firebasestorage.app',
  messagingSenderId: '515178392473',
  appId: '1:515178392473:web:a70c1aa5cc50db1b7d8108',
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// persistentLocalCache = queue writes on the phone while offline, even across reloads.
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache() });

const statusEl = document.getElementById('cloud');
const state = { user: null, session: null, sent: 0, confirmed: 0, failed: 0, error: '' };

/* ---------- Sign-in ---------- */

let signInPromise = null;
function ensureSignedIn() {
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  if (!signInPromise) {
    signInPromise = signInAnonymously(auth)
      .then((cred) => cred.user)
      .catch((err) => { signInPromise = null; throw err; });
  }
  return signInPromise;
}

onAuthStateChanged(auth, (user) => {
  state.user = user;
  if (user) state.error = '';
  render();
});
ensureSignedIn().catch(showError);

/* ---------- Sessions and readings ---------- */

// CSV values arrive as text; store real numbers (or null when empty).
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function startSession({ sessionId, offset }) {
  // Create the document ID now, so readings can point to it straight away.
  const ref = doc(collection(db, 'sessions'));
  state.session = { ref, sessionId, count: 0 };
  state.sent = 0;
  state.confirmed = 0;
  state.failed = 0;
  render();

  ensureSignedIn()
    .then((user) => setDoc(ref, {
      userId: user.uid,
      sessionId,
      calibrationOffset: offset,
      startedAtClient: Timestamp.now(),
      startedAt: serverTimestamp(),
      endedAt: null,
      readingCount: 0,
      userAgent: navigator.userAgent.slice(0, 200),
      appVersion: '2.0',
    }))
    .catch(showError);
}

function uploadReading(r) {
  const s = state.session;
  if (!s) return;
  s.count += 1;
  state.sent += 1;
  render();

  ensureSignedIn()
    .then((user) => addDoc(collection(db, 'readings'), {
      userId: user.uid,
      sessionDocId: s.ref.id,
      sessionId: s.sessionId,
      unixMs: Number(r.unix_ms),
      clientTime: Timestamp.fromMillis(Number(r.unix_ms)), // when the phone made the reading
      serverTime: serverTimestamp(),                       // when Firestore received it
      lat: num(r.lat),
      lon: num(r.lon),
      gpsAccuracy: num(r.gps_accuracy_m),
      gpsAge: num(r.gps_age_s),
      speed: num(r.speed_mps),
      dbfsAvg: num(r.dbfs_avg),
      dbfsMax: num(r.dbfs_max),
      dbAvg: num(r.db_avg),
      dbMax: num(r.db_max),
      calibrationOffset: num(r.calibration_offset),
      micFrames: num(r.mic_frames),
    }))
    // addDoc only resolves once the server has confirmed the write.
    .then(() => { state.confirmed += 1; render(); })
    .catch((err) => { state.failed += 1; showError(err); });
}

function endSession() {
  const s = state.session;
  if (!s) return;
  ensureSignedIn()
    .then(() => updateDoc(s.ref, {
      endedAt: serverTimestamp(),
      endedAtClient: Timestamp.now(),
      readingCount: s.count,
    }))
    .catch(showError);
}

/* ---------- Status line ---------- */

function showError(err) {
  state.error = (err && (err.code || err.message)) || 'unknown error';
  console.error('[cloud]', err);
  render();
}

function render() {
  if (!statusEl) return;
  const waiting = state.sent - state.confirmed - state.failed;
  const offline = navigator.onLine ? '' : ' (offline)';
  let text;
  let cls;
  if (state.error && !state.confirmed) {
    text = 'error: ' + state.error;
    cls = 'bad';
  } else if (!state.user) {
    text = 'connecting…';
    cls = 'warn';
  } else if (!state.sent) {
    text = 'connected · ready to upload';
    cls = 'ok';
  } else {
    text = `${state.confirmed} uploaded · ${waiting} waiting${offline}`;
    if (state.failed) text += ` · ${state.failed} failed`;
    cls = state.failed ? 'bad' : waiting > 5 ? 'warn' : 'ok';
  }
  statusEl.textContent = text;
  statusEl.className = cls;
}

window.addEventListener('online', render);
window.addEventListener('offline', render);
render();

window.NoiseCloud = { startSession, uploadReading, endSession };
