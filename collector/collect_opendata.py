"""
Open-data collector for Noise Mapper (Assignment 3, Task 2).

Every few minutes it fetches two open data sources and writes them to Firestore:
  1. Dublin City Council noise monitors (Sonitus API): 5-minute noise levels in dB(A).
  2. Open-Meteo weather for Dublin: wind, rain, temperature, updated every 15 minutes.

Firestore layout (all under the "opendata" collection):
  opendata/dcc_noise/monitors/{serial}       one doc per noise monitor (location, last reading time)
  opendata/dcc_noise/readings/{serial}_{t}   one doc per monitor per 5 minutes
  opendata/weather/readings/{t}              one doc per weather update

Document IDs are built from the monitor and the reading time, so running the
collector twice never creates duplicates.

Usage:
  python collector/collect_opendata.py            # run once
  python collector/collect_opendata.py --loop     # keep running, every 5 minutes

Needs:
  - serviceAccount.json (Firebase admin key) in the project folder, or the
    FIREBASE_SERVICE_ACCOUNT environment variable holding its JSON.
  - SONITUS_USER and SONITUS_PASS environment variables. Dublin City Council
    publishes these for public use on https://data.gov.ie/dataset/sonitus
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests
import firebase_admin
from firebase_admin import credentials, firestore

SONITUS_URL = 'https://data.smartdublin.ie/sonitus-api/api'
WEATHER_URL = 'https://api.open-meteo.com/v1/forecast'
DUBLIN_TZ = ZoneInfo('Europe/Dublin')        # council timestamps are Irish local time
WEATHER_POINT = (53.3498, -6.2603)            # Dublin city centre
FIRST_RUN_LOOKBACK = timedelta(hours=3)       # how far back to fetch the first time
LOOP_SECONDS = 300

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def log(msg):
    print(f'{datetime.now():%H:%M:%S}  {msg}', flush=True)


# ---------- Firestore ----------

def connect_firestore():
    raw = os.environ.get('FIREBASE_SERVICE_ACCOUNT')
    if raw:
        cred = credentials.Certificate(json.loads(raw))
    else:
        cred = credentials.Certificate(os.path.join(ROOT, 'serviceAccount.json'))
    firebase_admin.initialize_app(cred)
    return firestore.client()


# ---------- Dublin City Council noise monitors ----------

def sonitus_post(endpoint, **params):
    params.update(username=os.environ['SONITUS_USER'], password=os.environ['SONITUS_PASS'])
    r = requests.post(f'{SONITUS_URL}/{endpoint}', data=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict) and 'error' in data:
        raise RuntimeError(f'Sonitus API: {data["error"]}')
    return data


def noise_monitors():
    """Active noise monitors only (the API also lists air-quality stations and a spare)."""
    monitors = sonitus_post('monitors')
    return [m for m in monitors
            if m['label'].startswith('Noise') and 'Spare' not in m['label']
            and m.get('location') != 'In Office']


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def collect_noise(db):
    now = datetime.now(timezone.utc)
    col = db.collection('opendata').document('dcc_noise')
    written, latest_overall = 0, None

    for m in noise_monitors():
        serial = m['serial_number']
        mon_ref = col.collection('monitors').document(serial.replace('/', '_'))
        snap = mon_ref.get()
        last = snap.get('lastReadingTime') if snap.exists else None
        start = last + timedelta(seconds=1) if last else now - FIRST_RUN_LOOKBACK

        try:
            rows = sonitus_post('data', monitor=serial,
                                start=int(start.timestamp()), end=int(now.timestamp()))
        except Exception as e:  # one broken monitor should not stop the others
            log(f'  {m["label"]} ({m["location"]}): failed: {e}')
            continue

        batch = db.batch()
        newest = last
        for row in rows:
            t = datetime.strptime(row['datetime'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=DUBLIN_TZ)
            doc_id = f'{serial}_{int(t.timestamp())}'.replace('/', '_')
            batch.set(col.collection('readings').document(doc_id), {
                'source': 'Dublin City Council noise monitoring (Sonitus API)',
                'monitorSerial': serial,
                'label': m['label'],
                'location': m['location'],
                'lat': to_float(m.get('latitude')),
                'lon': to_float(m.get('longitude')),
                'time': t,                                   # end of the 5-minute period
                'laeq': to_float(row.get('laeq')),           # average level, dB(A)
                'lafmax': to_float(row.get('lafmax')),       # loudest moment, dB(A)
                'la10': to_float(row.get('la10')),           # level exceeded 10% of the time
                'la90': to_float(row.get('la90')),           # background level (exceeded 90%)
                'lceq': to_float(row.get('lceq')),           # C-weighted average (low frequencies)
                'fetchedAt': firestore.SERVER_TIMESTAMP,     # when the collector stored it
            })
            newest = t if newest is None or t > newest else newest
        if rows:
            batch.set(mon_ref, {
                'serial': serial, 'label': m['label'], 'location': m['location'],
                'lat': to_float(m.get('latitude')), 'lon': to_float(m.get('longitude')),
                'lastCalibrated': m.get('last_calibrated'),
                'lastReadingTime': newest, 'updatedAt': firestore.SERVER_TIMESTAMP,
            }, merge=True)
            batch.commit()
            written += len(rows)
            latest_overall = newest if latest_overall is None or newest > latest_overall else latest_overall

    lag = f', newest reading {(now - latest_overall).total_seconds() / 60:.0f} min old' if latest_overall else ''
    log(f'Noise: {written} new readings{lag}')
    return written


# ---------- Open-Meteo weather ----------

def collect_weather(db):
    lat, lon = WEATHER_POINT
    r = requests.get(WEATHER_URL, timeout=30, params={
        'latitude': lat, 'longitude': lon, 'timezone': 'UTC',
        'current': 'temperature_2m,relative_humidity_2m,precipitation,rain,'
                   'wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover',
    })
    r.raise_for_status()
    cur = r.json()['current']
    t = datetime.fromisoformat(cur['time']).replace(tzinfo=timezone.utc)
    ref = db.collection('opendata').document('weather').collection('readings').document(str(int(t.timestamp())))
    if ref.get().exists:
        log('Weather: no new update yet')
        return 0
    ref.set({
        'source': 'Open-Meteo forecast API (current conditions)',
        'lat': lat, 'lon': lon, 'time': t,
        'temperatureC': cur.get('temperature_2m'),
        'humidityPct': cur.get('relative_humidity_2m'),
        'precipitationMm': cur.get('precipitation'),
        'rainMm': cur.get('rain'),
        'windSpeedKmh': cur.get('wind_speed_10m'),
        'windGustsKmh': cur.get('wind_gusts_10m'),
        'windDirectionDeg': cur.get('wind_direction_10m'),
        'cloudCoverPct': cur.get('cloud_cover'),
        'fetchedAt': firestore.SERVER_TIMESTAMP,
    })
    log(f'Weather: stored update for {t:%H:%M} UTC (wind {cur.get("wind_speed_10m")} km/h)')
    return 1


# ---------- Main ----------

def run_once(db):
    for name, fn in (('noise', collect_noise), ('weather', collect_weather)):
        try:
            fn(db)
        except Exception as e:  # keep going if one source is down
            log(f'{name} collection failed: {e}')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    parser.add_argument('--loop', action='store_true', help=f'repeat every {LOOP_SECONDS} s')
    args = parser.parse_args()

    if not (os.environ.get('SONITUS_USER') and os.environ.get('SONITUS_PASS')):
        sys.exit('Set SONITUS_USER and SONITUS_PASS (published on https://data.gov.ie/dataset/sonitus).')

    db = connect_firestore()
    log('Connected to Firestore')
    while True:
        run_once(db)
        if not args.loop:
            break
        time.sleep(LOOP_SECONDS)


if __name__ == '__main__':
    main()
