// Surveillance & Property Intel Module — open cameras, street view, property records
// Sources: Shodan (cameras/IoT), Insecam, Google Street View metadata, property APIs
const db = require("../db");

// ── Shodan — search for exposed cameras/IoT near coordinates ──
async function searchShodan(lat, lon, radiusKm, apiKey) {
  if (!apiKey) return [];
  try {
    // Shodan search by geo coordinates
    const query = `geo:${lat},${lon},${radiusKm} has_screenshot:true`;
    const url = `https://api.shodan.io/shodan/host/search?key=${apiKey}&query=${encodeURIComponent(query)}&minify=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.matches || []).map(m => ({
      ip: m.ip_str,
      port: m.port,
      org: m.org,
      product: m.product,
      os: m.os,
      hostnames: m.hostnames || [],
      latitude: m.location?.latitude,
      longitude: m.location?.longitude,
      city: m.location?.city,
      country: m.location?.country_name,
      hasScreenshot: !!m.opts?.screenshot,
      title: m.http?.title || m.data?.substring(0, 80),
      timestamp: m.timestamp,
    }));
  } catch {
    return [];
  }
}

// ── Insecam — search for open/public cameras by country ──
// Insecam doesn't have an API, but we can aggregate known camera types from Shodan
function identifyCameraDevices(shodanResults) {
  const cameraKeywords = ["camera", "webcam", "ipcam", "hikvision", "dahua", "axis", "foscam",
    "rtsp", "mjpg", "video", "dvr", "nvr", "surveillance", "cctv", "onvif", "amcrest", "reolink"];
  return shodanResults.filter(r => {
    const searchStr = `${r.product || ""} ${r.title || ""} ${r.org || ""}`.toLowerCase();
    return cameraKeywords.some(kw => searchStr.includes(kw));
  });
}

// ── Google Street View — check coverage availability ──
async function checkStreetViewCoverage(lat, lon) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}&key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      available: data.status === "OK",
      date: data.date,
      panoId: data.pano_id,
      location: data.location,
    };
  } catch {
    return null;
  }
}

// ── Property Records — search public property databases ──
// OpenAddresses.io (free bulk, no API) — we use Nominatim reverse for property info
async function getPropertyInfo(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&extratags=1&namedetails=1&zoom=18`;
    const res = await fetch(url, {
      headers: { "User-Agent": "OzzuIntel/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      displayName: data.display_name,
      address: data.address,
      type: data.type,
      category: data.category,
      extratags: data.extratags || {},
      namedetails: data.namedetails || {},
      importance: data.importance,
      osmId: data.osm_id,
      osmType: data.osm_type,
      boundingbox: data.boundingbox,
    };
  } catch {
    return null;
  }
}

// ── Zillow / Property value estimation (US only) ──
// No free API — use basic OSM data + property type estimation
function estimatePropertyType(nominatimData) {
  if (!nominatimData) return null;
  const addr = nominatimData.address || {};
  const type = nominatimData.type;
  const ext = nominatimData.extratags || {};

  return {
    propertyType: type === "house" ? "residential" :
      type === "apartments" ? "multi-family" :
      type === "commercial" ? "commercial" :
      type === "industrial" ? "industrial" :
      addr.building ? "building" : "unknown",
    neighborhood: addr.neighbourhood || addr.suburb || addr.quarter,
    city: addr.city || addr.town || addr.village,
    state: addr.state,
    country: addr.country,
    postcode: addr.postcode,
    road: addr.road,
    houseNumber: addr.house_number,
    building: ext.building || type,
    levels: ext["building:levels"],
    architect: ext.architect,
    startDate: ext.start_date,
    wikidata: ext.wikidata,
  };
}

module.exports = {
  name: "surveillance-intel",
  profileTypes: ["image", "name"],

  async scan(profile, rateLimiter, { db: dbRef }) {
    const findings = [];
    const shodanKey = process.env.SHODAN_API_KEY;
    const googleKey = process.env.GOOGLE_MAPS_API_KEY;

    // Get high-confidence locations
    const locations = await db.getOsintLocations({ profile_id: profile.id });
    const highConfLocs = locations.filter(l => l.latitude && l.longitude && (l.confidence || 0) >= 0.7);

    if (highConfLocs.length === 0) {
      findings.push({
        category: "geoint",
        severity: "info",
        title: "Surveillance intel: no high-confidence locations to analyze",
        rawData: { type: "surveillance_no_locations" },
      });
      return findings;
    }

    // Deduplicate and pick top 3
    const searchLocs = dedupeByProximity(highConfLocs, 20).slice(0, 3);

    for (const loc of searchLocs) {
      // ── 1. Shodan — exposed cameras & IoT ──
      if (shodanKey) {
        const release = await rateLimiter.acquire();
        try {
          const results = await searchShodan(loc.latitude, loc.longitude, 5, shodanKey);
          if (results.length > 0) {
            const cameras = identifyCameraDevices(results);

            findings.push({
              category: "geoint",
              severity: cameras.length > 0 ? "high" : "medium",
              title: `Shodan: ${results.length} exposed devices near ${loc.location_text}${cameras.length ? ` (${cameras.length} cameras)` : ""}`,
              description: cameras.length > 0
                ? `Open cameras: ${cameras.slice(0, 5).map(c => `${c.product || "Unknown"} at ${c.ip}:${c.port}`).join(", ")}`
                : `${results.length} devices found. Products: ${[...new Set(results.map(r => r.product).filter(Boolean))].slice(0, 5).join(", ")}`,
              rawData: {
                type: "shodan_scan",
                location: loc.location_text,
                totalDevices: results.length,
                cameras: cameras.length,
                devices: results.slice(0, 20),
              },
            });

            // Store camera locations
            for (const cam of cameras.slice(0, 5)) {
              if (cam.latitude && cam.longitude) {
                try {
                  await db.upsertOsintLocation(profile.id, {
                    latitude: cam.latitude,
                    longitude: cam.longitude,
                    location_text: `Camera: ${cam.product || "Unknown"} (${cam.ip}:${cam.port})`,
                    source_module: "surveillance-intel",
                    confidence: 0.55,
                    location_type: "surveillance_camera",
                    raw_data: { ip: cam.ip, port: cam.port, product: cam.product, org: cam.org },
                  });
                } catch { /* skip dupes */ }
              }
            }
          }
        } catch (err) {
          findings.push({
            category: "geoint",
            severity: "info",
            title: `Shodan error near ${loc.location_text}: ${err.message}`,
            rawData: { type: "shodan_error", error: err.message },
          });
        } finally {
          release();
        }
      } else {
        findings.push({
          category: "geoint",
          severity: "info",
          title: "Shodan: SHODAN_API_KEY not configured",
          description: "Set SHODAN_API_KEY in backend/.env to scan for exposed cameras and IoT devices near VIP locations.",
          rawData: { type: "shodan_not_configured" },
        });
      }

      // ── 2. Street View coverage ──
      if (googleKey) {
        const release = await rateLimiter.acquire();
        try {
          const sv = await checkStreetViewCoverage(loc.latitude, loc.longitude);
          if (sv) {
            findings.push({
              category: "geoint",
              severity: sv.available ? "medium" : "low",
              title: sv.available
                ? `Street View: coverage available near ${loc.location_text} (${sv.date || "date unknown"})`
                : `Street View: no coverage near ${loc.location_text}`,
              description: sv.available
                ? `Panorama ID: ${sv.panoId}. Imagery date: ${sv.date}. Location visible via Google Street View.`
                : "No Street View imagery available at this location.",
              rawData: { type: "street_view", location: loc.location_text, ...sv },
            });
          }
        } catch { /* skip */ } finally {
          release();
        }
      }

      // ── 3. Property records via Nominatim reverse geocoding ──
      const release = await rateLimiter.acquire();
      try {
        await new Promise(r => setTimeout(r, 1100)); // Nominatim rate limit
        const property = await getPropertyInfo(loc.latitude, loc.longitude);
        if (property) {
          const propType = estimatePropertyType(property);

          findings.push({
            category: "geoint",
            severity: "medium",
            title: `Property: ${propType?.propertyType || "unknown"} at ${propType?.road || ""} ${propType?.houseNumber || ""}, ${propType?.city || loc.location_text}`,
            description: [
              property.displayName,
              propType?.neighborhood && `Neighborhood: ${propType.neighborhood}`,
              propType?.postcode && `Postcode: ${propType.postcode}`,
              propType?.levels && `Building levels: ${propType.levels}`,
              propType?.startDate && `Built: ${propType.startDate}`,
              propType?.architect && `Architect: ${propType.architect}`,
              propType?.wikidata && `Wikidata: ${propType.wikidata}`,
            ].filter(Boolean).join("\n"),
            rawData: {
              type: "property_record",
              location: loc.location_text,
              property: propType,
              nominatim: {
                displayName: property.displayName,
                osmId: property.osmId,
                osmType: property.osmType,
                boundingbox: property.boundingbox,
              },
            },
          });
        }
      } catch { /* skip */ } finally {
        release();
      }
    }

    // ── 4. API status summary ──
    const unconfigured = [];
    if (!shodanKey) unconfigured.push("SHODAN_API_KEY");
    if (!googleKey) unconfigured.push("GOOGLE_MAPS_API_KEY");
    if (unconfigured.length > 0 && findings.length <= 1) {
      findings.push({
        category: "geoint",
        severity: "info",
        title: `Surveillance intel: ${unconfigured.length} API key(s) not configured`,
        description: `Missing: ${unconfigured.join(", ")}. Configure in backend/.env for full surveillance capabilities.`,
        rawData: { type: "surveillance_config", missing: unconfigured },
      });
    }

    if (findings.length === 0) {
      findings.push({
        category: "geoint",
        severity: "info",
        title: "Surveillance intel: no signals collected",
        rawData: { type: "surveillance_empty" },
      });
    }

    return findings;
  },
};

function dedupeByProximity(locations, proximityKm) {
  const result = [];
  for (const loc of locations) {
    const isDupe = result.some(r =>
      haversine(r.latitude, r.longitude, loc.latitude, loc.longitude) < proximityKm
    );
    if (!isDupe) result.push(loc);
  }
  return result;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
