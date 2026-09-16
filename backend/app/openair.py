"""
Parser fuer Luftraum-Dateien im OpenAir-Format (.txt).

Unterstuetzte Befehle:
  AC  - Luftraumklasse (z.B. CTR, D, TMZ, R, Q, P)
  AN  - Name
  AL  - Untergrenze
  AH  - Obergrenze
  DP  - Polygonpunkt (Breite/Laenge)
  V X=lat,lon - Mittelpunkt fuer nachfolgende Boegen/Kreise
  V D=+/-     - Drehrichtung (im/gegen Uhrzeigersinn) fuer DA/DB
  DA radius,winkel1,winkel2 - Bogen um den Mittelpunkt (Radius in NM)
  DB lat1,lon1,lat2,lon2    - Bogen zwischen zwei Punkten um den Mittelpunkt
  DC radius                - Vollkreis um den Mittelpunkt (Radius in NM)

Koordinatenformat: "DD:MM:SS N/S DDD:MM:SS E/W" (auch mit Dezimalsekunden)
oder direkt Dezimalgrad "DD.dddd N DDD.dddd E".
"""

import re

from .teamcode import bearing_distance, destination_point

NM_TO_KM = 1.852

_COORD_RE = re.compile(
    r"(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?(?::(\d+(?:\.\d+)?))?\s*([NSEW])",
    re.IGNORECASE,
)


def _parse_coord_pair(text: str):
    matches = _COORD_RE.findall(text)
    if len(matches) < 2:
        raise ValueError(f"Konnte Koordinate nicht lesen: {text!r}")

    def to_decimal(deg, minutes, seconds, hemi):
        deg = float(deg)
        minutes = float(minutes) if minutes else 0.0
        seconds = float(seconds) if seconds else 0.0
        value = deg + minutes / 60.0 + seconds / 3600.0
        if hemi.upper() in ("S", "W"):
            value = -value
        return value

    lat = to_decimal(*matches[0])
    lon = to_decimal(*matches[1])
    return lat, lon


def _parse_altitude(text: str) -> dict:
    text = text.strip().upper()
    if text in ("GND", "SFC"):
        return {"meters": 0.0, "label": text}
    if text in ("UNL", "UNLIMITED"):
        return {"meters": None, "label": text}

    m = re.match(r"FL\s*(\d+)", text)
    if m:
        feet = int(m.group(1)) * 100
        return {"meters": feet * 0.3048, "label": text}

    m = re.match(r"(\d+)\s*FT", text)
    if m:
        return {"meters": int(m.group(1)) * 0.3048, "label": text}

    m = re.match(r"(\d+)\s*M\b", text)
    if m:
        return {"meters": float(m.group(1)), "label": text}

    return {"meters": None, "label": text}


def _shorter_arc_is_clockwise(start_deg: float, end_deg: float) -> bool:
    """Fallback, falls keine Vergleichspunkte vorhanden sind: nimm den
    numerisch kuerzeren Bogen."""
    diff = (end_deg - start_deg) % 360
    return diff <= 180


def _pick_arc_direction(center, radius_km, start_deg, end_deg, existing_points) -> bool:
    """Waehlt die Bogenrichtung, wenn keine explizite V D angegeben ist.

    Regel 1 (der Normalfall, z.B. eine kleine Rundung an einer Polygon-Ecke):
    nimm den kuerzeren der beiden moeglichen Boegen. Das ist in der ganz
    ueberwiegenden Mehrheit der Faelle richtig - auch wenn der kurze Bogen
    zufaellig nahe an einem anderen Eckpunkt derselben Flaeche vorbeilaeuft
    (das ist normal, z.B. beim Abrunden einer Ecke).

    Regel 2 (Sonderfall nahe 180 Grad, z.B. ein angehaengter Halbkreis):
    Bei einem Bogen von (fast) genau 180 Grad ist "kuerzer" ein Muenzwurf -
    kleinste Rundungsfehler entscheiden dann zufaellig zwischen einer
    korrekten Auswoelbung und einer falschen Kerbe. Nur in diesem engen
    Fall (Bogenlaenge 165-195 Grad) weichen wir auf die Regel "vom Rest der
    Form weg" aus.
    """
    diff = (end_deg - start_deg) % 360

    if abs(diff - 180) > 15:
        return diff <= 180  # eindeutiger Fall - kuerzerer Bogen gewinnt

    if not existing_points:
        return diff <= 180

    mid_cw = (start_deg + diff / 2) % 360
    mid_ccw = (start_deg - (360 - diff) / 2) % 360

    pt_cw = destination_point(center[0], center[1], mid_cw, radius_km)
    pt_ccw = destination_point(center[0], center[1], mid_ccw, radius_km)

    def min_dist_to_existing(pt):
        return min(bearing_distance(pt[0], pt[1], p[0], p[1]).distance_km for p in existing_points)

    return min_dist_to_existing(pt_cw) >= min_dist_to_existing(pt_ccw)


