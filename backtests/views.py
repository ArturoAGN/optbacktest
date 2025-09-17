import os
import json
import math
import datetime as dt

import pytz
import requests
from django.conf import settings
from django.shortcuts import render
from django.utils.timezone import now

# === Config ===
NY = pytz.timezone("America/New_York")
POLYGON_KEY = os.getenv("POLYGON_API_KEY", getattr(settings, "POLYGON_API_KEY", ""))  # pon tu key en .env o settings

BASE_URL = "https://api.polygon.io"


def _iso_ny(ts_utc_ms: int) -> str:
    """Convierte epoch-ms UTC a ISO 'YYYY-MM-DDTHH:MM' en America/New_York."""
    ts_utc = dt.datetime.utcfromtimestamp(ts_utc_ms / 1000.0).replace(tzinfo=pytz.UTC)
    ts_ny = ts_utc.astimezone(NY)
    return ts_ny.strftime("%Y-%m-%dT%H:%M")


def _aggs_polygon(ticker: str, multiplier: int, timespan: str, date_from: str, date_to: str):
    """
    Llama a Polygon v2/aggs. Devuelve lista de dicts normalizados.
    timespan: 'minute' | 'hour' | 'day'
    """
    if not POLYGON_KEY:
        raise RuntimeError("Falta POLYGON_API_KEY")

    url = f"{BASE_URL}/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{date_from}/{date_to}"
    params = {
        "adjusted": "true",
        "sort": "asc",
        "limit": 50000,
        "apiKey": POLYGON_KEY,
    }
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    results = data.get("results", [])
    out = []
    for it in results:
        out.append(
            {
                "x": _iso_ny(it["t"]),
                "o": float(it["o"]),
                "h": float(it["h"]),
                "l": float(it["l"]),
                "c": float(it["c"]),
                "v": float(it.get("v", 0)),
            }
        )
    return out


def _to_series(bars, title: str):
    """Convierte lista de barras a estructura usada por Plotly en el front."""
    return {
        "title": title,
        "x": [b["x"] for b in bars],
        "open": [b["o"] for b in bars],
        "high": [b["h"] for b in bars],
        "low": [b["l"] for b in bars],
        "close": [b["c"] for b in bars],
        "volume": [b["v"] for b in bars],
    }


def _dummy_series(start_dt: dt.datetime, n: int, step_min: int, title: str):
    """Serie sintética (fallback) para que la UI nunca quede vacía si falla la API."""
    xs, o, h, l, c, v = [], [], [], [], [], []
    cur = start_dt.astimezone(NY)
    px = 100.0
    for i in range(n):
        xs.append(cur.strftime("%Y-%m-%dT%H:%M"))
        drift = math.sin(i / 8.0) * 0.8
        rng = abs(math.cos(i / 5.0)) * 0.6 + 0.2
        op = px + drift
        hi = op + rng
        lo = op - rng
        cl = op + (rng * 0.4 - rng * 0.2)
        vol = 1_000 + (i % 10) * 300
        o.append(round(op, 2))
        h.append(round(hi, 2))
        l.append(round(lo, 2))
        c.append(round(cl, 2))
        v.append(vol)
        px = cl
        cur = cur + dt.timedelta(minutes=step_min)
    return {"title": title, "x": xs, "open": o, "high": h, "low": l, "close": c, "volume": v}


def home(request):
    # --- Rango por defecto: del 1er día del mes actual (NY) a hoy (NY) ---
    today_ny = now().astimezone(NY).date()
    first_day = today_ny.replace(day=1)

    # Permitir override desde querystring si lo deseas
    ticker = (request.GET.get("ticker") or "AAPL").upper()
    start_date = request.GET.get("start") or first_day.strftime("%Y-%m-%d")
    end_date = request.GET.get("end") or today_ny.strftime("%Y-%m-%d")

    # --- Cargar barras 10m desde Polygon (o dummy si hay error/429) ---
    ch10 = None
    try:
        bars10 = _aggs_polygon(ticker, 10, "minute", start_date, end_date)
        ch10 = _to_series(bars10, f"{ticker} · 10 minutos")
    except Exception as e:
        # Fallback (para no romper la UI). También útil en desarrollo sin API.
        start_dt = dt.datetime.combine(first_day, dt.time(9, 30, tzinfo=NY))
        ch10 = _dummy_series(start_dt, n=120, step_min=10, title=f"{ticker} · 10 minutos")
        # Si quieres ver el error en templates/logs:
        print("WARN: usando dummy 10m por error:", repr(e))

    # Puedes traer 30m/1D de Polygon si lo necesitas, pero la UI los reconstruye en vivo desde 10m.
    # ch30 y ch1d se dejan en None para no duplicar datos.
    ch30 = None
    ch1d = None

    # Panel de opción (lo dejamos vacío por ahora; cuando selecciones una de la cadena, lo llenamos)
    chopt = None

    bt_ctx = {
        "rb_hours": [20, 4],  # cierra hueco 20:00→04:00 (sin gaps entre AH y pre)
        "ch10": ch10,
        "ch30": ch30,
        "ch1d": ch1d,
        "chopt": chopt,
    }

    context = {
        "ticker": ticker,
        "start_date": start_date,  # type="date" espera YYYY-MM-DD
        "end_date": end_date,
        "bt_context_json": json.dumps(bt_ctx),  # <-- lo que lee backtest.js
        "option_chain": [],  # rellena si ya tienes tu cadena de opciones
    }
    return render(request, "backtests/home.html", context)
