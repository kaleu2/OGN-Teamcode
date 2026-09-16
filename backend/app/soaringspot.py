"""
Laedt eine oeffentliche SoaringSpot-Aufgabe:

1. Die Task-Seite liefert die Wendepunkt-Namen, Beobachtungszonen-Radien
   und die Reihenfolge - aber keine Koordinaten.
2. Die zugehoerige Downloads-Seite des Wettbewerbs liefert eine CUP-Datei
   mit allen Wendepunkten des Wettbewerbs inklusive Koordinaten.
3. Wir matchen die Namen aus (1) gegen die Koordinaten aus (2).

Funktioniert nur fuer oeffentliche Wettbewerbe (kein Login noetig), genau
wie vom Nutzer gewuenscht.
"""

import re

import requests
from bs4 import BeautifulSoup

from .cup import parse_cup

USER_AGENT = "Mozilla/5.0 (compatible; OGNTeamcodeTool/1.0; +https://example.invalid)"
REQUEST_TIMEOUT = 20


def _competition_base_url(task_url: str) -> str:
    m = re.match(r"(https?://www\.soaringspot\.com/[a-zA-Z_]+/[^/]+)/", task_url)
    if not m:
        raise ValueError(
            "Das sieht nicht nach einer SoaringSpot-Task-URL aus "
            "(erwartet: https://www.soaringspot.com/<sprache>/<wettbewerb>/tasks/...)"
        )
    return m.group(1)


def _parse_observation_zone(text: str):
    text = text.strip()
    m = re.search(r"R\s*=\s*([\d.]+)\s*km", text, re.IGNORECASE)
    if m:
        return float(m.group(1)), "cylinder"
    m = re.search(r"Radius\s*([\d.]+)\s*km", text, re.IGNORECASE)
    if m:
        return float(m.group(1)), "line"
    return 0.5, "cylinder"  # vorsichtiger Standardwert, falls Format unbekannt


def _find_turnpoint_table(soup: BeautifulSoup):
    for table in soup.find_all("table"):
        header_text = table.get_text(" ", strip=True).lower()
        if "turnpoint" in header_text and "distance" in header_text:
            return table
    return None


def _extract_turnpoints(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    table = _find_turnpoint_table(soup)
    if table is None:
        raise ValueError(
            "Konnte die Wendepunkt-Tabelle auf der Seite nicht finden. "
            "Ist es wirklich eine SoaringSpot-Task-Seite?"
        )

    turnpoints = []
    for row in table.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        name = cells[0].get_text(strip=True)
        if not name or name.lower().startswith("total"):
            continue
        obs_zone_text = cells[-1].get_text(strip=True)
        radius_km, zone_type = _parse_observation_zone(obs_zone_text)
        turnpoints.append({"name": name, "radius_km": radius_km, "zone_type": zone_type})

    if not turnpoints:
        raise ValueError("Keine Wendepunkte in der Tabelle gefunden")
    return turnpoints


def _find_cup_download_url(html: str, base_url: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.lower().endswith(".cup"):
            if href.startswith("http"):
                return href
            return base_url.rstrip("/") + "/" + href.lstrip("/")
    raise ValueError(
        "Auf der Downloads-Seite des Wettbewerbs wurde keine CUP-Wendepunktdatei gefunden."
    )


def fetch_task(task_url: str) -> dict:
    headers = {"User-Agent": USER_AGENT}

    resp = requests.get(task_url, headers=headers, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    turnpoints = _extract_turnpoints(resp.text)

    base = _competition_base_url(task_url)
    downloads_resp = requests.get(base + "/downloads", headers=headers, timeout=REQUEST_TIMEOUT)
    downloads_resp.raise_for_status()
    cup_url = _find_cup_download_url(downloads_resp.text, base)

    cup_resp = requests.get(cup_url, headers=headers, timeout=REQUEST_TIMEOUT)
    cup_resp.raise_for_status()
    try:
        cup_text = cup_resp.content.decode("utf-8")
    except UnicodeDecodeError:
        cup_text = cup_resp.content.decode("latin-1", errors="replace")

    waypoints = parse_cup(cup_text)
    by_name = {w["name"]: w for w in waypoints}
    by_name_lower = {w["name"].lower(): w for w in waypoints}

    resolved = []
    unresolved = []
    for tp in turnpoints:
        wp = by_name.get(tp["name"]) or by_name_lower.get(tp["name"].lower())
        if wp is None:
            unresolved.append(tp["name"])
            continue
        resolved.append(
            {
                "name": tp["name"],
                "lat": wp["lat"],
                "lon": wp["lon"],
                "radius_km": tp["radius_km"],
                "zone_type": tp["zone_type"],
            }
        )

    if not resolved:
        raise ValueError(
            "Keine der Wendepunkt-Namen aus der Aufgabe konnten in der "
            "Wendepunktdatei des Wettbewerbs wiedergefunden werden."
        )

    return {"turnpoints": resolved, "unresolved_names": unresolved}
