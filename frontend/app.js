const AIRCRAFT_REFRESH_MS = 8000;
const FEED_STATUS_REFRESH_MS = 5000;

// Einfarbige SVG-Symbole je Flugzeugklasse (Code gemaess OGN-APRS-Protokoll).
// "wide" laesst Segelflugzeuge mit ihren langen, schlanken Fluegeln erkennbar
// breiter wirken als Motorflugzeuge - simple Skalierung derselben Grundform.
const PLANE_PATH =
  "M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2.5 1.5V22l4-1 4 1v-1.5L13 19v-5.5l8 2.5z";

const GLIDER_PATH =
  "M12,1 L13,8 L23,10 L23,13 L13,13 L13,20 L15.5,22 L15.5,23 L8.5,23 L8.5,22 L11,20 L11,13 L1,13 L1,10 L11,8 Z";

const AIRCRAFT_SVG = {
  1: `<path d="${GLIDER_PATH}"/>`, // Segelflugzeug: eigene Form, lange gerade Tragflaechen, schmaler Rumpf
  2: `<path d="${PLANE_PATH}"/>`, // Schleppflugzeug
  3: `<circle cx="12" cy="15" r="3"/><rect x="2" y="11" width="20" height="2"/><rect x="11" y="2" width="2" height="10"/>`, // Hubschrauber
  4: `<path d="M2 11 A10 9 0 0 1 22 11 L17 11 L15.5 21 L13.5 11 L10.5 11 L8.5 21 L7 11 Z"/>`, // Fallschirm
  5: `<path d="${PLANE_PATH}"/>`, // Absetzflugzeug
  6: `<path d="M12 4 L22 18 L12 15 L2 18 Z"/>`, // Hängegleiter
  7: `<path d="M2 11 A10 9 0 0 1 22 11 L17 11 L15.5 21 L13.5 11 L10.5 11 L8.5 21 L7 11 Z"/>`, // Gleitschirm
  8: `<path d="${PLANE_PATH}"/>`, // Motorflugzeug
  9: `<g transform="translate(12 12) scale(0.85 1.1) translate(-12 -12)"><path d="${PLANE_PATH}"/></g>`, // Jet: schmaler, spitzer
  11: `<circle cx="12" cy="9" r="7"/><rect x="9" y="17" width="6" height="4" rx="1"/>`, // Ballon
  12: `<ellipse cx="12" cy="10" rx="9" ry="5"/><rect x="10" y="15" width="4" height="4" rx="1"/>`, // Luftschiff
  13: `<rect x="9" y="9" width="6" height="6" rx="1"/><circle cx="4" cy="4" r="2.5"/><circle cx="20" cy="4" r="2.5"/><circle cx="4" cy="20" r="2.5"/><circle cx="20" cy="20" r="2.5"/>`, // Drohne
  15: `<path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7zm0 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>`, // Statisches Objekt
  0: `<circle cx="12" cy="12" r="5"/>`, // Unbekannt
};

const AIRCRAFT_STYLES = {
  1: { color: "#000000", label: "Segelflugzeug" },
  2: { color: "#b0701f", label: "Schleppflugzeug" },
  3: { color: "#7a1fb0", label: "Hubschrauber" },
  4: { color: "#555555", label: "Fallschirm" },
  5: { color: "#b0701f", label: "Absetzflugzeug" },
  6: { color: "#1fa088", label: "Hängegleiter" },
  7: { color: "#1fa088", label: "Gleitschirm" },
  8: { color: "#333333", label: "Motorflugzeug" },
  9: { color: "#a01f1f", label: "Jet" },
  11: { color: "#a01fa0", label: "Ballon" },
  12: { color: "#a01fa0", label: "Luftschiff" },
  13: { color: "#888888", label: "UAV/Drohne" },
  15: { color: "#888888", label: "Statisches Objekt" },
  0: { color: "#888888", label: "Unbekannt" },
};
const DEFAULT_STYLE = AIRCRAFT_STYLES[0];

function styleFor(typeCode) {
  return AIRCRAFT_STYLES[typeCode] || DEFAULT_STYLE;
}

function svgFor(typeCode) {
  return AIRCRAFT_SVG[typeCode] || AIRCRAFT_SVG[0];
}

let activeClassFilters = loadClassFilters();
let lastAircraftList = [];

// Favoriten (client-seitig, ueberlebt Seiten-Neuladen ueber localStorage)
let favorites = new Set();
try {
  favorites = new Set(JSON.parse(localStorage.getItem("ogn_favorites") || "[]"));
} catch (e) {
  favorites = new Set();
}

function loadClassFilters() {
  try {
    const stored = JSON.parse(localStorage.getItem("ogn_class_filters"));
    if (Array.isArray(stored)) return new Set(stored);
  } catch (e) {
    // ignorieren, Standard verwenden
  }
  return new Set(Object.keys(AIRCRAFT_STYLES).map(Number)); // Standard: alles an
}

function saveClassFilters() {
  try {
    localStorage.setItem("ogn_class_filters", JSON.stringify([...activeClassFilters]));
  } catch (e) {
    // localStorage evtl. nicht verfuegbar - Auswahl gilt dann nur fuer diese Sitzung
  }
}

function saveFavorites() {
  try {
    localStorage.setItem("ogn_favorites", JSON.stringify([...favorites]));
  } catch (e) {
    // localStorage evtl. nicht verfuegbar - Favoriten gelten dann nur fuer diese Sitzung
  }
}

function toggleFavorite(address) {
  if (favorites.has(address)) favorites.delete(address);
  else favorites.add(address);
  saveFavorites();

  const marker = aircraftMarkers.get(address);
  if (!marker || !marker._acData) return;
  marker.setIcon(
    L.divIcon({ className: "", html: aircraftIconHtml(marker._acData), iconSize: [40, 34], iconAnchor: [20, 17] })
  );
  if (marker.isPopupOpen()) {
    marker.setPopupContent(aircraftPopupHtml(marker._acData));
  }
}

let map;
let reference = null;
let referenceMarker = null;
let aircraftMarkers = new Map(); // address -> L.Marker
let clickedCodeMarker = null;
let decodedCodeMarker = null;
let codeModeActive = false;

function setStatus(text, kind) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = "status " + (kind || "");
}

async function fetchFeedStatus() {
  const el = document.getElementById("feed-status");
  try {
    const resp = await fetch("/api/feed-status");
    const s = await resp.json();

    if (s.status === "connected") {
      el.textContent = `OGN-Feed: verbunden (${s.aircraft_count} Flugzeuge, ${s.beacon_count} Pakete gesamt)`;
      el.className = "status ok";
    } else if (s.status === "stalled") {
      el.textContent = `OGN-Feed: keine Daten seit ${Math.round(s.seconds_since_last_data)}s`;
      el.className = "status error";
    } else if (s.status === "error") {
      el.textContent = `OGN-Feed: Fehler${s.last_error ? " – " + s.last_error : ""}`;
      el.className = "status error";
    } else {
      el.textContent = "OGN-Feed: verbinde zu aprs.glidernet.org …";
      el.className = "status";
    }
  } catch (err) {
    el.textContent = "OGN-Feed: Status unbekannt";
    el.className = "status error";
  }
}

function initMap() {
  map = L.map("map").setView([50.5, 9.0], 8);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap-Mitwirkende",
  }).addTo(map);

  // Eigene Ebenen mit fester Reihenfolge, damit Lufträume und Aufgaben IMMER
  // über Radar/Satellit liegen, egal in welcher Reihenfolge Sachen ein-/aus-
  // geschaltet werden (Standard-"overlayPane" hat z-index 400).
  map.createPane("weatherPane");
  map.getPane("weatherPane").style.zIndex = 350;
  map.createPane("airspacePane");
  map.getPane("airspacePane").style.zIndex = 420;
  map.createPane("taskPane");
  map.getPane("taskPane").style.zIndex = 430;

  map.on("click", onMapClick);
  map.on("click", onMapClickAirspaceCheck);
  map.on("moveend", fetchAircraft);
  map.on("moveend zoomend", refreshAllWeatherOverlaysOnMapChange);
}

function onMapClick(e) {
  if (!codeModeActive || !reference) return;

  const { lat, lng } = e.latlng;
  const code = encodeTeamcode(reference.lat, reference.lon, lat, lng);

  if (clickedCodeMarker) {
    map.removeLayer(clickedCodeMarker);
  }
  clickedCodeMarker = L.marker([lat, lng]).addTo(map);
  clickedCodeMarker
    .bindPopup(`<div class="popup-teamcode">${code}</div>`)
    .openPopup();

  const box = document.getElementById("clicked-code-result");
  box.classList.remove("hidden", "error");
  box.innerHTML = `Teamcode für diese Position: <span class="popup-teamcode">${code}</span>`;
}

function toggleCodeMode() {
  codeModeActive = !codeModeActive;
  const btn = document.getElementById("btn-code-mode");
  btn.classList.toggle("active", codeModeActive);
  document.getElementById("map").classList.toggle("crosshair-mode", codeModeActive);
  btn.textContent = codeModeActive
    ? "✕ Teamcode-Modus beenden"
    : "📍 Auf Karte klicken für Teamcode";
}

async function loadReference() {
  try {
    const resp = await fetch("/api/reference");
    reference = await resp.json();
    document.getElementById("ref-display").textContent =
      `${reference.label}: ${reference.lat.toFixed(5)}, ${reference.lon.toFixed(5)}`;

    if (referenceMarker) map.removeLayer(referenceMarker);
    referenceMarker = L.marker([reference.lat, reference.lon], {
      icon: L.divIcon({
        className: "",
        html: '<div style="font-size:22px;">⚑</div>',
        iconSize: [22, 22],
      }),
    })
      .addTo(map)
      .bindPopup(`Referenzpunkt: ${reference.label}`);
  } catch (err) {
    console.error("Referenzpunkt konnte nicht geladen werden", err);
  }
}

