"""
Einfacher Parser fuer SeeYou-CUP-Wendepunktdateien.

Format pro Zeile (kommagetrennt, Werte teils in Anfuehrungszeichen):
  name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc
Beispiel:
  "Aachen-Merzbruck","AACHEN",DE,5047.017N,00609.900E,189.0m,5,00,0.0m,,,

Koordinatenformat: DDMM.mmm{N|S} fuer Breite, DDDMM.mmm{E|W} fuer Laenge.

Eine optionale Aufgaben-Sektion (Zeile "-----Related Tasks-----" oder
aehnlich) wird ignoriert - uns interessieren nur die Wendepunkte selbst.
"""

import csv
import io


def _parse_coord(raw: str, degree_digits: int) -> float:
    raw = raw.strip()
    if not raw:
        raise ValueError("Leeres Koordinatenfeld")
    hemisphere = raw[-1].upper()
    number_part = raw[:-1]
    if hemisphere not in ("N", "S", "E", "W"):
        raise ValueError(f"Unbekannte Himmelsrichtung in {raw!r}")

    degrees = int(number_part[:degree_digits])
    minutes = float(number_part[degree_digits:])
    value = degrees + minutes / 60.0

    if hemisphere in ("S", "W"):
        value = -value
    return value


def parse_cup(content: str) -> list[dict]:
    if content.startswith("\ufeff"):
        content = content.lstrip("\ufeff")

    waypoints = []
    reader = csv.reader(io.StringIO(content), skipinitialspace=True)

    for row in reader:
        if not row:
            continue
        first = row[0].strip()
        if not first:
            continue
        if first.startswith("-----"):
            break  # Beginn der Aufgaben-Sektion, hier hoeren wir auf
        if first.lower() == "name":
            continue  # Kopfzeile
        if len(row) < 5:
            continue  # Zeile unvollstaendig, ueberspringen

        try:
            name = first
            code = row[1].strip() if len(row) > 1 else ""
            lat = _parse_coord(row[3], degree_digits=2)
            lon = _parse_coord(row[4], degree_digits=3)
        except (ValueError, IndexError):
            continue  # kaputte Zeile ueberspringen, Rest weiterverarbeiten

        waypoints.append({"name": name, "code": code, "lat": lat, "lon": lon})

    return waypoints
