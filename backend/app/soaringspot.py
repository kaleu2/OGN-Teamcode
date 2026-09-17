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
from datetime import date
from urllib.parse import urljoin

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
        # Bei manchen (neueren) Wettbewerben steht die Dateiendung nur im
        # sichtbaren Linktext, nicht in der URL (z.B. eine anonyme ID wie
        # /download-contest-file/5215-41180) - daher beides pruefen.
        text = a.get_text(strip=True)
        if href.lower().endswith(".cup") or text.lower().endswith(".cup"):
            # urljoin loest sowohl absolute URLs als auch wurzel-relative
            # Pfade (fuehrendes "/") als auch normale relative Pfade korrekt
            # auf - eigenes String-Verketten hatte bei wurzel-relativen
            # Pfaden faelschlich die Wettbewerbs-URL verdoppelt.
            return urljoin(base_url + "/", href)
    raise ValueError(
        "Auf der Downloads-Seite des Wettbewerbs wurde keine CUP-Wendepunktdatei gefunden."
    )


def _find_all_txt_download_urls(html: str, base_url: str) -> list[str]:
    """Luftraum-Dateien (OpenAir) werden auf SoaringSpot-Downloads-Seiten
    praktisch immer als .txt verlinkt - andere Dateitypen dort sind .cup,
    .gpx, .wpz o.ae., .txt ist in der Praxis eindeutig genug. Wie bei der
    CUP-Datei wird sowohl die URL als auch der sichtbare Linktext geprueft."""
    soup = BeautifulSoup(html, "lxml")
    urls = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(strip=True)
        if href.lower().endswith(".txt") or text.lower().endswith(".txt"):
            urls.append(urljoin(base_url + "/", href))
    return urls


def _fetch_and_decode(url: str, headers: dict) -> str:
    resp = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    try:
        return resp.content.decode("utf-8")
    except UnicodeDecodeError:
        return resp.content.decode("latin-1", errors="replace")


def _extract_inactive_airspaces(html: str) -> list[str]:
    """Liest die Zeile "Inactive airspaces: A, B, C" von der Task-Seite aus,
    falls SoaringSpot fuer den Tag welche ausweist (typischerweise zeitlich
    begrenzte Sperrgebiete/Fallschirmzonen, z.B. "EDR96 Romrod MON-FRI").
    Nicht jede Aufgabe hat solche Eintraege - dann leere Liste.

    Ueber get_text() statt eines festen Tag-Patterns, weil wir die konkrete
    HTML-Struktur dieser Zeile nicht gegen die echte Seite verifizieren
    konnten (Netzwerk-Restriktion der Entwicklungsumgebung) - das ist robuster
    gegenueber einem <strong>/<span>/<p>-Wechsel als ein fest angenommenes Tag.
    """
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text("\n")
    m = re.search(r"Inactive airspaces:\s*(.+)", text)
    if not m:
        return []
    return [name.strip() for name in m.group(1).split(",") if name.strip()]


def _find_task_links_for_date(html: str, target_date: str) -> dict[str, str]:
    """Findet Links der Form '/tasks/<klasse>/task-N-on-<datum>' und liefert
    {klasse: absolute_url} - ein Eintrag pro gefundener Klasse fuer das
    angegebene Datum (YYYY-MM-DD)."""
    pattern = re.compile(r"/tasks/([^/]+)/(task-\d+-on-" + re.escape(target_date) + r")")
    soup = BeautifulSoup(html, "lxml")
    found: dict[str, str] = {}
    for a in soup.find_all("a", href=True):
        href = a["href"]
        m = pattern.search(href)
        if not m:
            continue
        klass = m.group(1)
        url = urljoin("https://www.soaringspot.com/", href)
        found.setdefault(klass, url)
    return found