async function decodeCodeInput() {
  const input = document.getElementById("input-code");
  const box = document.getElementById("decoded-code-result");
  const code = input.value.trim();
  if (!code) return;

  try {
    const resp = await fetch("/api/teamcode/decode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || "Ungültiger Teamcode");
    }
    const data = await resp.json();

    if (decodedCodeMarker) map.removeLayer(decodedCodeMarker);
    decodedCodeMarker = L.marker([data.lat, data.lon]).addTo(map);
    decodedCodeMarker
      .bindPopup(`Position von Teamcode ${code.toUpperCase()}`)
      .openPopup();
    map.setView([data.lat, data.lon], 12);

    box.classList.remove("hidden", "error");
    box.innerHTML =
      `Richtung: ${data.direction_deg.toFixed(1)}°, ` +
      `Entfernung: ${data.distance_km.toFixed(1)} km<br>` +
      `Position: ${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}`;
  } catch (err) {
    box.classList.remove("hidden");
    box.classList.add("error");
    box.textContent = err.message;
  }
}

function aircraftIconHtml(ac) {
  const rotation = ac.track_deg || 0;
  const style = styleFor(ac.aircraft_type_code);
  const label = aircraftLabel(ac);
  const isFav = favorites.has(ac.address);
  const isGlider = ac.aircraft_type_code === 1;
  // Segelflugzeuge deutlich groesser/dicker als der Rest, damit sie auf
  // einen Blick auffallen (das sind meistens die relevanten Ziele hier).
  // Inline-Style statt HTML-Attribut, da die CSS-Datei sonst eine feste
  // Groesse erzwingt und ein blosses width/height-Attribut ueberstimmt.
  const symbolBoxStyle = isGlider ? "width:30px;height:30px;" : "";
  const svgSizeStyle = isGlider ? "width:26px;height:26px;" : "";
  const strokeAttr = isGlider ? ' stroke="currentColor" stroke-width="0.6" stroke-linejoin="round"' : "";
  const labelHtml = label
    ? `<div class="ac-label" style="color:${style.color}; border:1px solid ${style.color};">${label}</div>`
    : "";
  return `
    <div class="ac-marker${isFav ? " favorite" : ""}">
      ${labelHtml}
      <div class="ac-symbol" style="color:${style.color}; ${symbolBoxStyle}">
        <svg viewBox="0 0 24 24" fill="currentColor"${strokeAttr} style="${svgSizeStyle} transform: rotate(${rotation}deg);">${svgFor(ac.aircraft_type_code)}</svg>
      </div>
    </div>
  `;
}

function aircraftLabel(ac) {
  const custom = getCustomEntry(ac.address);
  if (custom) {
    const flag = countryFlagEmoji(custom.country);
    const idText = custom.registration || ac.competition_id || ac.address.slice(-4);
    return (flag ? flag + " " : "") + idText;
  }
  return ac.competition_id || ac.registration || null;
}

function aircraftPopupHtml(ac) {
  const code =
    reference != null
      ? encodeTeamcode(reference.lat, reference.lon, ac.latitude, ac.longitude)
      : "–";

  const customEntry = getCustomEntry(ac.address);

  // Reihenfolge exakt wie gewuenscht. "Kitts" wurde noch nicht geklaert,
  // daher vorerst ausgelassen - siehe Rueckfrage im Chat.
  const rows = [
    ["Höhe", ac.altitude_m != null ? `${Math.round(ac.altitude_m)} m` : "–"],
    ["Vario", ac.climb_rate_ms != null ? `${ac.climb_rate_ms.toFixed(1)} m/s` : "–"],
    ["Speed", ac.ground_speed_kmh != null ? `${Math.round(ac.ground_speed_kmh)} km/h` : "–"],
    ["Teamcode", code],
    ["Flarm ID", ac.address],
    ["Kurs", ac.track_deg != null ? `${Math.round(ac.track_deg)}°` : "–"],
    ["Kennung", (customEntry && customEntry.registration) || ac.registration || "–"],
    ["Typ", (customEntry && customEntry.type) || ac.aircraft_model || ac.aircraft_type || "–"],
    ["Letztes Signal", `vor ${Math.round(ac.seconds_since_update)} s`],
  ];

  const rowsHtml = rows.map(([k, v]) => `<div><b>${k}:</b> ${v}</div>`).join("");
  const isFav = favorites.has(ac.address);

  return `
    <div style="min-width:180px;">
      <div style="font-size:15px; font-weight:bold; margin-bottom:4px;">${aircraftLabel(ac) || ac.address.slice(-4)}</div>
      ${rowsHtml}
      <button class="fav-toggle${isFav ? " active" : ""}" data-address="${ac.address}">
        ${isFav ? "★ Favorit entfernen" : "☆ Als Favorit markieren"}
      </button>
    </div>
  `;
}

async function fetchAircraft() {
  const bounds = map.getBounds();
  const params = new URLSearchParams({
    lat_min: bounds.getSouth(),
    lon_min: bounds.getWest(),
    lat_max: bounds.getNorth(),
    lon_max: bounds.getEast(),
  });

  try {
    const resp = await fetch("/api/aircraft?" + params.toString());
    if (!resp.ok) throw new Error("Serverfehler beim Laden der Flugzeuge");
    const data = await resp.json();
    setStatus("Verbunden", "ok");
    renderAircraft(data.aircraft);
  } catch (err) {
    console.error(err);
    setStatus("Verbindung zum Server verloren", "error");
  }
}

function renderAircraft(list) {
  lastAircraftList = list;
  applyAircraftFilterAndRender();
}

function applyAircraftFilterAndRender() {
  const list = lastAircraftList.filter((ac) => {
    if (!activeClassFilters.has(ac.aircraft_type_code ?? 0)) return false;
    if (customListOnly && !getCustomEntry(ac.address)) return false;
    if (!withinDisplayRadius(ac)) return false;
    return true;
  });
  const seen = new Set();

  for (const ac of list) {
    seen.add(ac.address);
    const latlng = [ac.latitude, ac.longitude];

    if (aircraftMarkers.has(ac.address)) {
      const marker = aircraftMarkers.get(ac.address);
      marker.setLatLng(latlng);
      marker.setIcon(
        L.divIcon({ className: "", html: aircraftIconHtml(ac), iconSize: [40, 34], iconAnchor: [20, 17] })
      );
      marker.getPopup()?.setContent(aircraftPopupHtml(ac));
      marker._acData = ac;
    } else {
      const marker = L.marker(latlng, {
        icon: L.divIcon({ className: "", html: aircraftIconHtml(ac), iconSize: [40, 34], iconAnchor: [20, 17] }),
      }).addTo(map);
      marker.bindPopup(() => aircraftPopupHtml(marker._acData));
      marker._acData = ac;
      aircraftMarkers.set(ac.address, marker);
    }
    if (aircraftMarkers.get(ac.address).on) {
      aircraftMarkers.get(ac.address).off("click", onAircraftMarkerClick);
      aircraftMarkers.get(ac.address).on("click", onAircraftMarkerClick);
    }
  }

  // Flugzeuge entfernen, die nicht mehr sichtbar/im Feed/im Filter sind
  for (const [address, marker] of aircraftMarkers.entries()) {
    if (!seen.has(address)) {
      map.removeLayer(marker);
      aircraftMarkers.delete(address);
    }
  }

  document.getElementById("aircraft-count").textContent = `${list.length} Flugzeuge`;
  updateClassFilterUi(lastAircraftList);
  updateRangeRings();
}

function updateClassFilterUi(fullList) {
  const container = document.getElementById("class-filters");
  if (container.dataset.built === "1") return; // nur einmal aufbauen

  const countsByType = {};
  for (const ac of fullList) {
    const code = ac.aircraft_type_code ?? 0;
    countsByType[code] = (countsByType[code] || 0) + 1;
  }

  const codesToShow = Object.keys(AIRCRAFT_STYLES).map(Number);
  container.innerHTML = codesToShow
    .map((code) => {
      const style = styleFor(code);
      const checked = activeClassFilters.has(code) ? "checked" : "";
      return `
        <label>
          <input type="checkbox" data-code="${code}" ${checked}>
          <span class="legend-dot" style="background:${style.color};"></span> ${style.label}
        </label>
      `;
    })
    .join("");
  container.dataset.built = "1";

  container.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const code = Number(cb.dataset.code);
      if (cb.checked) activeClassFilters.add(code);
      else activeClassFilters.delete(code);
      saveClassFilters();
      applyAircraftFilterAndRender();
    });
  });
}

function setAllClassFilters(enabled) {
  const codes = Object.keys(AIRCRAFT_STYLES).map(Number);
  if (enabled) codes.forEach((c) => activeClassFilters.add(c));
  else activeClassFilters.clear();

  document.querySelectorAll("#class-filters input[type=checkbox]").forEach((cb) => {
    cb.checked = enabled;
  });

  saveClassFilters();
  applyAircraftFilterAndRender();
}

// ---------- Wetter-Ebenen (DWD Radar / EUMETSAT Satellit) ----------
let weatherLayersInfo = null;
const weatherLayerState = {
  dwd_radar: { overlay: null, enabled: false, times: [], index: 0, playing: false, timer: null },
  eumetsat: { overlay: null, enabled: false, times: [], index: 0, playing: false, timer: null },
};
const WEATHER_ELEMENT_PREFIX = { dwd_radar: "dwd-radar", eumetsat: "eumetsat" };

async function loadWeatherLayersInfo() {
  try {
    const resp = await fetch("/api/weather/layers");
    weatherLayersInfo = await resp.json();
  } catch (e) {
    weatherLayersInfo = null;
  }
  updateWeatherStatusUi();
}

