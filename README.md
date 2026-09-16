# OGN Live-Tracker mit Teamcode (Phase 1)

Diese erste Ausbaustufe enthält:

- Live-Kartendarstellung von Segelflugzeugen (OpenStreetMap + OGN-Live-Positionen)
- Klick auf ein Flugzeug → Anzeige der üblichen Parameter **plus aktuellem Teamcode**
- "Teamcode-Modus": auf die Karte klicken → Teamcode für diese Position wird angezeigt
- Teamcode eingeben → Position wird auf der Karte angezeigt
- Referenzpunkt aktuell fest hinterlegt (Standard: Bad Nauheim) – Auswahl per CUP-Datei
  folgt in der nächsten Ausbaustufe

**Datenquelle:** Es wird keine private/Website-Schnittstelle "gescraped", sondern die
offizielle, öffentlich dokumentierte APRS-IS-Schnittstelle des Open Glider Network
(`aprs.glidernet.org`) genutzt – genau die Quelle, aus der sich auch glidertracker.de
und glideandseek speisen.

**Wichtiger Hinweis zum Teamcode:** Die Berechnung wurde 1:1 aus deinem
Ausgangs-Skript übernommen und per Rundreise-Test (Codieren → Decodieren →
Vergleich) auf interne Konsistenz geprüft. Sie wurde aber **nicht** gegen ein
echtes SeeYou/XCSoar-Gerät verifiziert. Bitte vor dem operativen Einsatz einmal
einen Code mit einem echten Gerät austauschen und gegenprüfen.

---

## 1. Lokal auf deinem PC testen

Das ist die beste erste Station – funktioniert unabhängig davon, ob du später
einen Server einrichtest, und der Code ist identisch (kein Umbau nötig).

Voraussetzung: Python 3.11 oder neuer.

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Danach im Browser öffnen: http://127.0.0.1:8000

Live-Flugzeuge erscheinen nur, wenn dein PC eine ausgehende Verbindung zu
`aprs.glidernet.org` Port `14580` aufbauen kann (normale Heim-/Firmennetzwerke
erlauben das in der Regel, manche restriktiven Firmennetze evtl. nicht).

## 2. Später auf einen Server umziehen

Der Code ist von Anfang an so gebaut, dass "lokal" und "Server" **derselbe
Code** sind – es ändert sich nur, WO `uvicorn` läuft, nicht WAS läuft. Der
Umzug ist also: Dateien auf den Server kopieren, dieselben Installationsschritte
wie oben ausführen, und statt `--reload` dauerhaft laufen lassen (siehe unten).

### Empfehlung für einen günstigen Server

- **Hetzner Cloud CX22** (Deutschland/Finnland, ca. 4–5 €/Monat): 2 vCPU, 4 GB RAM,
  völlig ausreichend für dieses Tool. https://www.hetzner.com/cloud/
- Alternativen: Netcup (auch günstig, deutscher Anbieter), Contabo (sehr günstig,
  aber etwas wechselhafter Support).
- Betriebssystem: Ubuntu 24.04 LTS auswählen (Standard bei allen genannten Anbietern).

### Einrichtung auf dem Server (Ubuntu)

```bash
# 1. Auf dem Server einloggen (Zugangsdaten kommen per E-Mail vom Hoster)
ssh root@DEINE-SERVER-IP

# 2. Grundpakete installieren
apt update && apt install -y python3-venv python3-pip git

# 3. Projekt-Ordner anlegen und Dateien hochladen
mkdir -p /opt/ogn-teamcode-tool
# -> von deinem PC aus (nicht auf dem Server!) z.B. mit scp oder rsync:
#    scp -r ogn-teamcode-tool root@DEINE-SERVER-IP:/opt/

# 4. Auf dem Server: Abhängigkeiten installieren
cd /opt/ogn-teamcode-tool/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Dauerhaft laufen lassen (systemd)

Datei `/etc/systemd/system/ogn-teamcode.service` anlegen:

```ini
[Unit]
Description=OGN Teamcode Tool
After=network.target

[Service]
WorkingDirectory=/opt/ogn-teamcode-tool/backend
ExecStart=/opt/ogn-teamcode-tool/backend/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

Dann aktivieren:

```bash
systemctl daemon-reload
systemctl enable --now ogn-teamcode
systemctl status ogn-teamcode   # sollte "active (running)" zeigen
```

### Von außen erreichbar machen (mit automatischem HTTPS)

Am einfachsten mit **Caddy** – ein Webserver, der HTTPS-Zertifikate automatisch
selbst einrichtet:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Datei `/etc/caddy/Caddyfile`:

```
deine-domain.de {
    reverse_proxy 127.0.0.1:8000
}
```

(Voraussetzung: Ein DNS-A-Eintrag für `deine-domain.de`, der auf die Server-IP
zeigt. Eine Domain bekommst du z.B. günstig bei Netcup oder INWX. Falls du erstmal
keine eigene Domain willst, kann man Caddy auch nur mit der nackten Server-IP ohne
HTTPS betreiben – für ein internes Tool unter Freunden reicht das oft.)

