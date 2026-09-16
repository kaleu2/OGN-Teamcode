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


def _parse_cup_distance(raw: str | None, default_km: float = 0.5) -> float:
    """Feld wie '400m', '10000m' oder '6.4km' -> Kilometer."""
    if not raw:
        return default_km
    raw = raw.strip().lower()
    try:
        if raw.endswith("km"):
            return float(raw[:-2])
        if raw.endswith("m"):
            return float(raw[:-1]) / 1000.0
        return float(raw) / 1000.0  # ohne Einheit: SeeYou nutzt dann Meter
    except ValueError:
        return default_km


def parse_cup_tasks(content: str) -> list[dict]:
    """Liest die "-----Related Tasks-----"-Sektion einer CUP-Datei.

    Format (offizielle SeeYou-Spezifikation):
      "Beschreibung","Wendepunkt1","Wendepunkt2",...
      Options,NoStart=...,TaskTime=...
      ObsZone=0,Style=2,R1=400m,A1=180,Line=1
      ObsZone=1,Style=0,R1=35000m,A1=30

    Die Wendepunkt-Namen muessen exakt den "Name"-Feldern der Wendepunkte
    oberhalb der Related-Tasks-Zeile entsprechen. ObsZone-Zeilen sind
    optional und referenzieren den Wendepunkt per Index (0 = erster Punkt
    der Aufgaben-Zeile). Sektor-Winkel (A1/A2) werden bewusst ignoriert und
    immer als voller Zylinder gezeichnet - genau wie bei den SoaringSpot-
    Aufgaben, die aus demselben Grund auch nur Zylinder/Linie kennen.
    """
    if content.startswith("\ufeff"):
        content = content.lstrip("\ufeff")

    waypoints = parse_cup(content)
    by_name = {w["name"]: w for w in waypoints}
    by_name_lower = {w["name"].lower(): w for w in waypoints}

    task_lines = []
    in_tasks = False
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not in_tasks:
            if line.startswith("-----"):
                in_tasks = True
            continue
        if line:
            task_lines.append(line)

    tasks = []
    current = None

    for line in task_lines:
        upper = line.upper()

        if upper.startswith("OPTIONS"):
            continue  # Zeitfenster/Distanzregeln - fuer die Kartendarstellung nicht relevant

        if upper.startswith("OBSZONE"):
            if current is None:
                continue
            parts = line.split(",")
            fields = {}
            for part in parts:
                if "=" in part:
                    k, v = part.split("=", 1)
                    fields[k.strip().upper()] = v.strip()
            try:
                idx = int(fields.get("OBSZONE", parts[0].split("=", 1)[-1]))
            except (ValueError, IndexError):
                continue
            if 0 <= idx < len(current["turnpoints"]):
                current["turnpoints"][idx]["radius_km"] = _parse_cup_distance(fields.get("R1"))
                current["turnpoints"][idx]["zone_type"] = (
                    "line" if fields.get("LINE") == "1" else "cylinder"
                )
            continue

        # Neue Aufgaben-Zeile: kommagetrennt, Werte in Anfuehrungszeichen
        try:
            row = next(csv.reader([line], skipinitialspace=True))
        except csv.Error:
            continue
        if not row:
            continue

        description = row[0].strip()
        tp_names = [c.strip() for c in row[1:] if c.strip()]
        if len(tp_names) < 2:
            continue  # keine sinnvolle Aufgabe (Start+mind. 1 weiterer Punkt)

        turnpoints = []
        unresolved = []
        for name in tp_names:
            wp = by_name.get(name) or by_name_lower.get(name.lower())
            if wp is None:
                unresolved.append(name)
                continue
            turnpoints.append(
                {"name": name, "lat": wp["lat"], "lon": wp["lon"], "radius_km": 0.5, "zone_type": "cylinder"}
            )

        if len(turnpoints) < 2:
            continue  # zu wenige aufloesbare Punkte fuer eine sinnvolle Darstellung

        current = {
            "name": description or f"Aufgabe {len(tasks) + 1}",
            "turnpoints": turnpoints,
            "unresolved_names": unresolved,
        }
        tasks.append(current)

    return tasks