function updateWeatherStatusUi() {
  for (const key of ["dwd_radar", "eumetsat"]) {
    const prefix = WEATHER_ELEMENT_PREFIX[key];
    const statusBox = document.getElementById(`${prefix}-status`);
    const info = weatherLayersInfo ? weatherLayersInfo[key] : null;

    if (!info) {
      statusBox.classList.remove("hidden");
      statusBox.classList.add("error");
      statusBox.textContent = "Dienst nicht erreichbar (Server ohne Internetzugang zu diesem Dienst?).";
      continue;
    }
    if (!info.found) {
      statusBox.classList.remove("hidden");
      statusBox.classList.add("error");
      if (info.all_attempts && info.all_attempts.length) {
        const details = info.all_attempts.map((a) => `${a.url}: ${a.error}`).join(" | ");
        statusBox.textContent = `Alle Endpunkte nicht erreichbar. ${details}`;
      } else if (info.error) {
        statusBox.textContent = `Dienst nicht erreichbar: ${info.error}`;
      } else {
        statusBox.textContent = `Keine passende Ebene gefunden. Ähnliche vorhanden: ${
          (info.similar_layers_found || []).join(", ") || "keine"
        }`;
      }
      continue;
    }
    statusBox.classList.add("hidden");

    const state = weatherLayerState[key];
    const wasFollowingNow = !state.times.length || state.index === closestTimeIndexToNow(state.times);
    state.times = info.times || [];

    if (state.enabled && state.times.length) {
      document.getElementById(`${prefix}-controls`).classList.remove("hidden");
      const newIndex = wasFollowingNow ? closestTimeIndexToNow(state.times) : Math.min(state.index, state.times.length - 1);
      setWeatherFrame(key, newIndex);
    }
  }
}

// Statt Leaflet's Standard-Kachel-WMS (das stillschweigend die Karten-Projektion
// EPSG:3857 verwendet, was manche Wetterdienste nur unvollstaendig unterstuetzen -
// daher "nur an Kachelraendern kurz sichtbar") holen wir EIN grosses Bild passend
// zum aktuellen Kartenausschnitt, explizit in EPSG:4326 (WMS 1.1.1, lon/lat-
// Reihenfolge) - das unterstuetzt praktisch jeder WMS-Dienst zuverlaessig.
function buildWmsGetMapUrl(baseUrl, layerName, bounds, sizePx, timeValue) {
  const west = bounds.getWest();
  const south = bounds.getSouth();
  const east = bounds.getEast();
  const north = bounds.getNorth();

  const params = new URLSearchParams({
    service: "WMS",
    version: "1.1.1",
    request: "GetMap",
    layers: layerName,
    styles: "",
    srs: "EPSG:4326",
    bbox: `${west},${south},${east},${north}`,
    width: String(Math.max(1, Math.round(sizePx.x))),
    height: String(Math.max(1, Math.round(sizePx.y))),
    format: "image/png",
    transparent: "true",
  });
  if (timeValue) params.set("time", timeValue);
  return `${baseUrl}?${params.toString()}`;
}

function refreshWeatherOverlay(key) {
  const state = weatherLayerState[key];
  const info = weatherLayersInfo ? weatherLayersInfo[key] : null;
  if (!state.enabled || !info || !info.found) return;

  // Eine noch ladende, mittlerweile durch einen neueren Kartenausschnitt
  // ueberholte Anfrage verwerfen, statt mehrere gleichzeitig laufen zu lassen.
  if (state.pendingOverlay) {
    map.removeLayer(state.pendingOverlay);
    state.pendingOverlay = null;
  }

  const bounds = map.getBounds();
  const size = map.getSize();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2); // scharf, aber nicht ausufernd gross
  const requestSize = { x: size.x * pixelRatio, y: size.y * pixelRatio };
  const timeValue = state.times.length ? state.times[state.index] : null;
  const url = buildWmsGetMapUrl(info.wms_url, info.layer, bounds, requestSize, timeValue);

  const newOverlay = L.imageOverlay(url, bounds, {
    opacity: key === "dwd_radar" ? 0.75 : 1,
    zIndex: key === "dwd_radar" ? 450 : 400, // Radar ueber Satellit (innerhalb der weatherPane)
    pane: "weatherPane",
    attribution: key === "dwd_radar" ? "DWD Open Data" : "EUMETSAT",
  });
  state.pendingOverlay = newOverlay;

  // Das ALTE Bild bleibt unveraendert an seiner alten Position stehen, bis
  // das neue fertig geladen ist - keine Sekunden lang verzerrte Zwischenphase,
  // stattdessen ein sauberer Wechsel im richtigen Moment.
  newOverlay.once("load", () => {
    if (state.pendingOverlay !== newOverlay) return; // laengst ueberholt, ignorieren
    if (state.overlay) map.removeLayer(state.overlay);
    state.overlay = newOverlay;
    state.pendingOverlay = null;
  });
  newOverlay.once("error", () => {
    if (state.pendingOverlay === newOverlay) state.pendingOverlay = null;
    map.removeLayer(newOverlay);
  });

  newOverlay.addTo(map);
}

function ensureRadarAboveSatellite() {
  if (weatherLayerState.eumetsat.overlay) weatherLayerState.eumetsat.overlay.setZIndex(400);
  if (weatherLayerState.dwd_radar.overlay) weatherLayerState.dwd_radar.overlay.setZIndex(450);
}

function toggleWeatherLayer(key, enabled) {
  const state = weatherLayerState[key];
  const info = weatherLayersInfo ? weatherLayersInfo[key] : null;
  const prefix = WEATHER_ELEMENT_PREFIX[key];
  const controlsEl = document.getElementById(`${prefix}-controls`);

  state.enabled = enabled;

  if (enabled) {
    if (!info || !info.found) return; // Statusbox erklaert bereits, warum nichts passiert
    if (state.times.length) {
      state.index = closestTimeIndexToNow(state.times); // "jetzt" zuerst, nicht das letzte (=zukünftigste) Bild
      controlsEl.classList.remove("hidden");
    } else {
      controlsEl.classList.add("hidden"); // keine Zeitachse -> nur aktuelles Bild, keine Abspielsteuerung
    }
    refreshWeatherOverlay(key);
    ensureRadarAboveSatellite();
    updateWeatherFrameUi(key);
  } else {
    if (state.overlay) {
      map.removeLayer(state.overlay);
      state.overlay = null;
    }
    stopWeatherPlayback(key);
    controlsEl.classList.add("hidden");
  }
}

function formatWeatherTime(iso) {
  try {
    const d = new Date(iso);
    const label = d.toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }) + " Uhr";
    return d.getTime() > Date.now() ? `${label} (Prognose)` : label;
  } catch (e) {
    return iso;
  }
}

function updateWeatherFrameUi(key) {
  const state = weatherLayerState[key];
  if (!state.times.length) return;
  const prefix = WEATHER_ELEMENT_PREFIX[key];
  const slider = document.getElementById(`${prefix}-slider`);
  slider.max = state.times.length - 1;
  slider.value = state.index;
  document.getElementById(`${prefix}-time`).textContent = formatWeatherTime(state.times[state.index]);
}

function setWeatherFrame(key, index) {
  const state = weatherLayerState[key];
  if (!state.enabled || !state.times.length) return;

  state.index = Math.max(0, Math.min(index, state.times.length - 1));
  refreshWeatherOverlay(key);
  updateWeatherFrameUi(key);
}

// Beim Verschieben/Zoomen der Karte muessen die Wetter-Bilder neu angefragt
// werden (Einzelbild-Overlay statt Kacheln deckt immer nur den zuletzt
// angefragten Ausschnitt ab).
function refreshAllWeatherOverlaysOnMapChange() {
  refreshWeatherOverlay("dwd_radar");
  refreshWeatherOverlay("eumetsat");
}

function toggleWeatherPlayback(key) {
  const state = weatherLayerState[key];
  const prefix = WEATHER_ELEMENT_PREFIX[key];
  const btn = document.getElementById(`${prefix}-play`);

  if (state.playing) {
    stopWeatherPlayback(key);
    return;
  }
  if (!state.times.length) return;

  state.playing = true;
  btn.textContent = "⏸";
  state.timer = setInterval(() => {
    const next = (state.index + 1) % state.times.length;
    setWeatherFrame(key, next);
    syncLinkedTimeline(key);
  }, 800);
}

function stopWeatherPlayback(key) {
  const state = weatherLayerState[key];
  state.playing = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  const btn = document.getElementById(`${WEATHER_ELEMENT_PREFIX[key]}-play`);
  if (btn) btn.textContent = "▶";
}

