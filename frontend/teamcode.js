// Teamcode-Berechnung, Client-seitig - exakte Portierung von backend/app/teamcode.py
// Wird genutzt, damit Klicks auf die Karte sofort (ohne Server-Rundreise) einen
// Teamcode anzeigen koennen. Fuer die Rueckrichtung (Code -> Position) fragen wir
// den Server, damit Client und Server garantiert denselben Referenzpunkt nutzen.

const TC_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TC_EARTH_RADIUS_KM = 6371.0;

function tcBase36Encode(number) {
  let sign = "";
  if (number < 0) {
    sign = "-";
    number = -number;
  }
  if (number >= 0 && number < TC_ALPHABET.length) {
    return sign + TC_ALPHABET[number];
  }
  let base36 = "";
  while (number !== 0) {
    const i = number % TC_ALPHABET.length;
    number = Math.floor(number / TC_ALPHABET.length);
    base36 = TC_ALPHABET[i] + base36;
  }
  return sign + base36;
}

function tcBearingDistance(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const lat1r = toRad(lat1);
  const lon1r = toRad(lon1);
  const lat2r = toRad(lat2);
  const lon2r = toRad(lon2);

  const dlat = lat2r - lat1r;
  const dlon = lon2r - lon1r;

  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dlon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = TC_EARTH_RADIUS_KM * c;

  const y = Math.sin(dlon) * Math.cos(lat2r);
  const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dlon);
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

  return { distanceKm: distance, bearingDeg: bearing };
}

// Zielpunkt aus Startpunkt + Peilung + Entfernung (Umkehrung von tcBearingDistance).
// Wird u.a. gebraucht, um Start-/Ziellinien senkrecht zum ersten/letzten Schenkel
// einer SoaringSpot-Aufgabe zu zeichnen.
function tcDestinationPoint(lat1, lon1, bearingDeg, distanceKm) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const lat1r = toRad(lat1);
  const lon1r = toRad(lon1);
  const brng = toRad(bearingDeg);
  const dR = distanceKm / TC_EARTH_RADIUS_KM;

  const lat2r = Math.asin(
    Math.sin(lat1r) * Math.cos(dR) + Math.cos(lat1r) * Math.sin(dR) * Math.cos(brng)
  );
  const lon2r =
    lon1r +
    Math.atan2(
      Math.sin(brng) * Math.sin(dR) * Math.cos(lat1r),
      Math.cos(dR) - Math.sin(lat1r) * Math.sin(lat2r)
    );

  return [toDeg(lat2r), ((toDeg(lon2r) + 540) % 360) - 180];
}

function encodeTeamcode(refLat, refLon, targetLat, targetLon) {
  const { distanceKm, bearingDeg } = tcBearingDistance(refLat, refLon, targetLat, targetLon);

  const firstChar = tcBase36Encode(Math.floor(bearingDeg / 10));
  const secondChar = tcBase36Encode(
    Math.round((bearingDeg / 10 - Math.floor(bearingDeg / 10)) * 36)
  );
  const directionCode = firstChar + secondChar;
  const distCode = tcBase36Encode(Math.round(distanceKm * 10));

  return directionCode + distCode;
}
