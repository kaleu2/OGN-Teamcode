"""
Bindet externe WMS-Dienste (DWD Radar, EUMETSAT Satellit) ein.

Beide Dienste sind oeffentliche, standardkonforme OGC-WMS-Dienste, die auch
direkt von Leaflet (L.tileLayer.wms) angesprochen werden koennen. Wir muessen
serverseitig nur herausfinden:
  - welcher Layer-Name aktuell tatsaechlich existiert (Namen aendern sich
    gelegentlich, z.B. bei DWD zwischen RX-/WN-Produkt), und
  - welche Zeitstempel fuer diesen Layer verfuegbar sind (fuer die
    Abspielfunktion).

Da wir das von hier aus nicht live gegen die echten Dienste testen konnten
(Netzwerk-Restriktion der Entwicklungsumgebung), ist das bewusst
selbstdiagnostizierend gebaut: Statt einen vermuteten Layer-Namen stur zu
benutzen, wird beim ersten Zugriff live bei den Diensten nachgefragt, welcher
der Kandidaten-Namen tatsaechlich existiert. Falls keiner passt, bekommt man
eine Liste "aehnlicher" Layer-Namen zurueck, die tatsaechlich existieren -
das macht ein Korrigieren viel schneller als aus einer stillen 404 zu raten.
"""

import logging
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import requests

logger = logging.getLogger(__name__)

WMS_NS = "{http://www.opengis.net/wms}"
REQUEST_TIMEOUT = 20

DWD_WMS_URL = "https://maps.dwd.de/geoserver/dwd/wms"
# DWD betreibt mehrere gleichwertige Endpunkte (Produktiv-, Ausfall-, Proxy-System).
# Bei einem 503 (voruebergehend ueberlastet/Wartung) probieren wir die anderen.
DWD_WMS_URLS = [
    "https://maps.dwd.de/geoserver/dwd/wms",
    "https://maps.dwd.de/geoproxy/wms",
    "https://brz-maps.dwd.de/geoserver/dwd/wms",
]
# Reihenfolge = Prioritaet. "rv" (RADOLAN RV) ist der Nowcast (inkl.
# Kurzfristvorhersage), daher bevorzugt. Stand: von DWD per GetCapabilities
# bestaetigte tatsaechliche Namen (Sept. 2026) - DWD benennt diese gelegentlich um,
# siehe "similar_layers_found" im Fehlerfall fuer die dann aktuellen Namen.
DWD_LAYER_CANDIDATES = [
    "Radar_rv_product_1x1km_ger",
    "Radar_wn-analysis_1x1km_ger",
    "Radar_wn-product_1x1km_ger",
    # alte Namen als letzter Versuch, falls DWD zwischenzeitlich zurueckwechselt
    "dwd:RV-Produkt",
    "dwd:WN-Produkt",
    "dwd:RX-Produkt",
]

EUMETSAT_WMS_URL = "https://view.eumetsat.int/geoserver/wms"
# Kandidaten fuer ein 0-Grad-Dienst (Europa/Afrika) Echtfarben- oder
# Airmass-Produkt. Wird live gegen die tatsaechlich vorhandenen Layer geprueft.
EUMETSAT_LAYER_CANDIDATES = [
    "mtg_fd:rgb_geocolour",
    "mtg_fd:rgb_airmass",
    "msg_fes:rgb_geocolour",
    "Meteosat:msg_airmass",
    "Meteosat:msg_natural",
]

_cache: dict[str, dict] = {}
_cache_fetched_at: dict[str, float] = {}
CACHE_TTL_SECONDS = 60  # Zeitachse soll zeitnah aktuell bleiben, nicht am Serverstart einfrieren


def _fetch_capabilities(wms_url: str) -> ET.Element:
    resp = requests.get(
        wms_url,
        params={"service": "WMS", "version": "1.3.0", "request": "GetCapabilities"},
        timeout=REQUEST_TIMEOUT,
        headers={"User-Agent": "Mozilla/5.0 (compatible; OGNTeamcodeTool/1.0)"},
    )
    resp.raise_for_status()
    return ET.fromstring(resp.content)


def _all_layers(root: ET.Element) -> dict[str, dict]:
    """Liefert {layer_name: {title, times}} fuer alle benannten Layer."""
    layers = {}
    for layer_el in root.iter(f"{WMS_NS}Layer"):
        name_el = layer_el.find(f"{WMS_NS}Name")
        if name_el is None or not name_el.text:
            continue
        title_el = layer_el.find(f"{WMS_NS}Title")

        times = None
        for dim in layer_el.findall(f"{WMS_NS}Dimension"):
            if dim.get("name") == "time" and dim.text:
                times = dim.text.strip()
        if times is None:
            # manche GeoServer-Versionen nutzen Extent statt Dimension fuer den Wert
            for ext in layer_el.findall(f"{WMS_NS}Extent"):
                if ext.get("name") == "time" and ext.text:
                    times = ext.text.strip()

        layers[name_el.text] = {
            "title": title_el.text if title_el is not None else name_el.text,
            "times_raw": times,
        }
    return layers


_ISO_DURATION_RE = re.compile(r"^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$")


