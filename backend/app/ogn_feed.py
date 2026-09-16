"""
Verbindet sich mit dem offiziellen, oeffentlichen OGN APRS-IS Netzwerk
(aprs.glidernet.org) und haelt die zuletzt gemeldete Position jedes
Flugzeugs im Speicher. Das ist die offiziell dokumentierte Schnittstelle
des Open Glider Network (kein Scraping einer Website).

Es wird ein Bereichs-Filter ("r/lat/lon/radius_km") verwendet, damit nicht
der komplette weltweite Datenstrom verarbeitet werden muss.
"""

import logging
import threading
import time
from dataclasses import dataclass, field

from ogn.client import AprsClient, settings as ogn_settings
from ogn.parser import parse, AprsParseError

from .ddb import device_database

logger = logging.getLogger(__name__)

# Viele Heimrouter/NAT-Gateways kappen "stille" TCP-Verbindungen schon nach
# 60-120s Inaktivitaet. Der Standardwert der Bibliothek (240s) ist dafuer zu
# lang, vor allem wenn gerade kein Flugzeug im gefilterten Bereich sendet.
# Wir senden daher deutlich haeufiger ein Keepalive-Zeichen.
ogn_settings.APRS_KEEPALIVE_TIME = 30

# Aircraft-Type-Codes gemaess OGN-APRS-Protokoll (vereinfachte Zuordnung)
AIRCRAFT_TYPES = {
    0: "Unbekannt",
    1: "Segelflugzeug/Motorsegler",
    2: "Schleppflugzeug",
    3: "Hubschrauber",
    4: "Fallschirm",
    5: "Absetzflugzeug",
    6: "Hängegleiter",
    7: "Gleitschirm",
    8: "Motorflugzeug",
    9: "Jet",
    11: "Ballon",
    12: "Luftschiff",
    13: "UAV/Drohne",
    15: "Statisches Objekt",
}

# Wie lange ein Flugzeug ohne neues Signal noch angezeigt wird
STALE_AFTER_SECONDS = 5 * 60


@dataclass
class AircraftState:
    address: str
    latitude: float
    longitude: float
    altitude_m: float | None
    climb_rate_ms: float | None
    ground_speed_kmh: float | None
    track_deg: float | None
    aircraft_type: int | None
    last_update: float = field(default_factory=time.time)


class OgnFeed:
    def __init__(self, center_lat: float, center_lon: float, radius_km: int = 300):
        self.center_lat = center_lat
        self.center_lon = center_lon
        self.radius_km = radius_km
        self._lock = threading.Lock()
        self._aircraft: dict[str, AircraftState] = {}
        self._client: AprsClient | None = None
        self._status = "connecting"  # connecting | connected | error
        self._last_error: str | None = None
        self._connected_since: float | None = None
        self._beacon_count = 0
        self._last_data_time: float | None = None

    def _handle_beacon(self, raw_message: str):
        self._last_data_time = time.time()
        self._beacon_count += 1
        if self._status != "connected":
            self._status = "connected"
            self._connected_since = time.time()
            logger.info("OGN-Feed: erste Daten vom Server empfangen")

        if raw_message.startswith("#"):
            return  # Kommentar-/Keepalive-Zeile vom Server
        try:
            beacon = parse(raw_message)
        except AprsParseError:
            return
        except Exception:
            logger.debug("Konnte Beacon nicht parsen: %s", raw_message, exc_info=True)
            return

        if beacon.get("aprs_type") != "position":
            return

        address = beacon.get("address")
        lat = beacon.get("latitude")
        lon = beacon.get("longitude")
        if not address or lat is None or lon is None:
            return

        state = AircraftState(
            address=address.upper(),
            latitude=lat,
            longitude=lon,
            altitude_m=beacon.get("altitude"),
            climb_rate_ms=beacon.get("climb_rate"),
            ground_speed_kmh=beacon.get("ground_speed"),
            track_deg=beacon.get("track"),
            aircraft_type=beacon.get("aircraft_type"),
        )

        with self._lock:
            is_new = state.address not in self._aircraft
            self._aircraft[state.address] = state
        if is_new:
            logger.debug("Neues Flugzeug erfasst: %s @ %.4f,%.4f", state.address, lat, lon)

    def _run(self):
        aprs_filter = f"r/{self.center_lat}/{self.center_lon}/{self.radius_km}"
        while True:
            try:
                self._client = AprsClient(aprs_user="OGNTC01", aprs_filter=aprs_filter)
                self._client.connect(retries=5, wait_period=15, socket_timeout=30)
                self._status = "connecting" if self._status != "connected" else self._status
                self._client.run(callback=self._handle_beacon, autoreconnect=True)
            except Exception as e:
                self._last_error = str(e)
                logger.exception("OGN-Feed abgebrochen, versuche in 20s erneut")
            time.sleep(20)

    def start(self):
        t = threading.Thread(target=self._run, daemon=True, name="ogn-feed")
        t.start()

        def pruner():
            while True:
                time.sleep(30)
                cutoff = time.time() - STALE_AFTER_SECONDS
                with self._lock:
                    stale = [addr for addr, s in self._aircraft.items() if s.last_update < cutoff]
                    for addr in stale:
                        del self._aircraft[addr]

        t2 = threading.Thread(target=pruner, daemon=True, name="ogn-feed-pruner")
        t2.start()

    def get_status(self) -> dict:
        now = time.time()
        seconds_since_data = round(now - self._last_data_time, 1) if self._last_data_time else None
        # Wenn seit 90s keine Daten mehr ankamen, gilt der Feed als gestoert,
        # auch wenn die TCP-Verbindung technisch noch "connected" heisst.
        effective_status = self._status
        if effective_status == "connected" and seconds_since_data is not None and seconds_since_data > 90:
            effective_status = "stalled"
        with self._lock:
            aircraft_count = len(self._aircraft)
        return {
            "status": effective_status,
            "last_error": self._last_error,
            "seconds_since_last_data": seconds_since_data,
            "beacon_count": self._beacon_count,
            "aircraft_count": aircraft_count,
        }

    def get_aircraft(self, bbox: tuple[float, float, float, float] | None = None) -> list[dict]:
        """bbox = (lat_min, lon_min, lat_max, lon_max), optional."""
        with self._lock:
            states = list(self._aircraft.values())

        result = []
        for s in states:
            if bbox:
                lat_min, lon_min, lat_max, lon_max = bbox
                if not (lat_min <= s.latitude <= lat_max and lon_min <= s.longitude <= lon_max):
                    continue

            ddb_entry = device_database.lookup(s.address)
            result.append(
                {
                    "address": s.address,
                    "latitude": s.latitude,
                    "longitude": s.longitude,
                    "altitude_m": s.altitude_m,
                    "climb_rate_ms": s.climb_rate_ms,
                    "ground_speed_kmh": s.ground_speed_kmh,
                    "track_deg": s.track_deg,
                    "aircraft_type_code": s.aircraft_type,
                    "aircraft_type": AIRCRAFT_TYPES.get(s.aircraft_type, "Unbekannt"),
                    "registration": ddb_entry.get("registration") or None,
                    "competition_id": ddb_entry.get("cn") or None,
                    "aircraft_model": ddb_entry.get("aircraft_model") or None,
                    "seconds_since_update": round(time.time() - s.last_update, 1),
                }
            )
        return result