def _arc_points(center, radius_km, start_deg, end_deg, clockwise, step_deg=5):
    lat0, lon0 = center
    points = []

    if clockwise:
        if end_deg < start_deg:
            end_deg += 360
        angle = start_deg
        while angle <= end_deg + 0.001:
            lat, lon = destination_point(lat0, lon0, angle % 360, radius_km)
            points.append([lat, lon])
            angle += step_deg
    else:
        if end_deg > start_deg:
            end_deg -= 360
        angle = start_deg
        while angle >= end_deg - 0.001:
            lat, lon = destination_point(lat0, lon0, angle % 360, radius_km)
            points.append([lat, lon])
            angle -= step_deg

    return points


def parse_openair(content: str) -> list[dict]:
    airspaces = []
    current = None
    center = None
    clockwise = True
    explicit_direction = False

    def flush():
        if current and len(current.get("points", [])) >= 3:
            airspaces.append(current)

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("*"):
            continue

        code = line[:2].upper()

        try:
            if code == "AC":
                flush()
                current = {
                    "airspace_class": line[3:].strip(),
                    "name": "",
                    "floor": {"meters": None, "label": "?"},
                    "ceiling": {"meters": None, "label": "?"},
                    "points": [],
                }
                center = None
                clockwise = True
                explicit_direction = False

            elif current is None:
                continue  # Zeilen vor der ersten AC-Zeile ignorieren

            elif code == "AN":
                current["name"] = line[3:].strip()

            elif code == "AL":
                current["floor"] = _parse_altitude(line[3:])

            elif code == "AH":
                current["ceiling"] = _parse_altitude(line[3:])

            elif code == "DP":
                lat, lon = _parse_coord_pair(line[3:])
                current["points"].append([lat, lon])

            elif line.upper().startswith("V "):
                assignment = line[2:].strip()
                if assignment.upper().startswith("X="):
                    lat, lon = _parse_coord_pair(assignment[2:])
                    center = (lat, lon)
                elif assignment.upper().startswith("D="):
                    clockwise = "-" not in assignment
                    explicit_direction = True

            elif code == "DA":
                if center is None:
                    continue
                parts = [p.strip() for p in line[3:].split(",")]
                radius_nm, angle1, angle2 = float(parts[0]), float(parts[1]), float(parts[2])
                cw = (
                    clockwise
                    if explicit_direction
                    else _pick_arc_direction(
                        center, radius_nm * NM_TO_KM, angle1, angle2, current["points"]
                    )
                )
                current["points"].extend(
                    _arc_points(center, radius_nm * NM_TO_KM, angle1, angle2, cw)
                )

            elif code == "DB":
                if center is None:
                    continue
                # Format: "DB lat1 lon1, lat2 lon2" - EIN Komma trennt die beiden
                # Punkte, jeder Punkt selbst ist "DD:MM:SS H DDD:MM:SS H" (Leerzeichen-getrennt).
                parts = line[3:].split(",")
                if len(parts) < 2:
                    continue
                lat1, lon1 = _parse_coord_pair(parts[0])
                lat2, lon2 = _parse_coord_pair(parts[1])
                bd1 = bearing_distance(center[0], center[1], lat1, lon1)
                bd2 = bearing_distance(center[0], center[1], lat2, lon2)
                cw = (
                    clockwise
                    if explicit_direction
                    else _pick_arc_direction(
                        center, bd1.distance_km, bd1.bearing_deg, bd2.bearing_deg, current["points"]
                    )
                )
                current["points"].extend(
                    _arc_points(center, bd1.distance_km, bd1.bearing_deg, bd2.bearing_deg, cw)
                )

            elif code == "DC":
                if center is None:
                    continue
                radius_nm = float(line[3:].strip())
                current["points"].extend(
                    _arc_points(center, radius_nm * NM_TO_KM, 0, 360, True, step_deg=10)
                )

        except (ValueError, IndexError):
            continue  # kaputte Zeile ueberspringen, Rest weiterverarbeiten

    flush()
    return airspaces
