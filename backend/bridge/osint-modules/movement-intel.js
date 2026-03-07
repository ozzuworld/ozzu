// Movement Intelligence Module — Wi-Fi networks, flight tracking, ship tracking
// Correlates VIP locations with nearby infrastructure for pattern analysis
const db = require("../db");

// ── WiGLE Wi-Fi Network Search ──
// Search for Wi-Fi networks near known VIP locations
// Free tier: 10 queries/day with API key
async function searchWigle(lat, lon, radiusKm, apiName, apiToken) {
  if (!apiName || !apiToken) return [];
  const latRange = radiusKm / 111;
  const lonRange = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  try {
    const auth = Buffer.from(`${apiName}:${apiToken}`).toString("base64");
    const url = `https://api.wigle.net/api/v2/network/search?latrange1=${(lat - latRange).toFixed(6)}&latrange2=${(lat + latRange).toFixed(6)}&longrange1=${(lon - lonRange).toFixed(6)}&longrange2=${(lon + lonRange).toFixed(6)}&resultsPerPage=50`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(n => ({
      ssid: n.ssid || "(hidden)",
      bssid: n.netid,
      encryption: n.encryption,
      channel: n.channel,
      type: n.type,
      firstSeen: n.firsttime,
      lastSeen: n.lasttime,
      latitude: n.trilat,
      longitude: n.trilong,
    }));
  } catch {
    return [];
  }
}

// ── OpenSky Network — Flight Tracking ──
// Free, no API key needed. Search flights by callsign or within bounding box.
async function searchFlights(query, type = "callsign") {
  try {
    if (type === "callsign") {
      // Search recent flights by callsign (last 30 days)
      const end = Math.floor(Date.now() / 1000);
      const begin = end - 30 * 86400;
      const url = `https://opensky-network.org/api/flights/aircraft?icao24=${encodeURIComponent(query)}&begin=${begin}&end=${end}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return [];
      return (await res.json()).map(f => ({
        icao24: f.icao24,
        callsign: (f.callsign || "").trim(),
        departureAirport: f.estDepartureAirport,
        arrivalAirport: f.estArrivalAirport,
        firstSeen: f.firstSeen ? new Date(f.firstSeen * 1000).toISOString() : null,
        lastSeen: f.lastSeen ? new Date(f.lastSeen * 1000).toISOString() : null,
      }));
    } else if (type === "area") {
      // query = { lat, lon, radiusKm }
      const { lat, lon, radiusKm } = query;
      const latRange = radiusKm / 111;
      const lonRange = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
      const url = `https://opensky-network.org/api/states/all?lamin=${lat - latRange}&lomin=${lon - lonRange}&lamax=${lat + latRange}&lomax=${lon + lonRange}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.states || []).map(s => ({
        icao24: s[0],
        callsign: (s[1] || "").trim(),
        originCountry: s[2],
        latitude: s[6],
        longitude: s[5],
        altitude: s[7],
        velocity: s[9],
        onGround: s[8],
      }));
    }
    return [];
  } catch {
    return [];
  }
}

// ── VesselFinder / Marine Traffic (free scraping alternative) ──
// Use free AIS data from public APIs
async function searchVessels(query, type = "name") {
  // Use the free vessel search endpoint
  try {
    if (type === "name") {
      // Search by vessel name — use Digitraffic (Finnish free AIS API, covers many vessels)
      const url = `https://meri.digitraffic.fi/api/ais/v1/vessels?name=${encodeURIComponent(query)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];
      const data = await res.json();
      return (data || []).slice(0, 20).map(v => ({
        mmsi: v.mmsi,
        name: v.name,
        shipType: v.shipType,
        destination: v.destination,
        callSign: v.callSign,
        imo: v.imo,
        draught: v.draught,
        eta: v.eta,
      }));
    } else if (type === "area") {
      // Search by area — Digitraffic location endpoint
      const { lat, lon, radiusKm } = query;
      const latRange = radiusKm / 111;
      const lonRange = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
      const url = `https://meri.digitraffic.fi/api/ais/v1/locations?from=${lat - latRange}&to=${lon - lonRange}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.features || []).slice(0, 50).map(f => ({
        mmsi: f.mmsi,
        latitude: f.geometry?.coordinates?.[1],
        longitude: f.geometry?.coordinates?.[0],
        speed: f.properties?.sog,
        course: f.properties?.cog,
        heading: f.properties?.heading,
        timestamp: f.properties?.timestampExternal,
      }));
    }
    return [];
  } catch {
    return [];
  }
}