def fetch_task(task_url: str) -> dict:
    headers = {"User-Agent": USER_AGENT}

    resp = requests.get(task_url, headers=headers, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    turnpoints = _extract_turnpoints(resp.text)
    inactive_airspaces = _extract_inactive_airspaces(resp.text)

    base = _competition_base_url(task_url)
    downloads_resp = requests.get(base + "/downloads", headers=headers, timeout=REQUEST_TIMEOUT)
    downloads_resp.raise_for_status()
    cup_url = _find_cup_download_url(downloads_resp.text, base)
    cup_text = _fetch_and_decode(cup_url, headers)

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

    return {
        "turnpoints": resolved,
        "unresolved_names": unresolved,
        "inactive_airspaces": inactive_airspaces,
    }


def fetch_competition_today(any_competition_url: str) -> dict:
    """Automatik-Import: ausgehend von IRGENDEINEM Link zu einem Wettbewerb
    (Hauptseite oder eine einzelne Task-Seite) werden automatisch geladen:
      - die Aufgaben des heutigen Tages in ALLEN verfuegbaren Klassen
      - die Luftraum-Datei (OpenAir .txt) von der Downloads-Seite
      - die CUP-Wendepunktdatei des Wettbewerbs (fuer die Referenzpunkt-Auswahl)

    Wichtiger Hinweis: Die Erkennung "alle Klassen am heutigen Tag" beruht
    auf einem Muster (Links der Form /tasks/<klasse>/task-N-on-<heute> auf
    der Wettbewerbs-Hauptseite bzw. deren /results-Unterseite). Das konnte
    nicht live gegen echtes SoaringSpot getestet werden - falls an einem
    echten Wettbewerbstag keine Aufgaben gefunden werden, obwohl welche
    online stehen, liegt es wahrscheinlich an einer abweichenden Seiten-
    struktur, die wir dann gezielt nachbessern koennen.
    """
    headers = {"User-Agent": USER_AGENT}
    base = _competition_base_url(any_competition_url + "/")  # funktioniert auch mit einer nackten Basis-URL
    today = date.today().isoformat()

    class_task_urls: dict[str, str] = {}
    for suffix in ("", "/results"):
        try:
            resp = requests.get(base + suffix, headers=headers, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            class_task_urls.update(_find_task_links_for_date(resp.text, today))
        except requests.RequestException:
            continue

    no_tasks_note = None
    if not class_task_urls:
        no_tasks_note = (
            f"Keine Aufgaben fuer den heutigen Tag ({today}) gefunden. Entweder ist heute "
            "kein Wettbewerbstag, die Aufgaben sind auf SoaringSpot noch nicht "
            "veroeffentlicht, oder die Seitenstruktur weicht von der erwarteten ab. "
            "Luftraum und Wendepunkte wurden trotzdem geladen, falls verfuegbar."
        )

    tasks = []
    for klass, task_url in class_task_urls.items():
        try:
            result = fetch_task(task_url)
            tasks.append({"class": klass, "task_url": task_url, **result})
        except Exception as e:
            tasks.append({"class": klass, "task_url": task_url, "error": str(e)})

    # Luftraum + Wendepunktdatei sind unabhaengig von veroeffentlichten Aufgaben
    # nuetzlich - werden daher IMMER versucht, auch wenn oben keine Aufgabe
    # gefunden wurde (z.B. am Anreisetag oder vor der Aufgabenbesprechung).
    airspace_url = None
    cup_waypoints = []
    try:
        downloads_resp = requests.get(base + "/downloads", headers=headers, timeout=REQUEST_TIMEOUT)
        downloads_resp.raise_for_status()

        txt_urls = _find_all_txt_download_urls(downloads_resp.text, base)
        if txt_urls:
            airspace_url = txt_urls[0]

        cup_url = _find_cup_download_url(downloads_resp.text, base)
        cup_waypoints = parse_cup(_fetch_and_decode(cup_url, headers))
    except Exception:
        pass  # Airspace/CUP sind hier "nice to have", kein harter Fehler

    return {
        "date": today,
        "tasks": tasks,
        "airspace_url": airspace_url,
        "cup_waypoints": cup_waypoints,
        "note": no_tasks_note,
    }
