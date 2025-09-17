import os
import time
from dataclasses import dataclass
from typing import Dict, Any, List, Optional

import requests
import pandas as pd
from zoneinfo import ZoneInfo


class PolygonError(Exception):
    """Error de capa de datos para respuestas de Polygon."""


class RateLimitError(PolygonError):
    """Error específico para HTTP 429 con segundos sugeridos de espera."""
    def __init__(self, sleep_seconds: float = 2.0):
        super().__init__(f"Rate limit. Reintenta en ~{sleep_seconds}s.")
        self.sleep_seconds = sleep_seconds


@dataclass
class PolygonConfig:
    api_key: str
    base_url: str = "https://api.polygon.io"
    timezone_out: str = os.getenv("TIME_ZONE", "America/Merida")  # salida para gráficos


class PolygonClient:
    """
    Cliente minimalista para Polygon.
    - Autenticación por apiKey.
    - Fase 2: agregados OHLCV de acciones.
    - Fase 2.1: cadena de opciones + OHLCV de opciones.
    """

    def __init__(self, config: PolygonConfig):
        if not config.api_key:
            raise PolygonError("Falta POLYGON_API_KEY en el entorno (.env).")
        self.cfg = config
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": "optbacktest/0.2 (Django)"})

    # ---------------------
    # Utilidades internas
    # ---------------------
    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.cfg.base_url}{path}"
        q = dict(params or {})
        q["apiKey"] = self.cfg.api_key
        r = self.s.get(url, params=q, timeout=30)

        # Manejo explícito de rate limit
        if r.status_code == 429:
            retry_after_hdr = r.headers.get("Retry-After") or r.headers.get("x-ratelimit-reset")
            try:
                retry_after = float(retry_after_hdr) if retry_after_hdr else 2.0
            except Exception:
                retry_after = 2.0
            raise RateLimitError(sleep_seconds=min(retry_after, 10.0))

        if r.status_code >= 400:
            snippet = r.text[:300].replace("\n", " ")
            raise PolygonError(f"HTTP {r.status_code} en {url}: {snippet}")

        j = r.json()
        if isinstance(j, dict) and j.get("error"):
            raise PolygonError(f"Error de API en {url}: {j.get('error')}")
        return j

    @staticmethod
    def _results_to_df(results: List[Dict[str, Any]], tz_out: str) -> pd.DataFrame:
        if not results:
            return pd.DataFrame(columns=["datetime", "open", "high", "low", "close", "volume", "vwap", "trades"])
        df = pd.DataFrame(results)
        # Campos /v2/aggs: t(ms), o,h,l,c,v,n,vw
        df["datetime"] = pd.to_datetime(df["t"], unit="ms", utc=True).dt.tz_convert(ZoneInfo(tz_out))
        rename_map = {"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume", "n": "trades", "vw": "vwap"}
        df = df.rename(columns=rename_map)[["datetime", "open", "high", "low", "close", "volume", "vwap", "trades"]]
        return df

    def _aggs(
        self,
        ticker: str,
        start_date: str,
        end_date: str,
        timespan: str,
        multiplier: int,
        adjusted: bool = True,
        limit: int = 50000,
        sort: str = "asc",
        retry: int = 3,
        retry_sleep: float = 2.0,
    ) -> pd.DataFrame:
        """
        Lector genérico de Aggregate Bars (acciones u opciones).
        """
        path = f"/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{start_date}/{end_date}"
        params = {"adjusted": "true" if adjusted else "false", "sort": sort, "limit": limit}

        base_sleep = max(retry_sleep, 1.0)
        for attempt in range(retry + 1):
            try:
                j = self._get(path, params)
                res = j.get("results", [])
                return self._results_to_df(res, self.cfg.timezone_out)

            except RateLimitError as e:
                wait_s = e.sleep_seconds + (0.5 * attempt)
                time.sleep(min(wait_s, 12.0))
                continue

            except (requests.Timeout, requests.ConnectionError):
                time.sleep(min(base_sleep * (2 ** attempt), 10.0))
                continue

            except Exception as ex:
                if attempt < retry:
                    time.sleep(min(base_sleep * (1 + attempt), 8.0))
                    continue
                raise PolygonError(str(ex))

        raise PolygonError("No fue posible obtener datos tras múltiples reintentos.")

    # ---------------------
    # Endpoints públicos
    # ---------------------
    def get_equity_ohlcv(
        self,
        ticker: str,
        start_date: str,
        end_date: str,
        timespan: str = "day",
        multiplier: int = 1,
        adjusted: bool = True,
        limit: int = 50000,
        sort: str = "asc",
        retry: int = 3,
        retry_sleep: float = 2.0,
    ) -> pd.DataFrame:
        """OHLCV de acciones (ticker p.ej. 'AAPL')."""
        return self._aggs(
            ticker=ticker.upper(),
            start_date=start_date,
            end_date=end_date,
            timespan=timespan,
            multiplier=multiplier,
            adjusted=adjusted,
            limit=limit,
            sort=sort,
            retry=retry,
            retry_sleep=retry_sleep,
        )

    def get_option_ohlcv(
        self,
        option_ticker: str,
        start_date: str,
        end_date: str,
        timespan: str = "minute",
        multiplier: int = 10,
        adjusted: bool = True,
        limit: int = 50000,
        sort: str = "asc",
        retry: int = 3,
        retry_sleep: float = 2.0,
    ) -> pd.DataFrame:
        """
        OHLCV de opciones (ticker formato Polygon, ej. 'O:SPY251219C00650000').
        Default: 10 minutos para alinearse al timeline de 10m.
        """
        return self._aggs(
            ticker=option_ticker,
            start_date=start_date,
            end_date=end_date,
            timespan=timespan,
            multiplier=multiplier,
            adjusted=adjusted,
            limit=limit,
            sort=sort,
            retry=retry,
            retry_sleep=retry_sleep,
        )

    def list_option_contracts(
        self,
        underlying: str,
        as_of: str,
        limit: int = 200,
        contract_type: Optional[str] = None,  # 'call' | 'put' | None
        sort: str = "expiration_date",
        order: str = "asc",
    ) -> List[Dict[str, Any]]:
        """
        Devuelve una lista de contratos de opciones “as of” una fecha.
        Usa /v3/reference/options/contracts (primera página; evitamos múltiples calls por cuota).
        """
        path = "/v3/reference/options/contracts"
        params: Dict[str, Any] = {
            "underlying_ticker": underlying.upper(),
            "as_of": as_of,
            "limit": min(max(limit, 1), 1000),
            "sort": sort,
            "order": order,
        }
        if contract_type in {"call", "put"}:
            params["contract_type"] = contract_type

        j = self._get(path, params)
        results = j.get("results", []) or []
        # Normalizamos algunos campos esperados en template:
        out = []
        for r in results:
            out.append({
                "ticker": r.get("ticker"),
                "expiration_date": r.get("expiration_date"),
                "strike_price": r.get("strike_price"),
                "contract_type": r.get("contract_type"),  # 'call' / 'put'
                "exercise_style": r.get("exercise_style"),
            })
        return out
