import os, json, time, hashlib, random, datetime as dt
from pathlib import Path
import pytz, requests
from django.conf import settings
from django.shortcuts import render
from django.views import View
from django.utils.timezone import now

# --- Config ---
NY = pytz.timezone("America/New_York")
POLYGON_KEY = os.getenv("POLYGON_API_KEY", getattr(settings, "POLYGON_API_KEY", ""))
BASE_URL = "https://api.polygon.io"

BASE_DIR = Path(getattr(settings, "BASE_DIR", Path(__file__).resolve().parents[1]))
CACHE_DIR = BASE_DIR / "data_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

MAX_RETRIES_429 = 2

# --- Helpers ---
def _as_iso_ny(ms_utc: int) -> str:
    t = dt.datetime.utcfromtimestamp(ms_utc/1000).replace(tzinfo=pytz.UTC).astimezone(NY)
    return t.strftime("%Y-%m-%dT%H:%M")

def _cache_file(ticker: str, mult: int, span: str, dfrom: str, dto: str) -> Path:
    h = hashlib.md5(f"{ticker}|{mult}|{span}|{dfrom}|{dto}".encode()).hexdigest()
    return CACHE_DIR / f"aggs_{h}.json"

def _http_get_backoff(url: str, params: dict):
    tries = 0
    while True:
        tries += 1
        r = requests.get(url, params=params, timeout=20)
        if r.status_code == 429 and tries <= MAX_RETRIES_429:
            wait_s = 1.2
            ra = r.headers.get("Retry-After")
            if ra:
                try: wait_s = max(wait_s, float(ra))
                except: pass
            time.sleep(wait_s)
            continue
        r.raise_for_status()
        return r

def _aggs_polygon(ticker: str, mult: int, span: str, dfrom: str, dto: str):
    if not POLYGON_KEY:
        raise RuntimeError("Falta POLYGON_API_KEY (usaremos dummy)")

    cache = _cache_file(ticker, mult, span, dfrom, dto)
    if cache.exists():
        data = json.loads(cache.read_text(encoding="utf-8"))
    else:
        url = f"{BASE_URL}/v2/aggs/ticker/{ticker}/range/{mult}/{span}/{dfrom}/{dto}"
        params = {"adjusted":"true","sort":"asc","limit":50000,"apiKey":POLYGON_KEY}
        j = _http_get_backoff(url, params).json()
        out = j.get("results", []) or []
        nxt = j.get("next_url")
        while nxt:
            jn = _http_get_backoff(nxt, {"apiKey":POLYGON_KEY}).json()
            out.extend(jn.get("results", []) or [])
            nxt = jn.get("next_url")
        data = {"results": out}
        try: cache.write_text(json.dumps(data), encoding="utf-8")
        except: pass

    bars=[]
    for it in data.get("results", []) or []:
        bars.append({"x":_as_iso_ny(it["t"]), "o":float(it["o"]), "h":float(it["h"]),
                     "l":float(it["l"]), "c":float(it["c"]), "v":float(it.get("v",0))})
    return bars

def _to_series(bars, title: str):
    return {"title": title,
            "x":[b["x"] for b in bars], "open":[b["o"] for b in bars],
            "high":[b["h"] for b in bars], "low":[b["l"] for b in bars],
            "close":[b["c"] for b in bars], "volume":[b["v"] for b in bars]}

def _dummy_series(start_dt: dt.datetime, n: int, step_min: int, title: str, base_px: float = 240.0):
    xs,o,h,l,c,v=[],[],[],[],[],[]
    cur = start_dt.astimezone(NY); random.seed(int(start_dt.timestamp()))
    px = base_px; k = 0.02; sigma = 0.25
    for _ in range(n):
        xs.append(cur.strftime("%Y-%m-%dT%H:%M"))
        shock = random.gauss(0.0, sigma); nx = px + shock + k*(base_px - px)
        hi = max(px,nx) + abs(random.gauss(0, sigma*0.6))
        lo = min(px,nx) - abs(random.gauss(0, sigma*0.6))
        hour = cur.hour
        vf = 0.6
        if 9 <= hour <= 10: vf = 1.2
        elif 15 <= hour <= 16: vf = 1.0
        vol = int(1_000_000*vf*max(0.2, 1+random.gauss(0,0.15)))
        o.append(round(px,2)); h.append(round(hi,2)); l.append(round(lo,2)); c.append(round(nx,2)); v.append(vol)
        px = nx; cur += dt.timedelta(minutes=step_min)
    return {"title":title,"x":xs,"open":o,"high":h,"low":l,"close":c,"volume":v}

# --- Vista principal ---
def home(request):
    """
    - 10m: pedimos hasta end_date + 3 días para cubrir el último día (04:00–20:00).
    - 1d : entregamos histórico (para 100 velas) y el front lo fusiona con el 1d "live".
    - 30m: live desde 10m (sin histórico).
    """
    today = now().astimezone(NY).date()
    first = today.replace(day=1)

    ticker = (request.GET.get("ticker") or "AAPL").upper()
    start_date = request.GET.get("start") or first.strftime("%Y-%m-%d")
    end_date   = request.GET.get("end")   or today.strftime("%Y-%m-%d")

    try: sd = dt.date.fromisoformat(start_date)
    except: sd = first
    try: ed = dt.date.fromisoformat(end_date)
    except: ed = today

    d_from = sd.strftime("%Y-%m-%d")
    d_to_plus = (ed + dt.timedelta(days=3)).strftime("%Y-%m-%d")  # <- más margen

    # 10m (base para 30m y 1d live)
    try:
        ch10 = _to_series(_aggs_polygon(ticker, 10, "minute", d_from, d_to_plus), f"{ticker} · 10 minutos")
    except Exception as e:
        print("WARN 10m:", repr(e))
        days = max(1, (ed - sd).days + 3)
        n = days * 96  # 16h/día * 6 barras/hora
        start_dt = dt.datetime.combine(sd, dt.time(4,0, tzinfo=NY))
        ch10 = _dummy_series(start_dt, n, 10, f"{ticker} · 10 minutos", 240.0)

    # 1d histórico (para prefijar hasta 100 velas previas a play_from)
    try:
        d1_from = (sd - dt.timedelta(days=220)).strftime("%Y-%m-%d")
        d1_to   = d_to_plus
        ch1d_hist = _to_series(_aggs_polygon(ticker, 1, "day", d1_from, d1_to), f"{ticker} · 1 día (hist)")
    except Exception as e:
        print("WARN 1d hist:", repr(e))
        # 150 días dummy
        start_dt = dt.datetime.combine(ed - dt.timedelta(days=150), dt.time(9,30,tzinfo=NY))
        ch1d_hist = _dummy_series(start_dt, 150, 60*24, f"{ticker} · 1 día (hist)", 240.0)

    bt_ctx = {
        "rb_hours": [20, 4],                  # oculto nocturno 20:00→04:00
        "ch10": ch10,                         # 10m (base live)
        "ch1d_hist": ch1d_hist,               # 1d histórico
        "play_from": f"{sd.strftime('%Y-%m-%d')}T00:00",
    }

    return render(request, "backtests/home.html", {
        "ticker": ticker,
        "start_date": sd.strftime("%Y-%m-%d"),
        "end_date": ed.strftime("%Y-%m-%d"),
        "bt_context_json": json.dumps(bt_ctx),
    })

class HomeView(View):
    def get(self, request, *args, **kwargs):
        return home(request)
