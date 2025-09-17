import os
from datetime import datetime, date
from typing import Dict, Any, List, Tuple

import pandas as pd
from django.views.generic import TemplateView
from django.contrib import messages
from zoneinfo import ZoneInfo

from .forms import EquityQueryForm
from .services.marketdata import PolygonClient, PolygonConfig, PolygonError

# Zonas
MARKET_TZ = ZoneInfo("America/New_York")                       # ET
UI_TZ = ZoneInfo(os.getenv("TIME_ZONE", "America/Mexico_City"))  # ajusta en .env si quieres


class HomeView(TemplateView):
    """
    - 1 llamada a Polygon (10m)
    - 30m anclado a 09:30 ET
    - Diario por sesión (ET 09:30–16:00)
    - Sombreado pre (04:00–09:30 ET) y after (16:00–20:00 ET)
    - Fechas al front en ISO 'YYYY-MM-DDTHH:MM:SS' en tz de visualización (ET por defecto)
    - Rangebreak nocturno (20:00→04:00) en la tz de visualización
    """
    template_name = "backtests/home.html"

    def get_context_data(self, **kwargs) -> Dict[str, Any]:
        ctx = super().get_context_data(**kwargs)
        form = EquityQueryForm(self.request.GET or None)
        ctx["form"] = form

        # tz de visualización
        tz_mode = (self.request.GET.get("tz") or "et").lower()  # 'et' | 'local'
        display_tz = MARKET_TZ if tz_mode != "local" else UI_TZ
        ctx["tz_mode"] = tz_mode
        ctx["display_tz_name"] = str(display_tz)

        # outputs
        ctx["chart_10m"] = None
        ctx["chart_30m"] = None
        ctx["chart_1d"] = None
        ctx["chart_opt"] = None

        ctx["option_chain"] = []
        ctx["opt_selected"] = self.request.GET.get("opt") or None

        ctx["rb_hours"] = None  # par (h_start, h_end)

        if form.is_valid():
            api_key = os.getenv("POLYGON_API_KEY", "")
            ticker = form.cleaned_data["ticker"].upper()
            start_date = form.cleaned_data["start_date"].strftime("%Y-%m-%d")
            end_date = form.cleaned_data["end_date"].strftime("%Y-%m-%d")

            try:
                client = PolygonClient(PolygonConfig(api_key=api_key))

                # 1) 10m
                df_10m = client.get_equity_ohlcv(
                    ticker=ticker, start_date=start_date, end_date=end_date,
                    timespan="minute", multiplier=10, adjusted=True, sort="asc",
                )
                if df_10m.empty:
                    messages.info(self.request, f"No se encontraron datos para {ticker} en el rango solicitado.")
                    # aun así devolvemos un bt_context vacío
                    ctx["bt_context"] = {"ch10": None, "ch30": None, "ch1d": None, "chopt": None,
                                         "rb_hours": [20,4], "tz_name": str(display_tz)}
                    return ctx

                # 2) rangebreak nocturno en tz de visualización
                ctx["rb_hours"] = self._calc_rb_hours(display_tz, anchor=form.cleaned_data["start_date"])

                # 3) ventanas de pre/after convertidas a display_tz
                ext_windows = self._build_extended_windows(df_10m, display_tz)

                # 4) 30m anclado a 09:30 ET -> display_tz
                df_30m = self._resample_intraday_anchored(df_10m, "30min", display_tz)

                # 5) 1D por sesión -> display_tz
                df_1d = self._daily_from_intraday_session(df_10m, start_date, end_date, display_tz)

                # 6) payloads
                ctx["chart_10m"] = self._to_plotly_payload(f"{ticker} · 10 minutos", df_10m, display_tz, ext_windows)
                if not df_30m.empty:
                    ctx["chart_30m"] = self._to_plotly_payload(f"{ticker} · 30 minutos", df_30m, display_tz, ext_windows)
                if not df_1d.empty:
                    ctx["chart_1d"] = self._to_plotly_payload(f"{ticker} · 1 día (sesión)", df_1d, display_tz, None)

                # 7) cadena de opciones (as_of start_date)
                chain = client.list_option_contracts(
                    underlying=ticker, as_of=start_date, limit=200,
                    contract_type=None, sort="expiration_date", order="asc"
                )
                chain = self._filter_chain_by_exp(chain, start_date, days_ahead=60)
                chain = self._cap_chain(chain, max_rows=40)
                ctx["option_chain"] = chain

                # 8) opción (si hay selección)
                opt_ticker = ctx["opt_selected"]
                if opt_ticker:
                    df_opt = client.get_option_ohlcv(
                        option_ticker=opt_ticker, start_date=start_date, end_date=end_date,
                        timespan="minute", multiplier=10, adjusted=True, sort="asc",
                    )
                    if not df_opt.empty:
                        ctx["chart_opt"] = self._to_plotly_payload(f"{opt_ticker} · 10 minutos", df_opt, display_tz, ext_windows)

            except PolygonError as e:
                messages.error(self.request, f"Error de datos: {e}")
            except Exception as e:
                messages.error(self.request, f"Error inesperado: {e}")

        # 9) Contexto JSON para los JS (siempre lo entregamos)
        rb = ctx["rb_hours"] if ctx["rb_hours"] else (20, 4)
        ctx["bt_context"] = {
            "ch10":  ctx["chart_10m"],
            "ch30":  ctx["chart_30m"],
            "ch1d":  ctx["chart_1d"],
            "chopt": ctx["chart_opt"],
            "rb_hours": list(rb),
            "tz_name": ctx["display_tz_name"],
        }
        return ctx

    # ---------- Helpers ----------
    @staticmethod
    def _resample_intraday_anchored(df: pd.DataFrame, rule: str, display_tz: ZoneInfo) -> pd.DataFrame:
        if df.empty:
            return df
        dfi = df.copy()
        dfi = dfi.set_index(dfi["datetime"].dt.tz_convert(MARKET_TZ))
        agg = {"open":"first","high":"max","low":"min","close":"last","volume":"sum","vwap":"mean","trades":"sum"}
        out = dfi.resample(rule, origin="start_day", offset="9h30min",
                           label="right", closed="right").agg(agg)
        out = out.dropna(subset=["open","close"]).reset_index(names="dt_mkt")
        out["datetime"] = out["dt_mkt"].dt.tz_convert(display_tz)
        out = out.drop(columns=["dt_mkt"])
        return out

    @staticmethod
    def _daily_from_intraday_session(df: pd.DataFrame, start_date: str, end_date: str, display_tz: ZoneInfo) -> pd.DataFrame:
        if df.empty:
            return df
        dfi = df.copy()
        dfi["dt_mkt"] = dfi["datetime"].dt.tz_convert(MARKET_TZ)
        dfi["session_date"] = dfi["dt_mkt"].dt.date
        agg = {"open":"first","high":"max","low":"min","close":"last","volume":"sum","vwap":"mean","trades":"sum"}
        daily = dfi.groupby("session_date").agg(agg).reset_index()
        dt_close_et = pd.to_datetime(daily["session_date"]) + pd.to_timedelta("16:00:00")
        dt_close_et = dt_close_et.dt.tz_localize(MARKET_TZ)
        daily["datetime"] = dt_close_et.dt.tz_convert(display_tz)
        sd = datetime.strptime(start_date, "%Y-%m-%d").date()
        ed = datetime.strptime(end_date, "%Y-%m-%d").date()
        daily = daily[(daily["session_date"] >= sd) & (daily["session_date"] <= ed)]
        return daily[["datetime","open","high","low","close","volume","vwap","trades"]]

    @staticmethod
    def _build_extended_windows(df_10m: pd.DataFrame, display_tz: ZoneInfo) -> List[Dict[str, str]]:
        if df_10m.empty:
            return []
        rmin = df_10m["datetime"].min()
        rmax = df_10m["datetime"].max()
        dt_mkt = df_10m["datetime"].dt.tz_convert(MARKET_TZ)
        days = sorted(dt_mkt.dt.date.unique().tolist())
        windows: List[Dict[str, str]] = []
        for d in days:
            pm_start_et = pd.Timestamp(d, tz=MARKET_TZ) + pd.Timedelta(hours=4)
            pm_end_et   = pd.Timestamp(d, tz=MARKET_TZ) + pd.Timedelta(hours=9, minutes=30)
            ah_start_et = pd.Timestamp(d, tz=MARKET_TZ) + pd.Timedelta(hours=16)
            ah_end_et   = pd.Timestamp(d, tz=MARKET_TZ) + pd.Timedelta(hours=20)
            for kind, s_et, e_et in (("pm", pm_start_et, pm_end_et), ("ah", ah_start_et, ah_end_et)):
                s_disp = s_et.tz_convert(display_tz).tz_localize(None)
                e_disp = e_et.tz_convert(display_tz).tz_localize(None)
                if (pd.Timestamp(s_disp) <= rmax.tz_localize(None)) and (pd.Timestamp(e_disp) >= rmin.tz_localize(None)):
                    windows.append({
                        "kind": kind,
                        "start": s_disp.strftime("%Y-%m-%dT%H:%M:%S"),
                        "end":   e_disp.strftime("%Y-%m-%dT%H:%M:%S"),
                    })
        return windows

    @staticmethod
    def _calc_rb_hours(display_tz: ZoneInfo, anchor: date) -> Tuple[int, int]:
        d = pd.Timestamp(anchor, tz=MARKET_TZ)
        start_night_et = d + pd.Timedelta(hours=20)
        end_night_et   = d + pd.Timedelta(hours=4) + pd.Timedelta(days=1)
        start_local = start_night_et.tz_convert(display_tz)
        end_local   = end_local = end_night_et.tz_convert(display_tz)
        return (int(start_local.hour), int(end_local.hour))

    @staticmethod
    def _to_plotly_payload(title: str, df: pd.DataFrame, display_tz: ZoneInfo,
                           ext_windows: List[Dict[str, str]] | None) -> Dict[str, Any]:
        x_iso = df["datetime"].dt.tz_convert(display_tz).dt.tz_localize(None).dt.strftime("%Y-%m-%dT%H:%M:%S").tolist()
        payload = {
            "title": title,
            "x": x_iso,
            "open": df["open"].round(4).tolist(),
            "high": df["high"].round(4).tolist(),
            "low": df["low"].round(4).tolist(),
            "close": df["close"].round(4).tolist(),
            "volume": df["volume"].tolist(),
        }
        if ext_windows:
            payload["ext"] = ext_windows
        return payload

    @staticmethod
    def _filter_chain_by_exp(chain: List[Dict[str, Any]], start_date: str, days_ahead: int = 60) -> List[Dict[str, Any]]:
        if not chain:
            return chain
        sd = datetime.strptime(start_date, "%Y-%m-%d").date()
        end = sd.fromordinal(sd.toordinal() + days_ahead)
        out = []
        for c in chain:
            try:
                exp = datetime.strptime(c.get("expiration_date"), "%Y-%m-%d").date()
            except Exception:
                continue
            if sd <= exp <= end:
                c = dict(c)
                c["dte"] = (exp - sd).days
                out.append(c)
        out.sort(key=lambda r: (r.get("dte", 9999), r.get("strike_price", 0.0)))
        return out

    @staticmethod
    def _cap_chain(chain: List[Dict[str, Any]], max_rows: int = 40) -> List[Dict[str, Any]]:
        if len(chain) <= max_rows:
            return chain
        calls = [c for c in chain if (c.get("contract_type") or "").lower() == "call"]
        puts = [c for c in chain if (c.get("contract_type") or "").lower() == "put"]
        out: List[Dict[str, Any]] = []
        i = j = 0
        while len(out) < max_rows and (i < len(calls) or j < len(puts)):
            if i < len(calls): out.append(calls[i]); i += 1
            if len(out) >= max_rows: break
            if j < len(puts): out.append(puts[j]); j += 1
        return out
