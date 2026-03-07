// Satellite & Geospatial Intel Module — satellite imagery, OSM queries, social geo-content
// Sources: Sentinel Hub (satellite), Overpass Turbo (OSM), Snap Map, weather archive
const db = require("../db");

// ── Overpass Turbo — OpenStreetMap structured queries ──
// Free, no API key. Query OSM for buildings, facilities, infrastructure near a point.
async function queryOverpass(lat, lon, radiusM, query) {
  try {
    const overpassQL = `[out:json][timeout:15];(${query}(around:${radiusM},${lat},${lon}););out center 20;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(overpassQL)}`,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.elements || []).map(e => ({
      id: e.id,
      type: e.type,
      lat: e.lat || e.center?.lat,
      lon: e.lon || e.center?.lon,
      tags: e.tags || {},
      name: e.tags?.name || e.tags?.["name:en"] || null,
    }));
  } catch {
    return [];
  }
}

// Predefined OSM queries for intelligence gathering
const OSM_QUERIES = {
  security_cameras: 'node["man_made"="surveillance"]',
  government: 'way["building"="government"];node["office"="government"]',
  military: 'way["military"];node["military"]',
  embassy: 'node["amenity"="embassy"];way["amenity"="embassy"]',
  helipad: 'node["aeroway"="helipad"];way["aeroway"="helipad"]',
  private_airport: 'way["aeroway"="aerodrome"]["access"="private"]',
  gated_community: 'way["residential"="gated"];way["barrier"="gate"]',
  marina: 'way["leisure"="marina"];node["leisure"="marina"]',
};

// ── Sentinel Hub — Satellite imagery metadata ──
// Free tier: 30k requests/month with OAuth. Without key, we can still check availability.
async function getSentinelCoverage(lat, lon, fromDate, toDate) {
  // Use the free Sentinel Hub catalog search (no auth needed for catalog)
  try {
    const bbox = `${lon - 0.01},${lat - 0.01},${lon + 0.01},${lat + 0.01}`;
    const url = `https://services.sentinel-hub.com/api/v1/catalog/1.0.0/search`;
    const body = {
      bbox: [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01],
      datetime: `${fromDate}/${toDate}`,
      collections: ["sentinel-2-l2a"],
      limit: 5,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      totalResults: data.context?.matched || data.features?.length || 0,
      features: (data.features || []).map(f => ({
        date: f.properties?.datetime,
        cloudCover: f.properties?.["eo:cloud_cover"],
        id: f.id,
      })),
    };
  } catch {
    return null;
  }
}