// Findet den Zeitpunkt in der Liste, der einer Ziel-Uhrzeit am naechsten liegt.
// Wichtig fuer Layer wie DWD "RV" (Analyse UND Vorhersage), deren Liste bis in
// die Zukunft reicht - "letzter Eintrag" waere dort die am weitesten entfernte
// Vorhersage, nicht "jetzt". Dieselbe Funktion treibt auch die Zeitleisten-
// Verknuepfung: Satellit hat keine Vorhersage, daher landet eine Zielzeit in
// der Zukunft automatisch auf dessen letztem (= aktuellstem) echten Bild.
function closestTimeIndex(times, targetMs) {
  if (!times.length) return 0;
  let bestIdx = 0;
  let bestDiff = Infinity;
  times.forEach((t, i) => {
    const diff = Math.abs(new Date(t).getTime() - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  });
  return bestIdx;
}

function closestTimeIndexToNow(times) {
  return closestTimeIndex(times, Date.now());
}

let weatherTimelinesLinked = false;

// Wenn verknuepft: die jeweils andere Ebene auf denselben Zeitpunkt bringen.
// Fuer den Satelliten (keine Vorhersage) heisst "in die Zukunft springen"
// automatisch: bleibt auf seinem letzten tatsaechlichen Bild stehen, weil das
// dann der naechstliegende Zeitpunkt ist.
function syncLinkedTimeline(sourceKey) {
  if (!weatherTimelinesLinked) return;
  const otherKey = sourceKey === "dwd_radar" ? "eumetsat" : "dwd_radar";
  const source = weatherLayerState[sourceKey];
  const other = weatherLayerState[otherKey];
  if (!source.enabled || !other.enabled || !source.times.length || !other.times.length) return;

  const targetMs = new Date(source.times[source.index]).getTime();
  setWeatherFrame(otherKey, closestTimeIndex(other.times, targetMs));
}

// ---------- Eigene Flugzeugliste (FLARM-ID -> Wettbewerbskennzeichen/Land/Typ) ----------
let customAircraftList = new Map(); // address (Grossbuchstaben) -> {registration, country, type}
let customListOnly = false;
let pendingExcelRows = null; // Zwischenspeicher bis Nutzer "Ersetzen"/"Hinzufügen" waehlt

function loadCustomAircraftList() {
  try {
    const raw = JSON.parse(localStorage.getItem("ogn_custom_aircraft_list") || "[]");
    customAircraftList = new Map(raw.map((e) => [e.address, e]));
  } catch (e) {
    customAircraftList = new Map();
  }
}

function saveCustomAircraftListToStorage() {
  try {
    localStorage.setItem(
      "ogn_custom_aircraft_list",
      JSON.stringify([...customAircraftList.entries()].map(([address, e]) => ({ address, ...e })))
    );
  } catch (e) {
    // localStorage evtl. nicht verfuegbar
  }
}

// Wandelt einen 2-Buchstaben-Laendercode in das entsprechende Flaggen-Emoji um
// (Unicode "Regional Indicator"-Trick, funktioniert ohne Bilddateien).
function countryFlagEmoji(countryCode) {
  if (!countryCode || countryCode.trim().length !== 2) return "";
  const cc = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  const codePoints = [...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...codePoints);
}

function getCustomEntry(address) {
  return customAircraftList.get((address || "").toUpperCase()) || null;
}

// ---- Editierbare Tabelle im Uebermenue ----
function renderFlarmListTable() {
  const container = document.getElementById("flarm-list-table-container");
  if (!container) return;
  const rows = [...customAircraftList.entries()];

  if (!rows.length) {
    container.innerHTML = '<p class="hint">Noch keine Einträge. Excel hochladen oder unten eine Zeile hinzufügen.</p>';
    return;
  }

  container.innerHTML = `
    <table class="flarm-table">
      <thead>
        <tr><th>FLARM-ID</th><th>Wettbewerbskennzeichen</th><th>Land</th><th>Typ</th><th></th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            ([address, e], i) => `
          <tr data-idx="${i}">
            <td><input type="text" class="flarm-cell" data-field="address" value="${address}"></td>
            <td><input type="text" class="flarm-cell" data-field="registration" value="${e.registration || ""}"></td>
            <td><input type="text" class="flarm-cell" data-field="country" value="${e.country || ""}" maxlength="2"></td>
            <td><input type="text" class="flarm-cell" data-field="type" value="${e.type || ""}"></td>
            <td><button class="flarm-delete-btn" data-idx="${i}" title="Löschen">🗑</button></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  container.querySelectorAll(".flarm-cell").forEach((input) => {
    // Enter loest bei einem einzelnen Textfeld ohne Formular kein "change"
    // aus (das passiert normalerweise erst beim Wegklicken/Tab) - daher
    // hier gezielt per Enter das Feld "bluren", damit gespeichert wird.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    });

    input.addEventListener("change", () => {
      const idx = Number(input.closest("tr").dataset.idx);
      const field = input.dataset.field;
      const newValue = field === "address" ? input.value.trim().toUpperCase() : input.value.trim();
      if (field === "address" && !newValue) return; // FLARM-ID darf nicht leer werden

      // Bewusst NICHT ueber Map.delete()+Map.set() auf der bestehenden Map
      // arbeiten (das verschiebt den Eintrag beim Adressaendern ans Ende
      // und fuehrte zu Verwirrung/Fehlern) - stattdessen die komplette
      // Liste anhand der aktuell sichtbaren Zeilen sauber neu aufbauen,
      // Reihenfolge bleibt dabei erhalten.
      const currentRows = [...customAircraftList.entries()].map(([addr, e]) => [addr, { ...e }]);
      if (field === "address") {
        currentRows[idx][0] = newValue;
      } else {
        currentRows[idx][1][field] = newValue;
      }
      customAircraftList = new Map(currentRows);

      saveCustomAircraftListToStorage();
      if (field === "address") renderFlarmListTable(); // Zeilen-Referenzen (data-idx) neu aufbauen
      applyAircraftFilterAndRender();
    });
  });

  container.querySelectorAll(".flarm-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      const [address] = rows[idx];
      customAircraftList.delete(address);
      saveCustomAircraftListToStorage();
      renderFlarmListTable();
      applyAircraftFilterAndRender();
    });
  });
}

function addFlarmRow() {
  let n = 1;
  let key = `NEU${n}`;
  while (customAircraftList.has(key)) {
    n++;
    key = `NEU${n}`;
  }
  customAircraftList.set(key, { registration: "", country: "", type: "" });
  saveCustomAircraftListToStorage();
  renderFlarmListTable();
}

// ---- Excel-Import (SheetJS) ----
async function handleFlarmExcelUpload(e) {
  const file = e.target.files[0];
  const statusBox = document.getElementById("flarm-list-status");
  if (!file) return;

  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });

    // Kopfzeile erkennen und ueberspringen (z.B. "FlarmID" in der ersten Zelle)
    let dataRows = rows;
    if (rows.length && typeof rows[0][0] === "string" && rows[0][0].toLowerCase().includes("flarm")) {
      dataRows = rows.slice(1);
    }

    pendingExcelRows = dataRows
      .filter((r) => r && r[0])
      .map((r) => ({
        address: String(r[0]).trim().toUpperCase(),
        registration: r[1] != null ? String(r[1]).trim() : "",
        country: r[2] != null ? String(r[2]).trim() : "",
        type: r[3] != null ? String(r[3]).trim() : "",
      }));

    statusBox.classList.remove("hidden", "error");
    statusBox.innerHTML = `
      ${pendingExcelRows.length} Zeile(n) in der Excel-Datei gefunden.
      Bestehende Liste (${customAircraftList.size} Einträge) ersetzen oder ergänzen?
      <div style="margin-top:8px; display:flex; gap:8px;">
        <button id="btn-excel-replace">Ersetzen</button>
        <button id="btn-excel-merge">Hinzufügen</button>
      </div>
    `;
    document.getElementById("btn-excel-replace").addEventListener("click", () => applyPendingExcelRows(true));
    document.getElementById("btn-excel-merge").addEventListener("click", () => applyPendingExcelRows(false));
  } catch (err) {
    statusBox.classList.remove("hidden");
    statusBox.classList.add("error");
    statusBox.textContent = "Konnte Excel-Datei nicht lesen: " + err.message;
  }
}

function applyPendingExcelRows(replace) {
  if (!pendingExcelRows) return;
  if (replace) customAircraftList = new Map();
  pendingExcelRows.forEach((r) => {
    customAircraftList.set(r.address, { registration: r.registration, country: r.country, type: r.type });
  });
  const count = pendingExcelRows.length;
  pendingExcelRows = null;
  saveCustomAircraftListToStorage();
  renderFlarmListTable();
  applyAircraftFilterAndRender();

  const statusBox = document.getElementById("flarm-list-status");
  statusBox.classList.remove("error");
  statusBox.textContent = `${replace ? "Ersetzt" : "Ergänzt"}: ${count} Zeile(n) verarbeitet, Liste hat jetzt ${customAircraftList.size} Einträge.`;
}

// ---- Export ----
function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function downloadTextFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportUserFlarmXml() {
  const lines = ['<?xml version="1.0" encoding="UTF-8" ?>', "<FLARMNET>"];
  for (const [address, e] of customAircraftList.entries()) {
    if (!e.registration) continue; // ohne Wettbewerbskennzeichen kein sinnvoller Eintrag
    lines.push(`    <FLARMDATA FlarmID="${escapeXml(address)}" user="1">`);
    lines.push(`        <COMPID>${escapeXml(e.registration)}</COMPID>`);
    lines.push(`        <FREQUENCY>0.000</FREQUENCY>`);
    lines.push(`    </FLARMDATA>`);
  }
  lines.push("</FLARMNET>");
  downloadTextFile("userflarm.xml", lines.join("\n"), "application/xml");
}

function exportFlarmExcel() {
  const rows = [["FlarmID", "Wettbewerbskennzeichen", "Land", "Flugzeugtyp"]];
  for (const [address, e] of customAircraftList.entries()) {
    rows.push([address, e.registration || "", e.country || "", e.type || ""]);
  }
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Flugzeuge");
  XLSX.writeFile(workbook, "eigene-flugzeugliste.xlsx");
}

function initCustomAircraftListUi() {
  loadCustomAircraftList();
  renderFlarmListTable();
}

// ---------- Uebermenue: Sichtbarkeit der Seitenleisten-Panels ----------
const PANEL_VISIBILITY_LABELS = {
  reference: "Referenzpunkt",
  teamcode: "Teamcode",
  soaringspot: "SoaringSpot-Aufgaben",
  airspace: "Luftraum",
  weather: "Wetter (Radar/Satellit)",
  aircraft: "Flugzeuge in Sicht",
};

let panelVisibility = {}; // key -> false, wenn ausgeblendet (Standard: alles sichtbar)

