import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import requests as requests_lib

from . import teamcode
from .cup import parse_cup
from .ddb import device_database
from .ogn_feed import OgnFeed
from .openair import parse_openair
from .soaringspot import fetch_task
from .weather_layers import get_dwd_radar_info, get_eumetsat_info

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
REFERENCE_FILE = DATA_DIR / "reference.json"
FRONTEND_DIR = BASE_DIR.parent / "frontend"

# Default-Referenzpunkt (wird in einer spaeteren Ausbaustufe ueber
# hochgeladene CUP-Dateien / Wendepunktauswahl ersetzbar).
DEFAULT_REFERENCE = {"lat": 50.361944, "lon": 8.711389, "label": "Standard-Referenzpunkt"}

FEED_RADIUS_KM = 300

ogn_feed = OgnFeed(
    center_lat=DEFAULT_REFERENCE["lat"],
    center_lon=DEFAULT_REFERENCE["lon"],
    radius_km=FEED_RADIUS_KM,
)


def load_reference() -> dict:
    if REFERENCE_FILE.exists():
        try:
            return json.loads(REFERENCE_FILE.read_text())
        except Exception:
            logger.exception("Referenzpunkt-Datei konnte nicht gelesen werden, nutze Standard")
    return dict(DEFAULT_REFERENCE)


def save_reference(ref: dict):
    REFERENCE_FILE.write_text(json.dumps(ref))


@asynccontextmanager
async def lifespan(app: FastAPI):
    device_database.start_background_refresh()
    ogn_feed.start()
    yield


app = FastAPI(title="OGN Teamcode Tool", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ReferencePoint(BaseModel):
    lat: float
    lon: float
    label: str = "Referenzpunkt"


class TeamcodeDecodeRequest(BaseModel):
    code: str


class TeamcodeEncodeRequest(BaseModel):
    lat: float
    lon: float


@app.get("/api/reference")
def get_reference():
    return load_reference()


@app.post("/api/reference")
def set_reference(ref: ReferencePoint):
    save_reference(ref.model_dump())
    return {"status": "ok", "reference": ref.model_dump()}


@app.post("/api/waypoints/parse-cup")
async def parse_cup_file(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="replace")

    waypoints = parse_cup(text)
    if not waypoints:
        raise HTTPException(
            status_code=400,
            detail="Keine gueltigen Wendepunkte in der Datei gefunden. Ist es eine SeeYou-CUP-Datei?",
        )
    return {"waypoints": waypoints}


class SoaringSpotTaskRequest(BaseModel):
    url: str


@app.post("/api/soaringspot/task")
def get_soaringspot_task(req: SoaringSpotTaskRequest):
    try:
        return fetch_task(req.url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except requests_lib.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Konnte SoaringSpot nicht erreichen: {e}")


@app.post("/api/airspace/parse-openair")
async def parse_openair_file(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="replace")

    airspaces = parse_openair(text)
    if not airspaces:
        raise HTTPException(
            status_code=400,
            detail="Keine gueltigen Lufträume in der Datei gefunden. Ist es eine OpenAir-Datei?",
        )
    return {"airspaces": airspaces}


@app.get("/api/aircraft")
def get_aircraft(
    lat_min: float | None = Query(None),
    lon_min: float | None = Query(None),
    lat_max: float | None = Query(None),
    lon_max: float | None = Query(None),
):
    bbox = None
    if None not in (lat_min, lon_min, lat_max, lon_max):
        bbox = (lat_min, lon_min, lat_max, lon_max)
    return {"aircraft": ogn_feed.get_aircraft(bbox=bbox)}


@app.get("/api/feed-status")
def get_feed_status():
    return ogn_feed.get_status()


@app.get("/api/weather/layers")
def get_weather_layers():
    return {
        "dwd_radar": get_dwd_radar_info(),
        "eumetsat": get_eumetsat_info(),
    }


@app.post("/api/teamcode/encode")
def api_encode_teamcode(req: TeamcodeEncodeRequest):
    ref = load_reference()
    code = teamcode.encode_teamcode(ref["lat"], ref["lon"], req.lat, req.lon)
    return {"code": code, "reference": ref}


@app.post("/api/teamcode/decode")
def api_decode_teamcode(req: TeamcodeDecodeRequest):
    ref = load_reference()
    try:
        lat, lon, direction, distance = teamcode.decode_teamcode(ref["lat"], ref["lon"], req.code)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "lat": lat,
        "lon": lon,
        "direction_deg": direction,
        "distance_km": distance,
        "reference": ref,
    }


# Frontend als statische Dateien ausliefern (muss NACH den /api Routen registriert werden)
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