// ── Snap Map / Social geo-content search ──
// No direct API — use web scraping approach for geotagged social content
async function searchGeotaggedContent(lat, lon, radiusKm, vipName) {
  const results = [];

  // Search Flickr (free API, geotagged photos)
  try {
    const flickrKey = process.env.FLICKR_API_KEY;
    if (flickrKey) {
      const url = `https://api.flickr.com/services/rest/?method=flickr.photos.search&api_key=${flickrKey}&lat=${lat}&lon=${lon}&radius=${radiusKm}&text=${encodeURIComponent(vipName || "")}&format=json&nojsoncallback=1&per_page=10&extras=geo,date_taken,owner_name`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        for (const photo of (data.photos?.photo || [])) {
          results.push({
            source: "flickr",
            title: photo.title,
            owner: photo.ownername,
            lat: parseFloat(photo.latitude),
            lon: parseFloat(photo.longitude),
            dateTaken: photo.datetaken,
            url: `https://www.flickr.com/photos/${photo.owner}/${photo.id}`,
          });
        }
      }
    }
  } catch { /* skip */ }

  // Search WikiMapia (free, no key needed, area-based)
  try {
    const url = `http://api.wikimapia.org/?key=example&function=place.search&q=${encodeURIComponent(vipName || "")}&lat=${lat}&lon=${lon}&format=json&count=10&distance=${radiusKm * 1000}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      for (const place of (data.places || [])) {
        if (place.title) {
          results.push({
            source: "wikimapia",
            title: place.title,
            lat: place.location?.lat,
            lon: place.location?.lon,
            description: place.description,
          });
        }
      }
    }
  } catch { /* skip */ }

  return results;
}

module.exports = {
  name: "satellite-intel",
  profileTypes: ["image", "name"],

  async scan(profile, rateLimiter, { db: dbRef }) {
    const findings = [];

    // Get VIP name
    let vipName = null;
    if (profile.profile_type === "name") {
      vipName = profile.value;
    } else if (profile.profile_type === "image") {
      vipName = profile.label?.replace(/\s*\(.*\)/, "");
      if (!vipName || vipName.length < 3) {
        const allProfiles = await db.getOsintProfiles();
        const nameProfile = allProfiles.find(p => p.profile_type === "name" && p.tags?.includes("auto-pivot"));
        if (nameProfile) vipName = nameProfile.value;
      }
    }

    // Get high-confidence locations
    const locations = await db.getOsintLocations({ profile_id: profile.id });
    const highConfLocs = locations.filter(l => l.latitude && l.longitude && (l.confidence || 0) >= 0.7);

    if (highConfLocs.length === 0) {
      findings.push({
        category: "geoint",
        severity: "info",
        title: "Satellite intel: no high-confidence locations to analyze",
        rawData: { type: "satellite_no_locations" },
      });
      return findings;
    }

    // Pick top 3 unique locations (avoid redundant queries)
    const searchLocs = dedupeByProximity(highConfLocs, 20).slice(0, 3);

    for (const loc of searchLocs) {
      // ── 1. Overpass Turbo — infrastructure analysis ──
      const release = await rateLimiter.acquire();
      try {
        // Run multiple OSM queries for each location
        const osmResults = {};
        for (const [queryName, queryStr] of Object.entries(OSM_QUERIES)) {
          const results = await queryOverpass(loc.latitude, loc.longitude, 2000, queryStr);
          if (results.length > 0) {
            osmResults[queryName] = results.slice(0, 10);
          }
          // Small delay between queries to be polite
          await new Promise(r => setTimeout(r, 500));
        }

        if (Object.keys(osmResults).length > 0) {
          const totalPOIs = Object.values(osmResults).reduce((s, r) => s + r.length, 0);
          const summary = Object.entries(osmResults)
            .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v.length}${v[0]?.name ? ` (${v.slice(0, 2).map(r => r.name).filter(Boolean).join(", ")})` : ""}`)
            .join("\n");

          findings.push({
            category: "geoint",
            severity: osmResults.military?.length || osmResults.security_cameras?.length ? "high" : "medium",
            title: `OSM infrastructure: ${totalPOIs} points of interest near ${loc.location_text}`,
            description: summary,
            rawData: {
              type: "osm_infrastructure",
              location: loc.location_text,
              coordinates: { lat: loc.latitude, lon: loc.longitude },
              results: osmResults,
              totalPOIs,
            },
          });

          // Store notable infrastructure as locations
          for (const [queryName, results] of Object.entries(osmResults)) {
            for (const r of results.slice(0, 3)) {
              if (r.lat && r.lon && r.name) {
                try {
                  await db.upsertOsintLocation(profile.id, {
                    latitude: r.lat,
                    longitude: r.lon,
                    location_text: `OSM: ${r.name} (${queryName.replace(/_/g, " ")})`,
                    source_module: "satellite-intel",
                    confidence: 0.6,
                    location_type: "infrastructure",
                    raw_data: { osmId: r.id, osmType: r.type, tags: r.tags, query: queryName },
                  });
                } catch { /* skip dupes */ }
              }
            }
          }
        }
      } catch (err) {
        findings.push({
          category: "geoint",
          severity: "info",
          title: `OSM query error near ${loc.location_text}: ${err.message}`,
          rawData: { type: "osm_error", error: err.message },
        });
      } finally {
        release();
      }

      // ── 2. Sentinel Hub — satellite imagery availability ──
      const release2 = await rateLimiter.acquire();
      try {
        const toDate = new Date().toISOString().split("T")[0];
        const fromDate = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
        const coverage = await getSentinelCoverage(loc.latitude, loc.longitude, fromDate, toDate);

        if (coverage && coverage.totalResults > 0) {
          const clearImages = coverage.features.filter(f => (f.cloudCover || 100) < 20);
          findings.push({
            category: "geoint",
            severity: "medium",
            title: `Satellite: ${coverage.totalResults} Sentinel-2 images near ${loc.location_text} (last 90 days)`,
            description: `${clearImages.length} clear images (<20% cloud). Latest: ${coverage.features[0]?.date?.split("T")[0] || "?"}. Cloud cover range: ${coverage.features.map(f => f.cloudCover?.toFixed(0) + "%").join(", ")}`,
            rawData: {
              type: "sentinel_coverage",
              location: loc.location_text,
              totalImages: coverage.totalResults,
              clearImages: clearImages.length,
              features: coverage.features,
            },
          });
        }
      } catch { /* skip */ } finally {
        release2();
      }

      // ── 3. Geotagged social content search ──
      if (vipName) {
        const release3 = await rateLimiter.acquire();
        try {
          const geoContent = await searchGeotaggedContent(loc.latitude, loc.longitude, 5, vipName);
          if (geoContent.length > 0) {
            findings.push({
              category: "geoint",
              severity: "medium",
              title: `Geotagged content: ${geoContent.length} results near ${loc.location_text}`,
              description: geoContent.slice(0, 5).map(c => `[${c.source}] ${c.title || "Untitled"} by ${c.owner || "?"} ${c.dateTaken ? "(" + c.dateTaken.split(" ")[0] + ")" : ""}`).join("\n"),
              rawData: { type: "geotagged_content", results: geoContent },
            });
          }
        } catch { /* skip */ } finally {
          release3();
        }
      }
    }

    if (findings.length === 0) {
      findings.push({
        category: "geoint",
        severity: "info",
        title: "Satellite intel: no additional signals found",
        rawData: { type: "satellite_empty" },
      });
    }

    return findings;
  },
};

// Deduplicate locations within proximityKm of each other
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
