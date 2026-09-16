"""
Teamcode-Berechnung (SeeYou / XCSoar kompatibel).

Diese Datei ist eine aufgeraeumte, um Encode UND Decode erweiterte Version
des Ausgangs-Skripts von Karsten. Die Kernidee bleibt identisch:

  - Richtung (Bearing) vom Referenzpunkt zum Ziel wird in zwei Base36-Zeichen
    codiert (10-Grad-Bloecke + Unterteilung in 36 Schritte je Block).
  - Entfernung in km*10 wird als Base36-Zahl codiert.
  - Teamcode = Richtungs-Code + Entfernungs-Code

WICHTIG (bitte einmal gegenpruefen):
Dieser Code repliziert exakt die Mathematik aus Karstens Originalskript.
Er wurde nicht gegen ein echtes SeeYou/XCSoar-Geraet verifiziert. Bevor der
Teamcode operationell zur Koordination mit anderen Piloten genutzt wird,
bitte einmal einen Code mit einem echten Geraet austauschen und
gegenpruefen, dass beide Seiten auf dieselbe Position kommen.
"""

import math
from dataclasses import dataclass

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
EARTH_RADIUS_KM = 6371.0


def base36_encode(number: int) -> str:
    if not isinstance(number, int):
        raise TypeError("number must be an integer")

    sign = ""
    if number < 0:
        sign = "-"
        number = -number

    if 0 <= number < len(ALPHABET):
        return sign + ALPHABET[number]

    base36 = ""
    while number != 0:
        number, i = divmod(number, len(ALPHABET))
        base36 = ALPHABET[i] + base36

    return sign + base36


def base36_decode(code: str) -> int:
    code = code.strip().upper()
    if not code:
        raise ValueError("Leerer Teamcode-Bestandteil")
    negative = code.startswith("-")
    if negative:
        code = code[1:]
    value = 0
    for ch in code:
        idx = ALPHABET.find(ch)
        if idx == -1:
            raise ValueError(f"Ungueltiges Zeichen im Teamcode: {ch!r}")
        value = value * len(ALPHABET) + idx
    return -value if negative else value


@dataclass
class BearingDistance:
    distance_km: float
    bearing_deg: float


def bearing_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> BearingDistance:
    """Grosskreis-Entfernung (Haversine) und Anfangspeilung lat1/lon1 -> lat2/lon2."""
    lat1_rad = math.radians(lat1)
    lon1_rad = math.radians(lon1)
    lat2_rad = math.radians(lat2)
    lon2_rad = math.radians(lon2)

    dlat = lat2_rad - lat1_rad
    dlon = lon2_rad - lon1_rad

    a = math.sin(dlat / 2) ** 2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    distance = EARTH_RADIUS_KM * c

    y = math.sin(dlon) * math.cos(lat2_rad)
    x = math.cos(lat1_rad) * math.sin(lat2_rad) - math.sin(lat1_rad) * math.cos(lat2_rad) * math.cos(dlon)
    bearing = (math.degrees(math.atan2(y, x)) + 360) % 360

    return BearingDistance(distance_km=distance, bearing_deg=bearing)


def destination_point(lat1: float, lon1: float, bearing_deg: float, distance_km: float):
    """Inverse Operation: Zielpunkt aus Startpunkt + Peilung + Entfernung."""
    lat1_rad = math.radians(lat1)
    lon1_rad = math.radians(lon1)
    brng = math.radians(bearing_deg)
    d_r = distance_km / EARTH_RADIUS_KM

    lat2_rad = math.asin(
        math.sin(lat1_rad) * math.cos(d_r) + math.cos(lat1_rad) * math.sin(d_r) * math.cos(brng)
    )
    lon2_rad = lon1_rad + math.atan2(
        math.sin(brng) * math.sin(d_r) * math.cos(lat1_rad),
        math.cos(d_r) - math.sin(lat1_rad) * math.sin(lat2_rad),
    )

    return math.degrees(lat2_rad), (math.degrees(lon2_rad) + 540) % 360 - 180


def encode_teamcode(ref_lat: float, ref_lon: float, target_lat: float, target_lon: float) -> str:
    bd = bearing_distance(ref_lat, ref_lon, target_lat, target_lon)
    direction = bd.bearing_deg
    distance = bd.distance_km

    first_char = base36_encode(int(direction // 10))
    second_char = base36_encode(int(round((direction / 10 - math.floor(direction / 10)) * 36)))
    direction_code = first_char + second_char

    dist_code = base36_encode(int(round(distance * 10)))

    return direction_code + dist_code


def decode_teamcode(ref_lat: float, ref_lon: float, code: str):
    """Teamcode -> (lat, lon). Erwartet Format <2 Zeichen Richtung><Entfernungs-Code>."""
    code = code.strip().upper()
    if len(code) < 3:
        raise ValueError("Teamcode zu kurz (erwartet: 2 Zeichen Richtung + mind. 1 Zeichen Entfernung)")

    direction_part = code[:2]
    distance_part = code[2:]

    d1 = base36_decode(direction_part[0])
    d2 = base36_decode(direction_part[1])
    if not (0 <= d1 < 36) or not (0 <= d2 <= 36):
        raise ValueError("Richtungs-Zeichen ausserhalb des gueltigen Bereichs")

    direction = (d1 + d2 / 36.0) * 10.0
    direction = direction % 360

    distance = base36_decode(distance_part) / 10.0

    lat, lon = destination_point(ref_lat, ref_lon, direction, distance)
    return lat, lon, direction, distance