function loadPanelVisibility() {
  try {
    panelVisibility = JSON.parse(localStorage.getItem("ogn_panel_visibility") || "{}");
  } catch (e) {
    panelVisibility = {};
  }
}

function savePanelVisibility() {
  try {
    localStorage.setItem("ogn_panel_visibility", JSON.stringify(panelVisibility));
  } catch (e) {
    // ignorieren
  }
}

function applyPanelVisibility() {
  document.querySelectorAll(".panel-toggle").forEach((header) => {
    const key = header.dataset.panelKey;
    const panel = header.closest(".panel");
    panel.style.display = panelVisibility[key] === false ? "none" : "";
  });
}

function renderPanelVisibilityList() {
  const container = document.getElementById("panel-visibility-list");
  container.innerHTML = Object.entries(PANEL_VISIBILITY_LABELS)
    .map(
      ([key, label]) => `
      <label class="toggle-row">
        <input type="checkbox" class="panel-visibility-checkbox" data-key="${key}" ${
        panelVisibility[key] === false ? "" : "checked"
      }>
        ${label}
      </label>`
    )
    .join("");

  container.querySelectorAll(".panel-visibility-checkbox").forEach((cb) => {
    cb.addEventListener("change", () => {
      panelVisibility[cb.dataset.key] = cb.checked;
      savePanelVisibility();
      applyPanelVisibility();
    });
  });
}

// ---------- Uebermenue: Anzeige-Radius & eigene Position ----------
let displayRadiusKm = 300;
let radiusCenterMode = "reference"; // "reference" | "own"
let ownPosition = null; // {lat, lon}
let showOwnPosition = false;
let ownPositionMarker = null;
let ownPositionWatchId = null;

function loadDisplaySettings() {
  try {
    const s = JSON.parse(localStorage.getItem("ogn_display_settings") || "{}");
    if (s.radiusKm) displayRadiusKm = s.radiusKm;
    if (s.centerMode) radiusCenterMode = s.centerMode;
    if (s.showOwnPosition) showOwnPosition = true;
  } catch (e) {
    // Standardwerte behalten
  }
}

function saveDisplaySettings() {
  try {
    localStorage.setItem(
      "ogn_display_settings",
      JSON.stringify({ radiusKm: displayRadiusKm, centerMode: radiusCenterMode, showOwnPosition })
    );
  } catch (e) {
    // ignorieren
  }
}

function toggleOwnPositionTracking(enabled) {
  showOwnPosition = enabled;
  saveDisplaySettings();

  if (enabled) {
    if (!navigator.geolocation) {
      alert("Dieser Browser unterstützt keine Standortermittlung.");
      document.getElementById("show-own-position-toggle").checked = false;
      showOwnPosition = false;
      return;
    }
    ownPositionWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        ownPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        updateOwnPositionMarker();
        applyAircraftFilterAndRender();
      },
      (err) => console.error("Standort-Fehler:", err),
      { enableHighAccuracy: true, maximumAge: 10000 }
    );
  } else {
    if (ownPositionWatchId != null) navigator.geolocation.clearWatch(ownPositionWatchId);
    ownPositionWatchId = null;
    if (ownPositionMarker) {
      map.removeLayer(ownPositionMarker);
      ownPositionMarker = null;
    }
    applyAircraftFilterAndRender();
  }
}

function updateOwnPositionMarker() {
  if (!ownPosition) return;
  if (!ownPositionMarker) {
    ownPositionMarker = L.circleMarker([ownPosition.lat, ownPosition.lon], {
      radius: 5,
      color: "#66ccff",
      fillColor: "#66ccff",
      fillOpacity: 0.9,
      weight: 1,
    })
      .bindTooltip("Meine Position")
      .addTo(map);
  } else {
    ownPositionMarker.setLatLng([ownPosition.lat, ownPosition.lon]);
  }
}

function withinDisplayRadius(ac) {
  const center = radiusCenterMode === "own" && ownPosition ? ownPosition : reference;
  if (!center) return true; // kein Zentrum bekannt -> nicht herausfiltern
  const d = tcBearingDistance(center.lat, center.lon, ac.latitude, ac.longitude).distanceKm;
  return d <= displayRadiusKm;
}

// ---------- Wendepunkte aus einer geladenen Datei als kleine Punkte anzeigen ----------
let waypointMarkersLayer = null;

function renderWaypointMarkers(waypoints) {
  if (waypointMarkersLayer) {
    map.removeLayer(waypointMarkersLayer);
    waypointMarkersLayer = null;
  }
  if (!waypoints || !waypoints.length) return;

  const group = L.layerGroup();
  waypoints.forEach((w) => {
    L.circleMarker([w.lat, w.lon], {
      radius: 3,
      color: "#0a1f6b",
      fillColor: "#0a1f6b",
      fillOpacity: 1,
      weight: 1,
    })
      .bindTooltip(w.name)
      .addTo(group);
  });
  group.addTo(map);
  waypointMarkersLayer = group;
}

let uploadedWaypoints = [];
let uploadedCupTasks = [];

// ---------- Distanzringe um ausgewaehltes Flugzeug ----------
let selectedAircraftAddress = null;
let rangeRingsVisible = false;
let rangeRingsLayer = null;
const RANGE_RING_STEP_KM = 10;
const RANGE_RING_COUNT = 6; // 10,20,...,60 km

function onAircraftMarkerClick(e) {
  const marker = e.target;
  if (!marker._acData) return;
  selectedAircraftAddress = marker._acData.address;
  updateRangeRings();
}

function addRangeRingsControl() {
  const control = L.control({ position: "topleft" });
  control.onAdd = function () {
    const div = L.DomUtil.create("div", "range-rings-control leaflet-bar");
    const btn = L.DomUtil.create("a", "range-rings-btn", div);
    btn.href = "#";
    btn.title = "Distanzringe (10 km) um ausgewähltes Flugzeug ein-/ausblenden";
    btn.innerHTML = "◎";
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(btn, "click", (e) => {
      L.DomEvent.preventDefault(e);
      rangeRingsVisible = !rangeRingsVisible;
      btn.classList.toggle("active", rangeRingsVisible);
      updateRangeRings();
    });
    return div;
  };
  control.addTo(map);
}

function updateRangeRings() {
  if (rangeRingsLayer) {
    map.removeLayer(rangeRingsLayer);
    rangeRingsLayer = null;
  }
  if (!rangeRingsVisible || !selectedAircraftAddress) return;

  const marker = aircraftMarkers.get(selectedAircraftAddress);
  if (!marker) return;

  const { lat, lng } = marker.getLatLng();
  const group = L.layerGroup();

  for (let i = 1; i <= RANGE_RING_COUNT; i++) {
    const radiusKm = i * RANGE_RING_STEP_KM;
    L.circle([lat, lng], {
      radius: radiusKm * 1000,
      color: "#555",
      weight: 1,
      fill: false,
      dashArray: "4,4",
      interactive: false,
    }).addTo(group);

    const [labelLat, labelLon] = tcDestinationPoint(lat, lng, 0, radiusKm);
    L.marker([labelLat, labelLon], {
      icon: L.divIcon({
        className: "",
        html: `<div class="range-ring-label">${radiusKm} km</div>`,
        iconSize: [40, 14],
        iconAnchor: [20, 7],
      }),
      interactive: false,
    }).addTo(group);
  }

  group.addTo(map);
  rangeRingsLayer = group;
}

// ---------- Seitenleiste ein-/ausklappen ----------
function loadPanelCollapseState() {
  try {
    return JSON.parse(localStorage.getItem("ogn_panel_collapsed") || "{}");
  } catch (e) {
    return {};
  }
}

function savePanelCollapseState(stateObj) {
  try {
    localStorage.setItem("ogn_panel_collapsed", JSON.stringify(stateObj));
  } catch (e) {
    // localStorage evtl. nicht verfuegbar
  }
}

function initCollapsiblePanels() {
  const collapsedState = loadPanelCollapseState();

  document.querySelectorAll(".panel-toggle").forEach((header) => {
    const panel = header.closest(".panel");
    const key = header.dataset.panelKey;

    if (key && collapsedState[key]) {
      panel.classList.add("collapsed");
    }

    header.addEventListener("click", () => {
      panel.classList.toggle("collapsed");
      if (key) {
        collapsedState[key] = panel.classList.contains("collapsed");
        savePanelCollapseState(collapsedState);
      }
    });
  });

  document.getElementById("btn-toggle-sidebar").addEventListener("click", () => {
    document.getElementById("app").classList.toggle("sidebar-hidden");
    // Karte muss ueber ihre neue Groesse informiert werden, sonst bleiben
    // Kacheln am Rand leer/verzerrt.
    setTimeout(() => map.invalidateSize(), 160);
  });
}

// ---------- SoaringSpot-Aufgaben ----------
const TASK_COLORS = { 1: "#d92626", 2: "#2f6fb0", 3: "#1fa088" };
let taskLayers = { 1: null, 2: null, 3: null };