```bash
systemctl reload caddy
```

Danach ist die Seite unter `https://deine-domain.de` erreichbar.

---

## Projektstruktur

```
backend/
  app/
    main.py        FastAPI-Server, alle API-Endpunkte
    ogn_feed.py     Verbindung zum OGN-APRS-IS-Netzwerk, hält Live-Positionen im Speicher
    ddb.py          Lädt die OGN-Geräte-Datenbank (Kennung/Wettbewerbsnummer je Gerät)
    teamcode.py     Teamcode-Berechnung (Encode + Decode)
  data/
    reference.json  Aktueller Referenzpunkt (wird automatisch angelegt)
  requirements.txt
frontend/
  index.html
  app.js            Karten-Logik, Live-Aktualisierung, Bedienung
  teamcode.js        Teamcode-Berechnung im Browser (identisch zu teamcode.py)
  style.css
```

## Nächste Ausbaustufen (noch nicht enthalten)

- Flugwege (Track) und Barogramm pro Flugzeug (siehe Hinweis unten)

## Phase 3 (bereits enthalten)

- **SoaringSpot-Aufgaben:** Bis zu 3 Task-Links eingeben (z.B.
  `https://www.soaringspot.com/en_gb/<wettbewerb>/tasks/<klasse>/<task>`),
  werden in Rot/Blau/Grün mit Route + Zylindern dargestellt. Funktioniert nur
  für öffentliche Wettbewerbe (kein Login). Technisch: die Task-Seite liefert
  nur Namen/Radien, die Koordinaten werden automatisch aus der
  CUP-Wendepunktdatei des Wettbewerbs (von der Downloads-Seite) nachgeladen
  und per Namensabgleich zugeordnet. Wendepunkte, die nicht gefunden werden,
  werden dir angezeigt statt den ganzen Import abzubrechen.
- **Luftraum:** OpenAir-Datei (.txt) hochladen, ein-/ausblendbar über einen
  Schalter, anklickbar mit Name/Klasse/Höhengrenzen, Button
  "Für heute deaktivieren" (gilt nur in deinem eigenen Browser, bis Mitternacht).

**Wichtiger Hinweis zu SoaringSpot:** Ich konnte diesen Teil nicht gegen die
echte soaringspot.com-Seite testen (Netzwerk-Einschränkung meiner
Entwicklungsumgebung), sondern nur mit einer nachgebauten Testseite, die exakt
deiner echten Struktur entspricht. Bitte einmal mit einem echten Link testen
und mir Bescheid geben, falls Wendepunkte nicht gefunden werden oder ein
Fehler auftaucht - dann schauen wir uns die genaue Fehlermeldung an.

**Neue Abhängigkeiten:** `beautifulsoup4` und `lxml` (fürs Lesen der
SoaringSpot-Seiten). Einmal `pip install -r requirements.txt` erneut
ausführen.

## Phase 2 (bereits enthalten)

- CUP-Datei hochladen, Wendepunkt als Referenzpunkt auswählen
- Flugzeug-Icons nach Klasse eingefärbt/unterschieden (Segler, Schlepper,
  Hubschrauber, Motorflugzeug, ...) inkl. Wettbewerbskennzeichen als Label
  über dem Symbol
- Filter-Checkboxen pro Flugzeugklasse in der Seitenleiste

**Wichtig beim Update:** Phase 2 braucht eine zusätzliche Abhängigkeit
(`python-multipart`, für den Datei-Upload). Falls du dein `venv` schon
angelegt hattest, einmal erneut ausführen:

```bash
cd backend
source venv/bin/activate
pip install -r requirements.txt
```

## Neu: Übermenü, eigene Flugzeugliste per Excel, Anzeige-Radius

- **Übermenü** (⚙-Symbol oben in der Kopfzeile): steuert, welche Seitenleisten-
  Bereiche überhaupt sichtbar sind, den Anzeige-Radius um Referenzpunkt ODER
  eigene Position (Browser-Standort, per Häkchen anzeigbar), und die eigene
  Flugzeugliste.
- **Eigene Flugzeugliste:** jetzt per Excel-Upload (Spalten: FlarmID,
  Wettbewerbskennzeichen, Land, Flugzeugtyp), direkt editierbare Tabelle,
  Export als `userflarm.xml` (kompatibles Format) oder als Excel. Beim
  Excel-Upload wird gefragt, ob die bestehende Liste ersetzt oder ergänzt
  werden soll. Es wird ausschließlich das Wettbewerbskennzeichen überschrieben,
  nie die Kennung.
- **Bugfix SoaringSpot-Automatik:** Luftraum und Wendepunktdatei werden jetzt
  auch geladen, wenn für den heutigen Tag noch keine Aufgabe veröffentlicht ist
  (vorher brach der gesamte Import in diesem Fall ab).
