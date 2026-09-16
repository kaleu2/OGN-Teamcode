"""
Laedt periodisch die oeffentliche OGN Device Database (DDB) und stellt
eine Zuordnung Geraete-Adresse -> Registrierung/Wettbewerbsnummer/Flugzeugtyp
bereit.

Quelle: http://ddb.glidernet.org/download/?j=1 (offizielle, oeffentliche JSON-Quelle)
"""

import logging
import threading
import time

import requests

logger = logging.getLogger(__name__)

DDB_URL = "http://ddb.glidernet.org/download/?j=1"
REFRESH_INTERVAL_SECONDS = 6 * 60 * 60  # alle 6 Stunden reicht, DDB aendert sich selten


class DeviceDatabase:
    def __init__(self):
        self._lock = threading.Lock()
        self._devices: dict[str, dict] = {}
        self._last_loaded = 0.0

    def lookup(self, address: str) -> dict:
        with self._lock:
            return self._devices.get(address.upper(), {})

    def refresh(self):
        try:
            resp = requests.get(DDB_URL, timeout=20)
            resp.raise_for_status()
            data = resp.json()
            devices = {}
            for entry in data.get("devices", []):
                device_id = entry.get("device_id", "").upper()
                if not device_id:
                    continue
                devices[device_id] = {
                    "registration": entry.get("registration", "").strip(),
                    "cn": entry.get("cn", "").strip(),
                    "aircraft_model": entry.get("aircraft_model", "").strip(),
                    "tracked": entry.get("tracked", "Y") != "N",
                    "identified": entry.get("identified", "Y") != "N",
                }
            with self._lock:
                self._devices = devices
                self._last_loaded = time.time()
            logger.info("OGN-Geraetedatenbank geladen: %d Eintraege", len(devices))
        except Exception:
            logger.exception("Konnte OGN-Geraetedatenbank nicht laden")

    def start_background_refresh(self):
        def loop():
            while True:
                self.refresh()
                time.sleep(REFRESH_INTERVAL_SECONDS)

        t = threading.Thread(target=loop, daemon=True, name="ddb-refresh")
        t.start()


device_database = DeviceDatabase()