// ---------- SoaringSpot-Automatik: ein Link laedt alles ----------
async function loadSoaringSpotToday() {
  const urlInput = document.getElementById("soaringspot-auto-url");
  const statusBox = document.getElementById("soaringspot-auto-status");
  const url = urlInput.value.trim();
  if (!url) return;

  statusBox.classList.remove("hidden", "error");
  statusBox.textContent = "Lade Aufgaben, Luftraum und Wendepunkte…";

  const messages = [];

  try {
    const resp = await fetch("/api/soaringspot/today", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "Konnte nicht geladen werden");

    const okTasks = data.tasks.filter((t) => !t.error);
    const failedTasks = data.tasks.filter((t) => t.error);

    if (data.note) messages.push(data.note);

    okTasks.slice(0, 3).forEach((t, i) => {
      const slot = i + 1;
      renderTask(slot, t.turnpoints);
      saveTaskForToday(slot, t.task_url, t.turnpoints);
      document.getElementById(`task-url-${slot}`).value = t.task_url;
      messages.push(`Klasse "${t.class}": ${t.turnpoints.length} Punkte → Aufgabe ${slot}`);
    });
    if (okTasks.length > 3) {
      messages.push(`${okTasks.length - 3} weitere Klasse(n) gefunden, aber nur 3 Farb-Slots verfügbar.`);
    }
    failedTasks.forEach((t) => {
      messages.push(`Klasse "${t.class}": Fehler - ${t.error}`);
    });

    if (data.airspace_url) {
      try {
        const airspaceResp = await fetch("/api/airspace/parse-openair-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: data.airspace_url }),
        });
        const airspaceData = await airspaceResp.json();
        if (airspaceResp.ok) {
          lastLoadedAirspaces = airspaceData.airspaces;
          renderAirspaces(lastLoadedAirspaces);
          messages.push(`${airspaceData.airspaces.length} Lufträume automatisch geladen.`);
        } else {
          messages.push(`Luftraum: ${airspaceData.detail}`);
        }
      } catch (e) {
        messages.push("Luftraum konnte nicht automatisch geladen werden.");
      }
    } else {
      messages.push("Keine Luftraum-Datei auf der Downloads-Seite gefunden.");
    }

    if (data.cup_waypoints && data.cup_waypoints.length) {
      uploadedWaypoints = data.cup_waypoints;
      const select = document.getElementById("waypoint-select");
      select.innerHTML = uploadedWaypoints
        .map((w, i) => `<option value="${i}">${w.name}${w.code ? " (" + w.code + ")" : ""}</option>`)
        .join("");
      document.getElementById("waypoint-select-row").classList.remove("hidden");
      renderWaypointMarkers(uploadedWaypoints);
      messages.push(`${uploadedWaypoints.length} Wendepunkte für die Referenzpunkt-Auswahl geladen.`);
    }

    const inactiveNames = Array.from(new Set(okTasks.flatMap((t) => t.inactive_airspaces || [])));
    if (inactiveNames.length && lastLoadedAirspaces.length) {
      openInactiveAirspacePrompt(inactiveNames);
    }

    statusBox.classList.remove("error");
    statusBox.textContent = messages.join(" | ");
  } catch (err) {
    statusBox.classList.add("error");
    statusBox.textContent = messages.length ? messages.join(" | ") + " | " + err.message : err.message;
  }
}