- **Segelflugzeug-Symbol:** eigene, glider-typische Silhouette (lange gerade
  Tragflächen, schmaler Rumpf) statt der bisherigen gestreckten Motorflugzeug-Form.

## Neu: CUP-Aufgaben, eigene Flugzeugliste, SoaringSpot-Automatik

- **Aufgaben direkt aus der CUP-Datei:** Beim CUP-Upload werden jetzt auch
  enthaltene Aufgaben (die "-----Related Tasks-----"-Sektion) erkannt.
  Auswählen und einem der 3 Farb-Slots zuweisen - genau wie bei SoaringSpot-
  Aufgaben, inklusive Start-/Ziellinien-Erkennung.
- **Eigene Flugzeugliste:** FLARM-ID, Kennzeichen, Land (→ Flagge) und Typ
  hinterlegen (eine Zeile pro Flugzeug: `FLARM-ID,Kennzeichen,Land,Typ`).
  Überschreibt die angezeigte Kennung/Flagge/Typ für passende Flugzeuge,
  optional exklusiv nur diese anzeigen.
- **SoaringSpot-Automatik:** Ein einziger Link zum Wettbewerb lädt
  automatisch die heutigen Aufgaben aller Klassen (bis zu 3 Farb-Slots),
  die Luftraum-Datei und die Wendepunktdatei.

**Wichtiger Hinweis zur SoaringSpot-Automatik:** Die Erkennung "alle Klassen
am heutigen Tag" beruht auf einem Muster (Links der Form
`/tasks/<klasse>/task-N-on-<heutiges-Datum>` auf der Wettbewerbs-Hauptseite
bzw. `/results`-Unterseite). Das konnte ich nicht live gegen echtes
SoaringSpot testen. Bitte an einem echten Wettbewerbstag einmal ausprobieren
und mir sagen, was die Statusbox anzeigt (auch im Fehlerfall - die genaue
Meldung hilft beim Nachbessern).

## Wetter-Ebenen (Radar/Satellit) – bitte einmal testen!

Neu dabei: DWD-Regenradar und EUMETSAT-Satellitenbild als ein-/ausblendbare
Kartenebenen mit Abspielfunktion und Zeitstempel-Anzeige. Radar wird immer
über dem Satellitenbild angezeigt (beide gleichzeitig aktivierbar).

**Das ist der einzige Teil, den ich nicht live gegen die echten Dienste
testen konnte** (meine Entwicklungsumgebung kann `maps.dwd.de` und
`view.eumetsat.int` nicht erreichen). Der Code ist deshalb bewusst
selbstdiagnostizierend gebaut: Er fragt beim Aktivieren live nach, welche
Ebenen-Namen aktuell existieren. Falls einer meiner vermuteten Namen falsch
ist, siehst du das direkt als Fehlertext unter dem jeweiligen Schalter
("Keine passende Ebene gefunden. Ähnliche vorhanden: ...") - das hilft uns,
es in einer Zeile Code zu korrigieren, statt zu raten.

Bitte einmal ausprobieren und mir sagen, was die Statusboxen anzeigen (auch
wenn "gefunden: false" - die Liste "Ähnliche vorhanden" ist dann genau das,
was ich brauche, um den richtigen Namen einzusetzen).

## Flugwege & Barogramm – deine Frage

Kurze Antwort: **Ja, technisch geht beides**, aber mit einer wichtigen
Einschränkung, die mit der Datenquelle zusammenhängt:

- Das OGN-Netzwerk selbst speichert **keine** Historie – es ist ein reiner
  Live-Datenstrom. Sobald ein Positions-Beacon durchgelaufen ist, ist er weg,
  wenn niemand ihn aufzeichnet.
- Das heißt: **Rückwirkend** (für Zeiträume, bevor unser Server lief oder
  bevor ein bestimmtes Flugzeug zum ersten Mal erfasst wurde) können wir
  keine Tracks/Barogramme aus dem Live-Feed rekonstruieren. Es gibt zwar
  Dritt-Archive (z.B. der OGN-eigene "Flight Logbook"-Dienst oder Skylines),
  die das teilweise nachträglich anbieten – das wäre ein separates Thema
  (eigene Anbindung an so einen Archivdienst), kein Teil unseres Live-Tools.
- **Ab jetzt / ab Serverstart** ist es dagegen gut machbar: Wir müssten
  einfach für jedes Flugzeug die eingehenden Positionen (statt sie wie
  aktuell zu überschreiben) fortlaufend mitspeichern, und daraus dann
  Flugweg-Linie und Höhen-über-Zeit-Diagramm (Barogramm) generieren.
  Je länger der Server läuft, desto mehr Historie sammelt sich an.

Das wäre also ein guter Kandidat für eine eigene Ausbaustufe danach, falls
gewünscht.
