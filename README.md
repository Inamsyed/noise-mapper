# Noise Mapper: Urban Computing Assignment 2 (Sensor Data Collection)

A small web app that turns a smartphone into a noise-mapping sensor.
Once per second it saves how loud it is (from the microphone) and where you are (from GPS), and exports the readings as a CSV file.

No audio is ever recorded or stored. Each measurement is reduced to a single loudness number straight away.

## Files

| File | What it does |
|---|---|
| `index.html` | The page: live loudness readout, status panel, buttons |
| `style.css` | Layout and colours (works on phone screens, light and dark mode) |
| `app.js` | All the logic: microphone, GPS, saving rows, CSV export |

There are no libraries and no build step: it is plain HTML, CSS and JavaScript.

## How to run it

### On an iPhone (or any phone): the normal way
The app is hosted on GitHub Pages:

**https://inamsyed.github.io/noise-mapper/**

1. Open the link in **Safari**.
2. (Optional) Type a session name, e.g. `walk01`.
3. Tap **Start recording** and allow **Microphone** and **Location** when asked.
4. Keep the page open and the screen on while you walk.
5. Tap **Stop recording**, then **Download CSV** (saves to the Files app) or **Share CSV** (AirDrop, email, ...).

Browsers only allow microphone and GPS access on secure pages (HTTPS), which is why the app is hosted on GitHub Pages rather than opened as a file.

### On a laptop (for testing)
Any local web server works, because browsers treat `localhost` as secure:

```bash
python -m http.server 8000
```

Then open http://localhost:8000 in Chrome, Edge or Firefox. A laptop has no GPS, so location will be approximate (Wi-Fi based) or missing.

## How it works

1. **Microphone → loudness** (Web Audio API).
   Every 100 ms the app takes the last ~85 ms of sound (4,096 samples), squares and averages the samples (mean square), and converts that to decibels:
   `dBFS = 10 · log10(mean square)`.
   dBFS means "decibels relative to full scale": 0 is the loudest the microphone can record, so everyday sounds are negative numbers.
   The app asks the browser to turn off echo cancellation, noise suppression and automatic gain, so the level reflects the real environment. The status panel shows whether the phone actually honoured this.
2. **GPS → location** (Geolocation API, high-accuracy mode). Each fix comes with an accuracy estimate in metres.
3. **Once per second** the app combines that second's ~10 loudness measurements into an **average** (averaged as energy, the standard way to average sound levels) and a **peak**, adds the most recent GPS fix, and saves a row.
4. Rows are kept in the browser's local storage, so they survive a page reload, until you press **Clear**.
5. **Calibration (optional):** a phone mic is not a calibrated sound meter. Comparing it with a calibrated meter app (e.g. NIOSH SLM) gives an offset, which is added to produce approximate real decibels (`db_avg`, `db_max`).

## CSV columns

| Column | Meaning |
|---|---|
| `timestamp_iso` | Time of the reading (UTC, ISO 8601) |
| `unix_ms` | Same time as milliseconds since 1970 |
| `session_id` | Name of the recording session (e.g. one walk) |
| `lat`, `lon` | Latitude / longitude of the latest GPS fix |
| `gps_accuracy_m` | GPS accuracy estimate in metres (smaller is better) |
| `gps_age_s` | How old the GPS fix was when the row was saved, in seconds |
| `speed_mps` | Speed reported by GPS, metres per second (blank if unknown) |
| `dbfs_avg`, `dbfs_max` | Average and peak loudness over that second, raw dBFS |
| `db_avg`, `db_max` | Same, with the calibration offset added |
| `calibration_offset` | Offset used (0 = uncalibrated) |
| `mic_frames` | Number of mic measurements in that second (normally ~10; 0 = no audio, e.g. screen locked) |

Blank cells mean the value was not available (e.g. no GPS fix yet, or the microphone was paused).

## Known limitations
- iPhone pauses the microphone when the screen locks or Safari is in the background, so the page must stay open. The app asks iOS to keep the screen awake (Screen Wake Lock API).
- Phone microphones are uncalibrated and differ between models. Values are relative unless an offset is set.
- No frequency weighting (dB(A)) is applied.
- GPS accuracy drops between tall buildings and indoors.