async function loadTask(slot) {
  const urlInput = document.getElementById(`task-url-${slot}`);
  const statusBox = document.getElementById(`task-status-${slot}`);
  const url = urlInput.value.trim();
  if (!url) return;

  statusBox.classList.remove("hidden", "error");
  statusBox.textContent = "Lade Aufgabe…";

  try {
    const resp = await fetch("/api/soaringspot/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "Aufgabe konnte nicht geladen werden");

    renderTask(slot, data.turnpoints);
    saveTaskForToday(slot, url, data.turnpoints);

    let msg = `${data.turnpoints.length} Wendepunkte geladen.`;
    if (data.unresolved_names && data.unresolved_names.length) {
      msg += ` Nicht gefunden: ${data.unresolved_names.join(", ")}`;
    }
    statusBox.textContent = msg;

    if (data.inactive_airspaces && data.inactive_airspaces.length && lastLoadedAirspaces.length) {
      openInactiveAirspacePrompt(data.inactive_airspaces);
    }
  } catch (err) {
    statusBox.classList.add("error");
    statusBox.textContent = err.message;
  }
}

// Aufgabe bleibt fuer den restlichen Kalendertag aktiv (auch nach Neuladen
// der Seite) - bis das Feld geleert, eine neue URL geladen wird, oder ein
// neuer Tag beginnt.
function saveTaskForToday(slot, url, turnpoints) {
  try {
    localStorage.setItem(
      `ogn_task_${slot}`,
      JSON.stringify({ date: todayKey(), url, turnpoints })
    );
  } catch (e) {
    // localStorage evtl. nicht verfuegbar
  }
}

function clearTask(slot) {
  if (taskLayers[slot]) {
    map.removeLayer(taskLayers[slot]);
    taskLayers[slot] = null;
  }
  try {
    localStorage.removeItem(`ogn_task_${slot}`);
  } catch (e) {
    // ignorieren
  }
  document.getElementById(`task-status-${slot}`).classList.add("hidden");
}

function restoreTasksForToday() {
  for (const slot of [1, 2, 3]) {
    try {
      const stored = JSON.parse(localStorage.getItem(`ogn_task_${slot}`));
      if (stored && stored.date === todayKey() && stored.url && stored.turnpoints) {
        document.getElementById(`task-url-${slot}`).value = stored.url;
        renderTask(slot, stored.turnpoints, false);
        const statusBox = document.getElementById(`task-status-${slot}`);
        statusBox.classList.remove("hidden", "error");
        statusBox.textContent = `${stored.turnpoints.length} Wendepunkte (heute bereits geladen).`;
      }
    } catch (e) {
      // ignorieren, einfach nicht wiederherstellen
    }
  }
}

function renderTask(slot, turnpoints, fit = true) {
  if (taskLayers[slot]) {
    map.removeLayer(taskLayers[slot]);
    taskLayers[slot] = null;
  }
  if (!turnpoints.length) return;

  const color = TASK_COLORS[slot];
  const group = L.layerGroup();
  const latlngs = turnpoints.map((tp) => [tp.lat, tp.lon]);

  L.polyline(latlngs, { color, weight: 3, opacity: 0.8, pane: "taskPane" }).addTo(group);

  turnpoints.forEach((tp, i) => {
    if (tp.zone_type === "line") {
      // Start-/Ziellinie: senkrecht zum angrenzenden Schenkel, Laenge = 2x Radius
      const neighbor = turnpoints[i + 1] || turnpoints[i - 1];
      if (neighbor) {
        const legBearing =
          i + 1 < turnpoints.length
            ? tcBearingDistance(tp.lat, tp.lon, neighbor.lat, neighbor.lon).bearingDeg
            : tcBearingDistance(neighbor.lat, neighbor.lon, tp.lat, tp.lon).bearingDeg;
        const perp = (legBearing + 90) % 360;
        const end1 = tcDestinationPoint(tp.lat, tp.lon, perp, tp.radius_km);
        const end2 = tcDestinationPoint(tp.lat, tp.lon, (perp + 180) % 360, tp.radius_km);
        L.polyline([end1, end2], { color, weight: 4, opacity: 0.9, pane: "taskPane" })
          .bindTooltip(tp.name)
          .addTo(group);
      } else {
        // Kein Nachbarpunkt bekannt - Kreis als Fallback
        L.circle([tp.lat, tp.lon], { radius: tp.radius_km * 1000, color, weight: 2, fillColor: color, fillOpacity: 0.08, pane: "taskPane" })
          .bindTooltip(tp.name)
          .addTo(group);
      }
    } else {
      L.circle([tp.lat, tp.lon], {
        radius: tp.radius_km * 1000,
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.08,
        pane: "taskPane",
      })
        .bindTooltip(tp.name)
        .addTo(group);
    }

    L.circleMarker([tp.lat, tp.lon], {
      radius: 4,
      color,
      fillColor: color,
      fillOpacity: 1,
      pane: "taskPane",
    }).addTo(group);
  });

  group.addTo(map);
  taskLayers[slot] = group;
  if (fit) map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
}

// ---------- Luftraum (OpenAir) ----------
let airspaceLayers = []; // { layer, key, data }
let airspacesVisible = true;
let lastLoadedAirspaces = []; // gemerkt, damit "wieder einblenden" ohne erneuten Upload geht

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function loadDisabledAirspacesToday() {
  try {
    const stored = JSON.parse(localStorage.getItem("ogn_airspace_disabled") || "{}");
    if (stored.date === todayKey()) return new Set(stored.names || []);
  } catch (e) {
    // ignorieren
  }
  return new Set();
}

function saveDisabledAirspacesToday() {
  try {
    localStorage.setItem(
      "ogn_airspace_disabled",
      JSON.stringify({ date: todayKey(), names: [...disabledAirspacesToday] })
    );
  } catch (e) {
    // localStorage evtl. nicht verfuegbar
  }
}

let disabledAirspacesToday = loadDisabledAirspacesToday();

function airspaceKey(a, idx) {
  // idx macht den Key eindeutig, auch wenn mehrere Segmente (z.B. verschiedene
  // Hoehenbaender einer TMA) denselben Namen + dieselbe Klasse haben.
  return `${a.name}__${a.airspace_class}__${idx}`;
}

function airspaceColor(cls) {
  const colors = {
    CTR: "#d92626",
    D: "#2f6fb0",
    C: "#2f6fb0",
    TMZ: "#b0701f",
    RMZ: "#b0701f",
    R: "#a01f1f",
    Q: "#a01f1f",
    P: "#a01f1f",
    A: "#7a1fb0",
    B: "#7a1fb0",
    E: "#888888",
  };
  return colors[(cls || "").toUpperCase()] || "#555555";
}

// Einfacher Punkt-in-Polygon-Test (Ray Casting), damit wir bei Klick ALLE
// uebereinanderliegenden Lufträume finden koennen, nicht nur den, den
// Leaflet intern als "getroffen" markiert.
function pointInPolygon(lat, lon, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const yi = points[i][0],
      xi = points[i][1];
    const yj = points[j][0],
      xj = points[j][1];
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function onMapClickAirspaceCheck(e) {
  if (codeModeActive || !airspacesVisible) return;

  const hits = airspaceLayers.filter(({ data }) =>
    pointInPolygon(e.latlng.lat, e.latlng.lng, data.points)
  );
  if (!hits.length) return;

  const html = hits.map(({ data, key }) => airspacePopupHtml(data, key)).join("<hr>");
  const popup = L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(html).openOn(map);
  attachAirspacePopupHoverHandlers(popup);
  // Falls das Popup geschlossen wird, waehrend ein Eintrag gelb markiert ist
  // (z.B. Klick woanders hin, ohne vorher mit der Maus rauszufahren).
  popup.on("remove", () => {
    airspaceLayers.forEach(({ layer, baseStyle }) => layer.setStyle(baseStyle));
  });
}

async function handleAirspaceFileChange(e) {
  const file = e.target.files[0];
  const resultBox = document.getElementById("airspace-upload-result");
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const resp = await fetch("/api/airspace/parse-openair", { method: "POST", body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "Datei konnte nicht gelesen werden");

    lastLoadedAirspaces = data.airspaces;
    renderAirspaces(lastLoadedAirspaces);
    resultBox.classList.remove("hidden", "error");
    resultBox.textContent = `${data.airspaces.length} Lufträume geladen.`;
  } catch (err) {
    resultBox.classList.remove("hidden");
    resultBox.classList.add("error");
    resultBox.textContent = err.message;
  }
}

function airspacePopupHtml(a, key) {
  return `
    <div class="airspace-popup-block" data-key="${key}" style="min-width:180px;">
      <div style="font-weight:bold; margin-bottom:4px;">${a.name || "(ohne Namen)"}</div>
      <div><b>Klasse:</b> ${a.airspace_class}</div>
      <div><b>Untergrenze:</b> ${a.floor.label}</div>
      <div><b>Obergrenze:</b> ${a.ceiling.label}</div>
      <button class="airspace-disable-btn" data-key="${key}">Für heute deaktivieren</button>
    </div>
  `;
}

// Hebt einen Luftraum auf der Karte gelb hervor (Hover in ueberlappender
// Popup-Liste), damit erkennbar ist, welcher Eintrag zu welcher Flaeche gehoert.
const AIRSPACE_HIGHLIGHT_STYLE = { color: "#f2c200", weight: 3, fillColor: "#f2c200", fillOpacity: 0.35 };

function highlightAirspaceByKey(key) {
  const entry = airspaceLayers.find((l) => l.key === key);
  if (!entry) return;
  entry.layer.setStyle(AIRSPACE_HIGHLIGHT_STYLE);
  entry.layer.bringToFront();
}

function resetAirspaceHighlightByKey(key) {
  const entry = airspaceLayers.find((l) => l.key === key);
  if (!entry) return;
  entry.layer.setStyle(entry.baseStyle);
}

function attachAirspacePopupHoverHandlers(popup) {
  const el = popup.getElement ? popup.getElement() : null;
  if (!el) return;
  el.querySelectorAll(".airspace-popup-block").forEach((block) => {
    const key = block.dataset.key;
    block.addEventListener("mouseenter", () => highlightAirspaceByKey(key));
    block.addEventListener("mouseleave", () => resetAirspaceHighlightByKey(key));
  });
}

function renderAirspaces(airspaces) {
  airspaceLayers.forEach(({ layer }) => map.removeLayer(layer));
  airspaceLayers = [];

  airspaces.forEach((a, idx) => {
    const key = airspaceKey(a, idx);
    if (disabledAirspacesToday.has(key)) return;

    const color = airspaceColor(a.airspace_class);
    const baseStyle = { color, weight: 1.5, fillColor: color, fillOpacity: 0.08 };
    const latlngs = a.points.map((p) => [p[0], p[1]]);
    const polygon = L.polygon(latlngs, {
      ...baseStyle,
      pane: "airspacePane",
    });
    // Kein bindPopup mehr hier - Klicks laufen zentral ueber
    // onMapClickAirspaceCheck, damit bei Ueberlappung ALLE Treffer erscheinen.

    if (airspacesVisible) polygon.addTo(map);
    airspaceLayers.push({ layer: polygon, key, data: a, baseStyle });
  });

  renderDisabledAirspaceList();
}

function disableAirspaceToday(key) {
  disabledAirspacesToday.add(key);
  saveDisabledAirspacesToday();
  const entry = airspaceLayers.find((l) => l.key === key);
  if (entry) {
    map.removeLayer(entry.layer);
    airspaceLayers = airspaceLayers.filter((l) => l.key !== key);
  }
  map.closePopup();
  renderDisabledAirspaceList();
}

function reenableAirspace(key) {
  disabledAirspacesToday.delete(key);
  saveDisabledAirspacesToday();
  if (lastLoadedAirspaces.length) renderAirspaces(lastLoadedAirspaces);
  else renderDisabledAirspaceList();
}

function reenableAllAirspaces() {
  disabledAirspacesToday.clear();
  saveDisabledAirspacesToday();
  if (lastLoadedAirspaces.length) renderAirspaces(lastLoadedAirspaces);
  else renderDisabledAirspaceList();
}

function renderDisabledAirspaceList() {
  const container = document.getElementById("disabled-airspace-list");
  if (!container) return;

  if (!disabledAirspacesToday.size) {
    container.innerHTML = '<div class="hint">Keine für heute deaktivierten Lufträume.</div>';
    return;
  }

  container.innerHTML = [...disabledAirspacesToday]
    .map((key) => {
      const [name, cls] = key.split("__");
      return `
        <div class="disabled-airspace-row">
          <span>${name} (${cls})</span>
          <button class="airspace-reenable-btn" data-key="${key}">Wieder einblenden</button>
        </div>
      `;
    })
    .join("");
}

// ---------- SoaringSpot "Inactive airspaces" Abgleich ----------
// SeeYou erzeugt diese Liste auf SoaringSpot anhand der Luftraum-Bezeichnungen
// aus der Luftraumdatei selbst - Namen sollten also exakt oder nahezu exakt
// uebereinstimmen. Nur bei mehrfach vergebenen oder gar nicht gefundenen
// Namen muss nachgefragt werden.
function matchInactiveAirspaceNames(names) {
  const loaded = lastLoadedAirspaces.map((a, idx) => ({ a, key: airspaceKey(a, idx) }));
  return names
    .map((n) => n.trim())
    .filter(Boolean)
    .map((name) => ({
      name,
      matches: loaded.filter(({ a }) => (a.name || "").trim().toLowerCase() === name.toLowerCase()),
    }));
}

function airspaceOptionLabel(a) {
  return `${a.name || "(ohne Namen)"} (${a.airspace_class}, ${a.floor.label}–${a.ceiling.label})`;
}

function openInactiveAirspacePrompt(names) {
  if (!lastLoadedAirspaces.length || !names || !names.length) return;
  const matchResults = matchInactiveAirspaceNames(names);
  if (!matchResults.length) return;

  const loaded = lastLoadedAirspaces.map((a, idx) => ({ a, key: airspaceKey(a, idx) }));
  const allOptionsHtml = loaded
    .map(({ a, key }) => `<option value="${key}">${airspaceOptionLabel(a)}</option>`)
    .join("");

  const html = matchResults
    .map(({ name, matches }) => {
      if (matches.length === 1) {
        const { a, key } = matches[0];
        return `
          <div class="inactive-airspace-row">
            <label class="toggle-row">
              <input type="checkbox" class="inactive-airspace-checkbox" data-key="${key}" checked>
              <b>${name}</b> → ${airspaceOptionLabel(a)}
            </label>
          </div>`;
      }
      if (matches.length === 0) {
        return `
          <div class="inactive-airspace-row">
            <div><b>${name}</b> – kein geladener Luftraum mit diesem Namen gefunden.</div>
            <label class="supermenu-inline-label">
              Trotzdem zuordnen:
              <select class="inactive-airspace-manual-select">
                <option value="">– überspringen –</option>
                ${allOptionsHtml}
              </select>
            </label>
          </div>`;
      }
      const options = matches
        .map(
          ({ a, key }) => `
          <label class="toggle-row">
            <input type="checkbox" class="inactive-airspace-checkbox" data-key="${key}">
            ${airspaceOptionLabel(a)}
          </label>`
        )
        .join("");
      return `
        <div class="inactive-airspace-row">
          <div><b>${name}</b> – ${matches.length} gleichnamige Lufträume gefunden, bitte auswählen (keinen ankreuzen zum Überspringen):</div>
          ${options}
        </div>`;
    })
    .join("<hr>");

  document.getElementById("inactive-airspace-list").innerHTML = html;
  document.getElementById("inactive-airspace-overlay").classList.remove("hidden");
}

function applyInactiveAirspaceSelection() {
  const overlay = document.getElementById("inactive-airspace-overlay");
  overlay.querySelectorAll(".inactive-airspace-checkbox:checked").forEach((cb) => {
    disableAirspaceToday(cb.dataset.key);
  });
  overlay.querySelectorAll(".inactive-airspace-manual-select").forEach((sel) => {
    if (sel.value) disableAirspaceToday(sel.value);
  });
  overlay.classList.add("hidden");
}

function toggleAirspacesVisibility(visible) {
  airspacesVisible = visible;
  airspaceLayers.forEach(({ layer }) => {
    if (visible) layer.addTo(map);
    else map.removeLayer(layer);
  });
}

async function handleCupFileChange(e) {
  const file = e.target.files[0];
  const resultBox = document.getElementById("cup-upload-result");
  const selectRow = document.getElementById("waypoint-select-row");
  const taskSelectRow = document.getElementById("cup-task-select-row");
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const resp = await fetch("/api/waypoints/parse-cup", { method: "POST", body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "Datei konnte nicht gelesen werden");

    uploadedWaypoints = data.waypoints;
    const select = document.getElementById("waypoint-select");
    select.innerHTML = uploadedWaypoints
      .map((w, i) => `<option value="${i}">${w.name}${w.code ? " (" + w.code + ")" : ""}</option>`)
      .join("");
    selectRow.classList.remove("hidden");
    renderWaypointMarkers(uploadedWaypoints);

    uploadedCupTasks = data.tasks || [];
    if (uploadedCupTasks.length) {
      const taskSelect = document.getElementById("cup-task-select");
      taskSelect.innerHTML = uploadedCupTasks
        .map((t, i) => `<option value="${i}">${t.name} (${t.turnpoints.length} Punkte)</option>`)
        .join("");
      taskSelectRow.classList.remove("hidden");
    } else {
      taskSelectRow.classList.add("hidden");
    }

    resultBox.classList.remove("hidden", "error");
    let msg = `${uploadedWaypoints.length} Wendepunkte gefunden.`;
    if (uploadedCupTasks.length) msg += ` ${uploadedCupTasks.length} Aufgabe(n) in der Datei gefunden.`;
    resultBox.textContent = msg;
  } catch (err) {
    selectRow.classList.add("hidden");
    taskSelectRow.classList.add("hidden");
    resultBox.classList.remove("hidden");
    resultBox.classList.add("error");
    resultBox.textContent = err.message;
  }
}

function useCupTaskAsMapTask() {
  const idx = Number(document.getElementById("cup-task-select").value);
  const slot = Number(document.getElementById("cup-task-slot-select").value);
  const task = uploadedCupTasks[idx];
  if (!task) return;

  renderTask(slot, task.turnpoints);

  let msg = `${task.turnpoints.length} Wendepunkte aus CUP-Datei geladen ("${task.name}").`;
  if (task.unresolved_names && task.unresolved_names.length) {
    msg += ` Nicht gefunden: ${task.unresolved_names.join(", ")}`;
  }
  const statusBox = document.getElementById(`task-status-${slot}`);
  statusBox.classList.remove("hidden", "error");
  statusBox.textContent = msg;

  // Falls in diesem Slot vorher eine SoaringSpot-URL aktiv war: leeren, sonst
  // wuerde ein spaeteres Neuladen der Seite versuchen, die alte URL erneut zu laden.
  document.getElementById(`task-url-${slot}`).value = "";
  try {
    localStorage.removeItem(`ogn_task_${slot}`);
  } catch (err) {
    // ignorieren
  }
}

async function useSelectedWaypointAsReference() {
  const select = document.getElementById("waypoint-select");
  const idx = Number(select.value);
  const wp = uploadedWaypoints[idx];
  if (!wp) return;

  await fetch("/api/reference", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat: wp.lat, lon: wp.lon, label: wp.name }),
  });

  await loadReference();
  map.setView([wp.lat, wp.lon], map.getZoom());

  const resultBox = document.getElementById("cup-upload-result");
  resultBox.classList.remove("error");
  resultBox.textContent = `Referenzpunkt gesetzt: ${wp.name}`;
}

