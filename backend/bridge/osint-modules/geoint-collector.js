// GEOINT Collector Module — harvests location signals from ALL other modules' findings
// Geocodes text locations via Nominatim, geolocates IPs via ip-api.com
// Runs on all profile types — scans existing findings for location data
const db = require("../db");

// Nominatim geocoder (OpenStreetMap, free, 1 req/sec)
const _geocodeCache = new Map();

async function geocode(text, timeout = 8000) {
  if (!text || text.length < 2) return null;
  const key = text.toLowerCase().trim();
  if (_geocodeCache.has(key)) return _geocodeCache.get(key);

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(key)}&format=json&limit=1&addressdetails=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "OzzuIntel/1.0 (OSINT research tool)" },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) { _geocodeCache.set(key, null); return null; }

    const result = {
      latitude: parseFloat(data[0].lat),
      longitude: parseFloat(data[0].lon),
      displayName: data[0].display_name,
      type: data[0].type,
      importance: parseFloat(data[0].importance || 0),
      address: data[0].address || {},
    };
    _geocodeCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

// IP geolocation via ip-api.com (free, 45 req/min)
async function geolocateIp(ip, timeout = 5000) {
  if (!ip || /^(10\.|172\.(1[6-9]|2|3[01])\.|192\.168\.|127\.)/.test(ip)) return null; // skip private
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,lat,lon,city,regionName,country,isp,org,timezone`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "success") return null;
    return {
      latitude: data.lat,
      longitude: data.lon,
      city: data.city,
      region: data.regionName,
      country: data.country,
      isp: data.isp,
      org: data.org,
      timezone: data.timezone,
    };
  } catch {
    return null;
  }
}

// Rate limiter for Nominatim (1 req/sec)
let _lastGeocode = 0;
async function rateLimitedGeocode(text) {
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - _lastGeocode));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastGeocode = Date.now();
  return geocode(text);
}

module.exports = {
  name: "geoint-collector",
  // Run on all profile types — harvests from existing findings
  profileTypes: ["image", "username", "name", "email", "phone", "domain", "ip", "cedula", "nit"],

  async scan(profile, rateLimiter, { db: dbRef }) {
    const findings = [];
    const locationsToStore = [];

    // Get all existing findings for this profile AND its auto-pivot profiles
    let allFindings = await db.getOsintFindings({ profileId: profile.id, limit: 1000 });

    // If this is the parent image profile, aggregate findings from auto-pivot profiles
    if (profile.profile_type === "image") {
      try {
        const allProfiles = await db.getOsintProfiles();
        const pivotProfiles = allProfiles.filter(p => p.id !== profile.id && p.tags?.includes("auto-pivot"));
        for (const pp of pivotProfiles) {
          const pivotFindings = await db.getOsintFindings({ profileId: pp.id, limit: 500 });
          allFindings = allFindings.concat(pivotFindings);
        }
        if (pivotProfiles.length > 0) {
          console.log(`[geoint] Aggregated findings from ${pivotProfiles.length} pivot profiles (${allFindings.length} total findings)`);
        }
      } catch (e) {
        console.error(`[geoint] Failed to aggregate pivot profiles:`, e.message);
      }
    }

    // Check existing locations to avoid duplicates
    const existingLocs = await db.getOsintLocations({ profile_id: profile.id });
    const existingKeys = new Set(existingLocs.map(l =>
      `${l.source_module}:${(l.location_text || "").toLowerCase().trim()}`
    ));
    // Also track what we're adding in this run to dedupe across pivots
    const pendingKeys = new Set();

    function isDupe(module, text) {
      const key = `${module}:${(text || "").toLowerCase().trim()}`;
      if (existingKeys.has(key) || pendingKeys.has(key)) return true;
      pendingKeys.add(key);
      return false;
    }

    // ── 1. EXIF GPS (exact coordinates) ──
    for (const f of allFindings.filter(f => f.module === "exif-extract" && f.raw_data?.gps)) {
      const lat = f.raw_data.latitude;
      const lon = f.raw_data.longitude;
      if (lat && lon && !isDupe("exif-extract", `${lat},${lon}`)) {
        locationsToStore.push({
          latitude: lat, longitude: lon,
          location_text: `EXIF GPS: ${lat.toFixed(6)}, ${lon.toFixed(6)}`,
          source_module: "exif-extract",
          source_finding_id: f.id,
          confidence: 0.99,
          location_type: "exact_gps",
          raw_data: { altitude: f.raw_data.altitude },
        });
      }
    }

    // ── 2. Scene Analysis regions ──
    for (const f of allFindings.filter(f => f.module === "scene-analysis" && f.raw_data?.analysis?.location)) {
      const loc = f.raw_data.analysis.location;
      const region = loc.estimated_region;
      if (region && !isDupe("scene-analysis", region)) {
        const confMap = { high: 0.6, medium: 0.35, low: 0.15 };
        const conf = confMap[loc.confidence] || 0.25;

        // Geocode the region name
        const geo = await rateLimitedGeocode(region);
        locationsToStore.push({
          latitude: geo?.latitude || null,
          longitude: geo?.longitude || null,
          location_text: region,
          source_module: "scene-analysis",
          source_finding_id: f.id,
          confidence: conf,
          location_type: "scene_estimated",
          raw_data: {
            environment: loc.environment,
            climate: loc.climate_clues,
            indicators: loc.indicators,
            geocoded: !!geo,
            geocodedDisplay: geo?.displayName,
          },
        });
      }
    }

    // ── 3. Wikipedia structured data (citizenship, birthplace) ──
    for (const f of allFindings.filter(f => f.module === "wikipedia-intel" && f.raw_data?.type === "wikipedia_profile")) {
      const s = f.raw_data.structured || {};

      // Citizenship/nationality
      for (const country of (s.citizenship || [])) {
        if (!isDupe("wikipedia-intel", country)) {
          const geo = await rateLimitedGeocode(country);
          locationsToStore.push({
            latitude: geo?.latitude || null,
            longitude: geo?.longitude || null,
            location_text: country,
            source_module: "wikipedia-intel",
            source_finding_id: f.id,
            confidence: 0.85,
            location_type: "citizenship",
            raw_data: { field: "citizenship", geocoded: !!geo },
          });
        }
      }

      // Education locations
      for (const school of (s.education || [])) {
        if (!isDupe("wikipedia-intel", school)) {
          const geo = await rateLimitedGeocode(school);
          if (geo) {
            locationsToStore.push({
              latitude: geo.latitude, longitude: geo.longitude,
              location_text: school,
              source_module: "wikipedia-intel",
              source_finding_id: f.id,
              confidence: 0.8,
              location_type: "education",
              raw_data: { field: "education", geocodedDisplay: geo.displayName },
            });
          }
        }
      }

      // Employer locations
      for (const employer of (s.employers || [])) {
        if (!isDupe("wikipedia-intel", employer)) {
          const geo = await rateLimitedGeocode(employer);
          if (geo) {
            locationsToStore.push({
              latitude: geo.latitude, longitude: geo.longitude,
              location_text: employer,
              source_module: "wikipedia-intel",
              source_finding_id: f.id,
              confidence: 0.7,
              location_type: "employer",
              raw_data: { field: "employer", geocodedDisplay: geo.displayName },
            });
          }
        }
      }
    }

    // ── 4. GitHub profile location ──
    for (const f of allFindings.filter(f => f.module === "github-intel" && f.raw_data?.type === "github_profile")) {
      const location = f.raw_data.profile?.location;
      if (location && !isDupe("github-intel", location)) {
        const geo = await rateLimitedGeocode(location);
        locationsToStore.push({
          latitude: geo?.latitude || null,
          longitude: geo?.longitude || null,
          location_text: location,
          source_module: "github-intel",
          source_finding_id: f.id,
          confidence: geo ? 0.8 : 0.4,
          location_type: "profile_declared",
          raw_data: { platform: "github", geocoded: !!geo, geocodedDisplay: geo?.displayName },
        });
      }
    }

    // ── 5. Social media profile locations ──
    const socialModules = [
      "twitter-intel", "mastodon-intel", "telegram-intel",
      "tiktok-intel", "bluesky-intel", "reddit-intel",
    ];
    for (const f of allFindings.filter(f => socialModules.includes(f.module))) {
      const pd = f.raw_data?.profileData || f.raw_data?.profile || {};
      const location = pd.location || pd.country || pd.region;
      if (location && typeof location === "string" && location.length > 1 && !isDupe(f.module, location)) {
        const geo = await rateLimitedGeocode(location);
        if (geo) {
          locationsToStore.push({
            latitude: geo.latitude, longitude: geo.longitude,
            location_text: location,
            source_module: f.module,
            source_finding_id: f.id,
            confidence: 0.7,
            location_type: "profile_declared",
            raw_data: { platform: f.module.replace("-intel", ""), geocodedDisplay: geo.displayName },
          });
        }
      }
    }

    // ── 6. Domain WHOIS locations ──
    for (const f of allFindings.filter(f => f.module === "domain-recon")) {
      const whois = f.raw_data?.whois || {};
      const loc = whois.registrantCountry || whois.registrantState || whois.registrantCity;
      if (loc && !isDupe("domain-recon", loc)) {
        const locText = [whois.registrantCity, whois.registrantState, whois.registrantCountry].filter(Boolean).join(", ");
        const geo = await rateLimitedGeocode(locText);
        if (geo) {
          locationsToStore.push({
            latitude: geo.latitude, longitude: geo.longitude,
            location_text: locText,
            source_module: "domain-recon",
            source_finding_id: f.id,
            confidence: 0.65,
            location_type: "whois_registrant",
            raw_data: { registrant: whois.registrantOrg || whois.registrantName, geocodedDisplay: geo.displayName },
          });
        }
      }
    }

    // ── 7. IP Geolocation ──
    const ips = new Set();
    for (const f of allFindings) {
      // Extract IPs from various modules
      const rawIps = [
        f.raw_data?.ip, f.raw_data?.ipAddress,
        ...(f.raw_data?.ips || []),
        ...(f.raw_data?.resolvedIps || []),
      ].filter(Boolean);
      for (const ip of rawIps) {
        if (typeof ip === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          ips.add(ip);
        }
      }
    }

    let ipCount = 0;
    for (const ip of ips) {
      if (isDupe("ip-geolocation", ip) || ipCount >= 10) continue;
      const geo = await geolocateIp(ip);
      if (geo && geo.latitude && geo.longitude) {
        locationsToStore.push({
          latitude: geo.latitude, longitude: geo.longitude,
          location_text: `${geo.city || ""}, ${geo.region || ""}, ${geo.country || ""} (${ip})`.replace(/^, /, ""),
          source_module: "ip-geolocation",
          source_finding_id: null,
          confidence: 0.5,
          location_type: "ip_geolocation",
          raw_data: { ip, isp: geo.isp, org: geo.org, timezone: geo.timezone },
        });
        ipCount++;
      }
      // ip-api rate limit: small delay between requests
      await new Promise(r => setTimeout(r, 250));
    }

    // ── 8. News article locations ──
    for (const f of allFindings.filter(f => f.module === "news-intel" && f.raw_data?.type === "news_coverage")) {
      // Extract location mentions from article titles
      const articles = f.raw_data.articles || [];
      const mentionedLocations = new Set();

      for (const article of articles.slice(0, 20)) {
        // Simple heuristic: look for known location patterns in titles
        const title = article.title || "";
        // Extract "in [Location]" patterns
        const inMatch = title.match(/\bin\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})/);
        if (inMatch) mentionedLocations.add(inMatch[1]);
      }

      for (const loc of mentionedLocations) {
        if (isDupe("news-intel", loc)) continue;
        const geo = await rateLimitedGeocode(loc);
        // Only keep results that are actual places (not companies/brands/offices)
        const nonPlaceTypes = ["company", "office", "shop", "amenity", "building", "yes"];
        const isPlace = geo && (geo.importance > 0.3) && !nonPlaceTypes.includes(geo.type);
        if (isPlace) { // Only geocode significant places
          locationsToStore.push({
            latitude: geo.latitude, longitude: geo.longitude,
            location_text: loc,
            source_module: "news-intel",
            source_finding_id: f.id,
            confidence: 0.4,
            location_type: "news_mention",
            raw_data: { geocodedDisplay: geo.displayName, importance: geo.importance },
          });
        }
      }
    }

    // ── 9. IPTC location data from EXIF ──
    for (const f of allFindings.filter(f => f.module === "exif-extract" && f.raw_data?.city)) {
      const locText = [f.raw_data.city, f.raw_data.province, f.raw_data.country].filter(Boolean).join(", ");
      if (locText && !isDupe("exif-extract", locText)) {
        const geo = await rateLimitedGeocode(locText);
        locationsToStore.push({
          latitude: geo?.latitude || null,
          longitude: geo?.longitude || null,
          location_text: locText,
          source_module: "exif-extract",
          source_finding_id: f.id,
          confidence: 0.9,
          location_type: "iptc_location",
          raw_data: { geocoded: !!geo },
        });
      }
    }

    // ── 10. Timezone inference from GitHub activity ──
    for (const f of allFindings.filter(f => f.module === "github-intel" && f.raw_data?.type === "github_profile")) {
      const events = f.raw_data.recentActivity || [];
      if (events.length >= 5) {
        const hours = events
          .map(e => e.createdAt ? new Date(e.createdAt).getUTCHours() : null)
          .filter(h => h !== null);

        if (hours.length >= 5) {
          // Find the most active hours — assume peak activity is during work hours (9-17 local)
          const hourCounts = new Array(24).fill(0);
          for (const h of hours) hourCounts[h]++;
          const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

          // If peak is at UTC hour X, and we assume peak local time is ~14:00
          // then timezone offset ≈ 14 - peakHour
          const estimatedOffset = ((14 - peakHour) + 24) % 24;
          const offsetHours = estimatedOffset > 12 ? estimatedOffset - 24 : estimatedOffset;

          // Approximate longitude from timezone: 15° per hour
          const estimatedLongitude = offsetHours * 15;

          locationsToStore.push({
            latitude: null,
            longitude: estimatedLongitude,
            location_text: `Estimated timezone: UTC${offsetHours >= 0 ? "+" : ""}${offsetHours} (from GitHub activity patterns)`,
            source_module: "timezone-inference",
            source_finding_id: f.id,
            confidence: 0.2,
            location_type: "timezone_inferred",
            raw_data: {
              peakUtcHour: peakHour,
              estimatedOffset: offsetHours,
              sampleSize: hours.length,
              hourDistribution: hourCounts,
            },
          });
        }
      }
    }

    // ── Store all locations ──
    let stored = 0;
    for (const loc of locationsToStore) {
      try {
        await db.upsertOsintLocation(profile.id, loc);
        stored++;
      } catch (err) {
        // Skip duplicates silently
        if (!err.message?.includes("duplicate")) {
          console.error(`[geoint] Failed to store location:`, err.message);
        }
      }
    }

    // ── Generate summary finding ──
    if (stored > 0) {
      const exact = locationsToStore.filter(l => l.location_type === "exact_gps").length;
      const geocoded = locationsToStore.filter(l => l.latitude && l.location_type !== "exact_gps" && l.location_type !== "ip_geolocation").length;
      const ipGeo = locationsToStore.filter(l => l.location_type === "ip_geolocation").length;
      const estimated = locationsToStore.filter(l => !l.latitude || l.location_type === "scene_estimated").length;

      // Identify probable home/work from clusters
      const highConf = locationsToStore.filter(l => l.latitude && l.confidence >= 0.7);
      const clusters = clusterLocations(highConf);

      findings.push({
        category: "geoint",
        severity: exact > 0 ? "critical" : geocoded > 0 ? "high" : "medium",
        title: `GEOINT: ${stored} location signals collected — ${exact} exact, ${geocoded} geocoded, ${ipGeo} IP, ${estimated} estimated`,
        description: [
          `Location types: ${locationsToStore.map(l => l.location_type).filter((v, i, a) => a.indexOf(v) === i).join(", ")}`,
          clusters.length > 0 ? `Probable locations: ${clusters.map(c => c.label).join("; ")}` : null,
          exact > 0 ? "WARNING: Exact GPS coordinates found — subject's precise location is exposed" : null,
        ].filter(Boolean).join("\n"),
        rawData: {
          type: "geoint_summary",
          totalLocations: stored,
          exact, geocoded, ipGeo, estimated,
          clusters: clusters.map(c => ({ label: c.label, lat: c.lat, lon: c.lon, count: c.count, confidence: c.confidence })),
          locationTypes: locationsToStore.reduce((acc, l) => { acc[l.location_type] = (acc[l.location_type] || 0) + 1; return acc; }, {}),
        },
      });

      // Individual high-value location findings
      for (const loc of locationsToStore.filter(l => l.confidence >= 0.7 && l.latitude)) {
        findings.push({
          category: "geoint",
          severity: loc.location_type === "exact_gps" ? "critical" : "high",
          title: `GEOINT: ${loc.location_type.replace(/_/g, " ")} — ${loc.location_text}`,
          description: `Coordinates: ${loc.latitude?.toFixed(4)}, ${loc.longitude?.toFixed(4)} | Confidence: ${(loc.confidence * 100).toFixed(0)}% | Source: ${loc.source_module}`,
          rawData: {
            type: "geoint_location",
            latitude: loc.latitude,
            longitude: loc.longitude,
            locationType: loc.location_type,
            confidence: loc.confidence,
          },
        });
      }
    } else {
      findings.push({
        category: "geoint",
        severity: "info",
        title: "GEOINT: no new location signals found",
        rawData: { type: "geoint_empty" },
      });
    }

    return findings;
  },
};

// Simple geographic clustering — group points within ~50km
function clusterLocations(locations) {
  if (!locations.length) return [];

  const clusters = [];
  const used = new Set();

  for (let i = 0; i < locations.length; i++) {
    if (used.has(i) || !locations[i].latitude) continue;

    const cluster = { points: [locations[i]], lat: locations[i].latitude, lon: locations[i].longitude };
    used.add(i);

    for (let j = i + 1; j < locations.length; j++) {
      if (used.has(j) || !locations[j].latitude) continue;
      const dist = haversine(cluster.lat, cluster.lon, locations[j].latitude, locations[j].longitude);
      if (dist < 50) { // 50km threshold
        cluster.points.push(locations[j]);
        used.add(j);
        // Update centroid
        cluster.lat = cluster.points.reduce((s, p) => s + p.latitude, 0) / cluster.points.length;
        cluster.lon = cluster.points.reduce((s, p) => s + p.longitude, 0) / cluster.points.length;
      }
    }

    if (cluster.points.length >= 1) {
      const avgConf = cluster.points.reduce((s, p) => s + p.confidence, 0) / cluster.points.length;
      const bestLabel = cluster.points.sort((a, b) => b.confidence - a.confidence)[0].location_text;
      clusters.push({
        label: bestLabel,
        lat: cluster.lat,
        lon: cluster.lon,
        count: cluster.points.length,
        confidence: Math.min(1, avgConf * (1 + (cluster.points.length - 1) * 0.1)),
      });
    }
  }

  return clusters.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
}

// Haversine distance in km
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