def _parse_iso_duration(s: str) -> timedelta | None:
    m = _ISO_DURATION_RE.match(s.strip())
    if not m:
        return None
    hours, minutes, seconds = m.groups()
    return timedelta(
        hours=int(hours) if hours else 0,
        minutes=int(minutes) if minutes else 0,
        seconds=float(seconds) if seconds else 0,
    )


def _parse_iso_datetime(s: str):
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _parse_time_values(times_raw: str | None, max_frames: int = 60) -> list[str]:
    """WMS-Zeitangaben sind entweder kommagetrennte ISO-Zeiten oder ein
    Intervall 'start/end/period' (z.B. 'PT5M'). Manche Layer (z.B. DWD "RV" =
    Analyse UND Vorhersage) haben ein Ende, das in der Zukunft liegt (die
    Vorhersage-Grenze) - nimmt man dort einfach "die letzten N Schritte vor
    dem Ende", besteht die Liste fast nur aus Vorhersage-Frames und "jetzt"
    fehlt komplett. Wir zentrieren das Fenster daher um die tatsaechliche
    aktuelle Uhrzeit: bis zu 2 Stunden Vergangenheit plus alles bis zum
    deklarierten Ende (Vorhersage), begrenzt durch max_frames insgesamt."""
    if not times_raw:
        return []

    if "/" in times_raw and "," not in times_raw:
        parts = times_raw.split("/")
        if len(parts) == 3:
            start_dt = _parse_iso_datetime(parts[0])
            end_dt = _parse_iso_datetime(parts[1])
            step = _parse_iso_duration(parts[2])
            if start_dt and end_dt and step and step.total_seconds() > 0:
                now = datetime.now(timezone.utc)
                past_window = timedelta(hours=2)
                window_start = max(start_dt, min(now - past_window, end_dt))
                # auf ein Vielfaches von step ab start_dt ausrichten, damit die
                # erzeugten Zeitstempel exakt zu denen des Dienstes passen
                steps_from_start = int((window_start - start_dt) / step)
                window_start = start_dt + step * steps_from_start

                total_steps = int((end_dt - window_start) / step)
                count = min(max_frames, total_steps + 1)
                return [
                    (window_start + step * i).strftime("%Y-%m-%dT%H:%M:%SZ")
                    for i in range(count)
                ]
        # Format unerwartet - lieber nichts als falsche/verwirrende Werte liefern
        return []

    values = [v.strip() for v in times_raw.split(",") if v.strip()]
    return values[-max_frames:]


def resolve_layer(wms_url: str, candidates: list[str]) -> dict:
    cache_key = wms_url
    is_stale = (
        cache_key not in _cache
        or time.time() - _cache_fetched_at.get(cache_key, 0) > CACHE_TTL_SECONDS
    )
    if is_stale:
        try:
            root = _fetch_capabilities(wms_url)
            _cache[cache_key] = _all_layers(root)
            _cache_fetched_at[cache_key] = time.time()
        except Exception as e:
            if cache_key in _cache:
                # Alten Stand weiterverwenden, wenn die Aktualisierung fehlschlaegt,
                # statt komplett auszufallen (z.B. bei einem kurzen 503).
                logger.warning("WMS-Refresh fehlgeschlagen, nutze letzten Stand: %s", wms_url)
            else:
                logger.exception("WMS-Capabilities nicht erreichbar: %s", wms_url)
                return {"found": False, "error": str(e), "wms_url": wms_url}

    all_layers = _cache[cache_key]

    for candidate in candidates:
        if candidate in all_layers:
            info = all_layers[candidate]
            return {
                "found": True,
                "wms_url": wms_url,
                "layer": candidate,
                "title": info["title"],
                "times": _parse_time_values(info["times_raw"]),
            }

    # Keiner der Kandidaten existiert - liefere ein paar aehnliche Namen als
    # Hilfestellung, damit sich das schnell reparieren laesst.
    keywords = [c.split(":")[-1].split("-")[0].lower() for c in candidates]
    similar = [
        name
        for name in all_layers
        if any(k in name.lower() or k in all_layers[name]["title"].lower() for k in keywords)
    ][:15]

    return {
        "found": False,
        "wms_url": wms_url,
        "tried": candidates,
        "similar_layers_found": similar,
        "total_layers_on_server": len(all_layers),
    }


def resolve_layer_multi(wms_urls: list[str], candidates: list[str]) -> dict:
    """Wie resolve_layer, probiert aber mehrere gleichwertige Server-Endpunkte
    der Reihe nach durch (z.B. DWD Produktiv-/Ausfall-/Proxy-System), falls
    einer davon voruebergehend nicht erreichbar ist (503, SSL-Fehler o.ae.)."""
    all_errors = []
    for url in wms_urls:
        result = resolve_layer(url, candidates)
        if result.get("found") or "error" not in result:
            return result
        all_errors.append({"url": url, "error": result["error"]})

    return {
        "found": False,
        "error": all_errors[-1]["error"] if all_errors else "Unbekannter Fehler",
        "all_attempts": all_errors,
        "wms_url": wms_urls[0] if wms_urls else None,
    }


def get_dwd_radar_info() -> dict:
    return resolve_layer_multi(DWD_WMS_URLS, DWD_LAYER_CANDIDATES)


def get_eumetsat_info() -> dict:
    return resolve_layer(EUMETSAT_WMS_URL, EUMETSAT_LAYER_CANDIDATES)