function init() {
  if (location.protocol === "file:") {
    setStatus("Bitte über den laufenden Server öffnen (http://127.0.0.1:8000), nicht die Datei direkt", "error");
    document.getElementById("map").innerHTML =
      '<div style="padding:40px;font-size:16px;max-width:500px;">' +
      "Diese Seite wurde direkt als Datei geöffnet (file://...). " +
      "Damit funktionieren weder die Kartenkacheln noch die Live-Daten. " +
      "Bitte stattdessen den Server starten (siehe README) und " +
      "<b>http://127.0.0.1:8000</b> im Browser aufrufen." +
      "</div>";
    return;
  }

  initMap();
  addRangeRingsControl();
  initCollapsiblePanels();
  loadPanelVisibility();
  applyPanelVisibility();
  renderPanelVisibilityList();
  loadDisplaySettings();
  loadReference().then(fetchAircraft);
  setInterval(fetchAircraft, AIRCRAFT_REFRESH_MS);
  fetchFeedStatus();
  setInterval(fetchFeedStatus, FEED_STATUS_REFRESH_MS);

  document.getElementById("btn-code-mode").addEventListener("click", toggleCodeMode);
  document.getElementById("btn-show-code").addEventListener("click", decodeCodeInput);
  document.getElementById("input-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") decodeCodeInput();
  });
  document.getElementById("cup-file").addEventListener("change", handleCupFileChange);
  document.getElementById("btn-use-waypoint").addEventListener("click", useSelectedWaypointAsReference);
  document.getElementById("btn-use-cup-task").addEventListener("click", useCupTaskAsMapTask);
  document.getElementById("custom-list-only-toggle").addEventListener("change", (e) => {
    customListOnly = e.target.checked;
    applyAircraftFilterAndRender();
  });
  document.getElementById("flarm-excel-upload").addEventListener("change", handleFlarmExcelUpload);
  document.getElementById("btn-add-flarm-row").addEventListener("click", addFlarmRow);
  document.getElementById("btn-export-userflarm").addEventListener("click", exportUserFlarmXml);
  document.getElementById("btn-export-flarm-excel").addEventListener("click", exportFlarmExcel);
  initCustomAircraftListUi();

  document.getElementById("btn-filter-all").addEventListener("click", () => setAllClassFilters(true));
  document.getElementById("btn-filter-none").addEventListener("click", () => setAllClassFilters(false));

  renderDisabledAirspaceList();

  document.getElementById("dwd-radar-toggle").addEventListener("change", (e) =>
    toggleWeatherLayer("dwd_radar", e.target.checked)
  );
  document.getElementById("eumetsat-toggle").addEventListener("change", (e) =>
    toggleWeatherLayer("eumetsat", e.target.checked)
  );
  document.getElementById("weather-link-toggle").addEventListener("change", (e) => {
    weatherTimelinesLinked = e.target.checked;
    if (weatherTimelinesLinked) syncLinkedTimeline("dwd_radar");
  });
  document.getElementById("dwd-radar-play").addEventListener("click", () => toggleWeatherPlayback("dwd_radar"));
  document.getElementById("eumetsat-play").addEventListener("click", () => toggleWeatherPlayback("eumetsat"));
  document.getElementById("dwd-radar-slider").addEventListener("input", (e) => {
    stopWeatherPlayback("dwd_radar");
    setWeatherFrame("dwd_radar", Number(e.target.value));
    syncLinkedTimeline("dwd_radar");
  });
  document.getElementById("eumetsat-slider").addEventListener("input", (e) => {
    stopWeatherPlayback("eumetsat");
    setWeatherFrame("eumetsat", Number(e.target.value));
    syncLinkedTimeline("eumetsat");
  });
  loadWeatherLayersInfo();
  setInterval(loadWeatherLayersInfo, 60 * 1000); // Zeitachse jede Minute aktuell halten

  document.querySelectorAll(".task-load-btn").forEach((btn) => {
    btn.addEventListener("click", () => loadTask(Number(btn.dataset.taskSlot)));
  });
  document.getElementById("btn-load-soaringspot-today").addEventListener("click", loadSoaringSpotToday);
  document.querySelectorAll(".task-row input[type=text]").forEach((input) => {
    input.addEventListener("input", (e) => {
      if (!e.target.value.trim()) clearTask(Number(e.target.id.slice(-1)));
    });
  });
  restoreTasksForToday();

  document.getElementById("airspace-file").addEventListener("change", handleAirspaceFileChange);
  document.getElementById("airspace-toggle").addEventListener("change", (e) => {
    toggleAirspacesVisibility(e.target.checked);
  });
  document.getElementById("btn-reenable-all-airspaces").addEventListener("click", reenableAllAirspaces);

  document.getElementById("btn-apply-inactive-airspaces").addEventListener("click", applyInactiveAirspaceSelection);
  document.getElementById("btn-close-inactive-airspace").addEventListener("click", () => {
    document.getElementById("inactive-airspace-overlay").classList.add("hidden");
  });
  document.getElementById("inactive-airspace-overlay").addEventListener("click", (e) => {
    if (e.target.id === "inactive-airspace-overlay") e.target.classList.add("hidden");
  });

  document.addEventListener("click", (e) => {
    const favBtn = e.target.closest(".fav-toggle");
    if (favBtn) toggleFavorite(favBtn.dataset.address);

    const airspaceBtn = e.target.closest(".airspace-disable-btn");
    if (airspaceBtn) disableAirspaceToday(airspaceBtn.dataset.key);

    const reenableBtn = e.target.closest(".airspace-reenable-btn");
    if (reenableBtn) reenableAirspace(reenableBtn.dataset.key);
  });

  // ---- Uebermenue ----
  document.getElementById("btn-open-supermenu").addEventListener("click", () => {
    document.getElementById("supermenu-overlay").classList.remove("hidden");
  });
  document.getElementById("btn-close-supermenu").addEventListener("click", () => {
    document.getElementById("supermenu-overlay").classList.add("hidden");
  });
  document.getElementById("supermenu-overlay").addEventListener("click", (e) => {
    if (e.target.id === "supermenu-overlay") e.target.classList.add("hidden");
  });

  const radiusInput = document.getElementById("display-radius-input");
  radiusInput.value = displayRadiusKm;
  radiusInput.addEventListener("change", (e) => {
    const v = Number(e.target.value);
    if (v > 0) {
      displayRadiusKm = v;
      saveDisplaySettings();
      applyAircraftFilterAndRender();
    }
  });

  document.getElementById(radiusCenterMode === "own" ? "radius-center-own" : "radius-center-reference").checked = true;
  document.querySelectorAll('input[name="radius-center"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      radiusCenterMode = e.target.value;
      saveDisplaySettings();
      applyAircraftFilterAndRender();
    });
  });

  const ownPosToggle = document.getElementById("show-own-position-toggle");
  ownPosToggle.checked = showOwnPosition;
  ownPosToggle.addEventListener("change", (e) => toggleOwnPositionTracking(e.target.checked));
  if (showOwnPosition) toggleOwnPositionTracking(true);
}

document.addEventListener("DOMContentLoaded", init);