// Known aircraft registrations for notable individuals (public OSINT)
const KNOWN_AIRCRAFT = {
  "elon musk": [
    { icao24: "a835af", tail: "N628TS", type: "Gulfstream G650ER", note: "Primary jet" },
    { icao24: "a4f926", tail: "N272BG", type: "Gulfstream G550", note: "Secondary jet" },
  ],
  "jeff bezos": [
    { icao24: "a17114", tail: "N271DV", type: "Gulfstream G650ER", note: "Primary jet" },
  ],
  "bill gates": [
    { icao24: "a4f4f4", tail: "N887WM", type: "Bombardier BD-700", note: "Primary jet" },
  ],
  "mark zuckerberg": [
    { icao24: "aaa1a0", tail: "N68885", type: "Gulfstream G650", note: "Primary jet" },
  ],
  "donald trump": [
    { icao24: "a44e1d", tail: "N757AF", type: "Boeing 757-200", note: "Trump Force One" },
    { icao24: "a5ce87", tail: "N725DT", type: "Cessna Citation X", note: "Secondary" },
  ],
};

// Known yacht registrations
const KNOWN_VESSELS = {
  "elon musk": [], // Doesn't own yachts
  "jeff bezos": [
    { name: "Koru", mmsi: null, type: "Sailing Yacht", length: "127m", note: "Y721, largest sailing yacht" },
  ],
  "mark zuckerberg": [
    { name: "Launchpad", mmsi: null, type: "Motor Yacht", length: "118m", note: "Feadship, launched 2024" },
  ],
};

module.exports = {
  name: "movement-intel",
  profileTypes: ["image", "name", "username"],

  async scan(profile, rateLimiter, { db: dbRef }) {
    const findings = [];
    const wigleApiName = process.env.WIGLE_API_NAME;
    const wigleApiToken = process.env.WIGLE_API_TOKEN;

    // Get VIP name from profile or pivot profiles
    let vipName = null;
    if (profile.profile_type === "name") {
      vipName = profile.value?.toLowerCase();
    } else if (profile.profile_type === "image") {
      vipName = profile.label?.replace(/\s*\(.*\)/, "").toLowerCase();
      // Also check pivot profiles for name
      if (!vipName || vipName.length < 3) {
        const allProfiles = await db.getOsintProfiles();
        const nameProfile = allProfiles.find(p => p.profile_type === "name" && p.tags?.includes("auto-pivot"));
        if (nameProfile) vipName = nameProfile.value?.toLowerCase();
      }
    }

    // Get known locations for this profile
    const locations = await db.getOsintLocations({ profile_id: profile.id });
    const highConfLocs = locations.filter(l => l.latitude && l.longitude && (l.confidence || 0) >= 0.6);

    // ── 1. Aircraft Tracking ──
    if (vipName) {
      const knownAircraft = KNOWN_AIRCRAFT[vipName];
      if (knownAircraft?.length) {
        for (const aircraft of knownAircraft) {
          const release = await rateLimiter.acquire();
          try {
            const flights = await searchFlights(aircraft.icao24, "callsign");
            if (flights.length > 0) {
              const recentFlights = flights.slice(0, 20);
              const airports = new Set();
              for (const f of recentFlights) {
                if (f.departureAirport) airports.add(f.departureAirport);
                if (f.arrivalAirport) airports.add(f.arrivalAirport);
              }

              findings.push({
                category: "geoint",
                severity: "high",
                title: `Flight tracking: ${recentFlights.length} flights for ${aircraft.tail} (${aircraft.type})`,
                description: `${aircraft.note}. Airports visited: ${[...airports].join(", ") || "unknown"}. ` +
                  `Latest: ${recentFlights[0]?.departureAirport || "?"} -> ${recentFlights[0]?.arrivalAirport || "?"} on ${recentFlights[0]?.firstSeen?.split("T")[0] || "?"}`,
                rawData: {
                  type: "flight_tracking",
                  aircraft,
                  flightCount: recentFlights.length,
                  flights: recentFlights,
                  airportsVisited: [...airports],
                },
              });

              // Store airport locations
              for (const airport of airports) {
                if (!airport || airport === "null") continue;
                try {
                  await new Promise(r => setTimeout(r, 1100));
                  const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(airport + " airport")}&format=json&limit=1`;
                  const geoRes = await fetch(geoUrl, {
                    headers: { "User-Agent": "OzzuIntel/1.0" },
                    signal: AbortSignal.timeout(8000),
                  });
                  if (geoRes.ok) {
                    const geoData = await geoRes.json();
                    if (geoData.length > 0) {
                      await db.upsertOsintLocation(profile.id, {
                        latitude: parseFloat(geoData[0].lat),
                        longitude: parseFloat(geoData[0].lon),
                        location_text: `Flight: ${airport} (${aircraft.tail})`,
                        source_module: "movement-intel",
                        confidence: 0.75,
                        location_type: "flight_destination",
                        raw_data: { airport, aircraft: aircraft.tail, icao24: aircraft.icao24 },
                      });
                    }
                  }
                } catch { /* skip geocoding failures */ }
              }
            } else {
              findings.push({
                category: "geoint",
                severity: "medium",
                title: `Flight tracking: no recent flights for ${aircraft.tail} (${aircraft.type})`,
                description: `${aircraft.note}. ICAO24: ${aircraft.icao24}. No flights recorded in OpenSky in the last 30 days.`,
                rawData: { type: "flight_tracking", aircraft, flightCount: 0 },
              });
            }
          } catch (err) {
            findings.push({
              category: "geoint",
              severity: "info",
              title: `Flight tracking error for ${aircraft.tail}: ${err.message}`,
              rawData: { type: "flight_error", aircraft, error: err.message },
            });
          } finally {
            release();
          }
        }
      } else {
        // No known aircraft — note it
        findings.push({
          category: "geoint",
          severity: "info",
          title: "Flight tracking: no known aircraft registrations for this VIP",
          description: "Add aircraft ICAO24 codes to movement-intel.js KNOWN_AIRCRAFT to enable flight tracking.",
          rawData: { type: "flight_no_data", vipName },
        });
      }

      // ── 2. Vessel / Yacht Tracking ──
      const knownVessels = KNOWN_VESSELS[vipName];
      if (knownVessels?.length) {
        for (const vessel of knownVessels) {
          const release = await rateLimiter.acquire();
          try {
            const results = await searchVessels(vessel.name, "name");
            if (results.length > 0) {
              findings.push({
                category: "geoint",
                severity: "high",
                title: `Vessel tracking: ${vessel.name} (${vessel.type}, ${vessel.length})`,
                description: `${vessel.note}. ${results[0].destination ? "Destination: " + results[0].destination : "No destination set"}. ${results[0].callSign ? "Call sign: " + results[0].callSign : ""}`,
                rawData: { type: "vessel_tracking", vessel, aisData: results[0] },
              });
            } else {
              findings.push({
                category: "geoint",
                severity: "medium",
                title: `Vessel tracking: ${vessel.name} — not found in AIS data`,
                description: `${vessel.note}. Vessel may be outside AIS coverage or transponder off.`,
                rawData: { type: "vessel_no_signal", vessel },
              });
            }
          } catch (err) {
            findings.push({
              category: "geoint",
              severity: "info",
              title: `Vessel tracking error for ${vessel.name}: ${err.message}`,
              rawData: { type: "vessel_error", vessel, error: err.message },
            });
          } finally {
            release();
          }
        }
      }
    }

    // ── 3. WiGLE Wi-Fi Network Analysis ──
    if (wigleApiName && wigleApiToken && highConfLocs.length > 0) {
      // Pick top 2 locations (avoid burning API quota)
      const searchLocs = highConfLocs
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, 2);

      for (const loc of searchLocs) {
        const release = await rateLimiter.acquire();
        try {
          const networks = await searchWigle(loc.latitude, loc.longitude, 0.5, wigleApiName, wigleApiToken);
          if (networks.length > 0) {
            // Look for personally identifiable SSIDs
            const personalSSIDs = networks.filter(n =>
              n.ssid && n.ssid !== "(hidden)" &&
              (n.ssid.toLowerCase().includes(vipName?.split(" ")[0] || "___") ||
               /[A-Z][a-z]+['s]*\s*(Wi-?Fi|Network|Home|House|iPhone|iPad|Galaxy)/i.test(n.ssid))
            );

            findings.push({
              category: "geoint",
              severity: personalSSIDs.length > 0 ? "high" : "medium",
              title: `Wi-Fi scan: ${networks.length} networks near ${loc.location_text}${personalSSIDs.length ? ` (${personalSSIDs.length} personal)` : ""}`,
              description: personalSSIDs.length > 0
                ? `Potentially personal SSIDs: ${personalSSIDs.map(n => n.ssid).join(", ")}`
                : `${networks.length} networks found within 500m. No personally identifiable SSIDs detected.`,
              rawData: {
                type: "wigle_scan",
                location: loc.location_text,
                totalNetworks: networks.length,
                personalSSIDs: personalSSIDs.map(n => ({ ssid: n.ssid, bssid: n.bssid, encryption: n.encryption })),
                sampleNetworks: networks.slice(0, 10).map(n => ({ ssid: n.ssid, encryption: n.encryption, type: n.type })),
              },
            });
          }
        } catch (err) {
          findings.push({
            category: "geoint",
            severity: "info",
            title: `WiGLE error near ${loc.location_text}: ${err.message}`,
            rawData: { type: "wigle_error", error: err.message },
          });
        } finally {
          release();
        }
      }
    } else if (!wigleApiName || !wigleApiToken) {
      if (highConfLocs.length > 0) {
        findings.push({
          category: "geoint",
          severity: "info",
          title: "Wi-Fi analysis: WIGLE_API_NAME/WIGLE_API_TOKEN not configured",
          description: "Set WIGLE_API_NAME and WIGLE_API_TOKEN in backend/.env to enable Wi-Fi network analysis near VIP locations.",
          rawData: { type: "wigle_not_configured" },
        });
      }
    }

    // ── 4. Flight path analysis (airport proximity to VIP locations) ──
    if (highConfLocs.length > 0) {
      // Check which known locations are near major airports
      const airportProximity = [];
      for (const loc of highConfLocs.slice(0, 5)) {
        try {
          await new Promise(r => setTimeout(r, 1100));
          const url = `https://nominatim.openstreetmap.org/search?q=airport&format=json&limit=3&bounded=1&viewbox=${loc.longitude - 0.3},${loc.latitude + 0.2},${loc.longitude + 0.3},${loc.latitude - 0.2}`;
          const res = await fetch(url, {
            headers: { "User-Agent": "OzzuIntel/1.0" },
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const airports = await res.json();
            for (const ap of airports) {
              airportProximity.push({
                airport: ap.display_name?.split(",")[0],
                nearLocation: loc.location_text,
                distance: haversine(loc.latitude, loc.longitude, parseFloat(ap.lat), parseFloat(ap.lon)),
              });
            }
          }
        } catch { /* skip */ }
      }

      if (airportProximity.length > 0) {
        const nearby = airportProximity.filter(a => a.distance < 30).sort((a, b) => a.distance - b.distance);
        if (nearby.length > 0) {
          findings.push({
            category: "geoint",
            severity: "low",
            title: `Airport proximity: ${nearby.length} airports within 30km of VIP locations`,
            description: nearby.slice(0, 5).map(a => `${a.airport} (${a.distance.toFixed(1)}km from ${a.nearLocation})`).join("\n"),
            rawData: { type: "airport_proximity", airports: nearby.slice(0, 10) },
          });
        }
      }
    }

    if (findings.length === 0) {
      findings.push({
        category: "geoint",
        severity: "info",
        title: "Movement intel: no signals collected",
        description: "No aircraft registrations, vessel data, or Wi-Fi networks found for this profile.",
        rawData: { type: "movement_empty" },
      });
    }

    return findings;
  },
};

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
