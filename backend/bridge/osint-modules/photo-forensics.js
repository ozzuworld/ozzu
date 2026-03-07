// Photo Forensics Module — shadow analysis, weather correlation, GeoGuessr heuristics
// Extracts geolocation signals from photo metadata + visual analysis data
const db = require("../db");

// SunCalc-style solar position calculator (no external deps)
function solarPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
  const declination = -23.45 * Math.cos(rad * (360 / 365) * (dayOfYear + 10));
  const timeOffset = lon / 15; // hours from UTC
  const solarHour = date.getUTCHours() + date.getUTCMinutes() / 60 + timeOffset;
  const hourAngle = (solarHour - 12) * 15;
  const altSin = Math.sin(lat * rad) * Math.sin(declination * rad) +
    Math.cos(lat * rad) * Math.cos(declination * rad) * Math.cos(hourAngle * rad);
  const altitude = Math.asin(altSin) / rad;
  const azCos = (Math.sin(declination * rad) - Math.sin(lat * rad) * altSin) /
    (Math.cos(lat * rad) * Math.cos(Math.asin(altSin)));
  let azimuth = Math.acos(Math.max(-1, Math.min(1, azCos))) / rad;
  if (hourAngle > 0) azimuth = 360 - azimuth;
  return { altitude, azimuth };
}

// Estimate latitude from shadow length ratio + date/time
// shadowRatio = object_height / shadow_length = tan(solar_altitude)
function estimateLatFromShadow(shadowRatio, date, utcHour) {
  if (!shadowRatio || !date) return null;
  const solarAltitude = Math.atan(shadowRatio) * (180 / Math.PI);
  // Search latitudes to find where solar altitude matches
  let bestLat = null;
  let bestDiff = Infinity;
  for (let lat = -60; lat <= 60; lat += 0.5) {
    for (let lon = -180; lon <= 180; lon += 15) {
      const testDate = new Date(date);
      testDate.setUTCHours(utcHour);
      const pos = solarPosition(testDate, lat, lon);
      const diff = Math.abs(pos.altitude - solarAltitude);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestLat = lat;
      }
    }
  }
  return bestDiff < 5 ? { latitude: bestLat, confidence: Math.max(0.1, 0.5 - bestDiff * 0.08) } : null;
}

// Weather correlation — check if scene clues match historical weather
// Uses Open-Meteo archive API (free, no key needed)
async function correlateWeather(lat, lon, date) {
  if (!lat || !lon || !date) return null;
  const dateStr = date.toISOString().split("T")[0];
  try {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${dateStr}&end_date=${dateStr}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=auto`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.daily?.time?.length) return null;
    return {
      date: data.daily.time[0],
      tempMax: data.daily.temperature_2m_max[0],
      tempMin: data.daily.temperature_2m_min[0],
      precipitation: data.daily.precipitation_sum[0],
      weatherCode: data.daily.weathercode[0],
      timezone: data.timezone,
    };
  } catch {
    return null;
  }
}

// WMO weather code to description
function weatherCodeToDesc(code) {
  const codes = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "rime fog", 51: "light drizzle", 53: "moderate drizzle",
    55: "dense drizzle", 61: "slight rain", 63: "moderate rain", 65: "heavy rain",
    71: "slight snow", 73: "moderate snow", 75: "heavy snow", 77: "snow grains",
    80: "slight rain showers", 81: "moderate rain showers", 82: "violent rain showers",
    85: "slight snow showers", 86: "heavy snow showers", 95: "thunderstorm",
    96: "thunderstorm with slight hail", 99: "thunderstorm with heavy hail",
  };
  return codes[code] || `weather code ${code}`;
}

// GeoGuessr-style heuristic scoring from scene analysis data
function applyGeoGuessrHeuristics(sceneData) {
  const signals = [];

  if (!sceneData) return signals;

  const loc = sceneData.location || {};
  const tech = sceneData.technology || {};
  const text = sceneData.text_ocr || {};
  const ctx = sceneData.context || {};

  // Driving side detection from vehicles
  if (tech.vehicles?.length) {
    const vehicleStr = tech.vehicles.join(" ").toLowerCase();
    if (/right.hand.drive|rhd|japanese|toyota|suzuki.*kei/i.test(vehicleStr)) {
      signals.push({ signal: "right-hand-drive vehicles", regions: ["Japan", "UK", "Australia", "India", "Thailand"], confidence: 0.4 });
    }
  }

  // Language detection from text/signs
  const allText = [...(text.signs || []), ...(text.other || []), ...(text.documents || [])].join(" ");
  if (allText.length > 0) {
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(allText)) signals.push({ signal: "Japanese text detected", regions: ["Japan"], confidence: 0.85 });
    if (/[\u4E00-\u9FFF]/.test(allText) && !/[\u3040-\u309F]/.test(allText)) signals.push({ signal: "Chinese text detected", regions: ["China", "Taiwan", "Singapore"], confidence: 0.7 });
    if (/[\uAC00-\uD7AF]/.test(allText)) signals.push({ signal: "Korean text detected", regions: ["South Korea", "North Korea"], confidence: 0.85 });
    if (/[\u0E00-\u0E7F]/.test(allText)) signals.push({ signal: "Thai text detected", regions: ["Thailand"], confidence: 0.9 });
    if (/[\u0600-\u06FF]/.test(allText)) signals.push({ signal: "Arabic text detected", regions: ["Middle East", "North Africa"], confidence: 0.6 });
    if (/[\u0400-\u04FF]/.test(allText)) signals.push({ signal: "Cyrillic text detected", regions: ["Russia", "Ukraine", "Bulgaria", "Serbia"], confidence: 0.5 });
    if (/[\u0900-\u097F]/.test(allText)) signals.push({ signal: "Devanagari text detected", regions: ["India", "Nepal"], confidence: 0.75 });
  }

  // License plate patterns
  const plates = tech.license_plates || [];
  for (const plate of plates) {
    if (/^[A-Z]{2}\s?\d{2}\s?[A-Z]{1,3}\s?\d{4}$/.test(plate)) signals.push({ signal: `Indian-format plate: ${plate}`, regions: ["India"], confidence: 0.8 });
    if (/^\d{1,4}\s?[あ-ん]\s?\d{2}-?\d{2}$/.test(plate)) signals.push({ signal: `Japanese plate format`, regions: ["Japan"], confidence: 0.9 });
    if (/^[A-Z]{1,3}-[A-Z]{1,2}\s?\d{1,4}$/.test(plate)) signals.push({ signal: `European-format plate: ${plate}`, regions: ["Europe"], confidence: 0.6 });
    if (/^\d[A-Z]{3}\d{3}$/.test(plate)) signals.push({ signal: `US-format plate: ${plate}`, regions: ["United States"], confidence: 0.5 });
  }

  // Vegetation / climate clues
  const envStr = `${loc.environment || ""} ${loc.climate_clues || ""} ${(loc.indicators || []).join(" ")}`.toLowerCase();
  if (/palm tree|tropical|monsoon/.test(envStr)) signals.push({ signal: "tropical vegetation", regions: ["Southeast Asia", "Central America", "Pacific Islands", "Sub-Saharan Africa"], confidence: 0.25 });
  if (/snow|alpine|subarctic|tundra/.test(envStr)) signals.push({ signal: "cold/alpine environment", regions: ["Northern Europe", "Canada", "Russia", "Scandinavia"], confidence: 0.2 });
  if (/desert|arid|sand dune/.test(envStr)) signals.push({ signal: "arid/desert environment", regions: ["Middle East", "North Africa", "Southwestern US", "Australia"], confidence: 0.2 });

  // Architecture style
  if (/colonial|victorian/.test(envStr)) signals.push({ signal: "colonial architecture", regions: ["UK", "India", "Australia", "Southeast Asia", "Americas"], confidence: 0.15 });
  if (/pagoda|temple|shinto/.test(envStr)) signals.push({ signal: "East Asian architecture", regions: ["Japan", "China", "South Korea", "Thailand"], confidence: 0.4 });
  if (/mosque|minaret/.test(envStr)) signals.push({ signal: "Islamic architecture", regions: ["Middle East", "North Africa", "South Asia", "Turkey"], confidence: 0.4 });

  // Road/infrastructure clues
  if (/bollard|roundabout|zebra crossing/.test(envStr)) signals.push({ signal: "UK/European road features", regions: ["UK", "Europe", "Commonwealth"], confidence: 0.3 });

  // Power line / utility pole style
  if (/wooden.*pole|power line/.test(envStr)) signals.push({ signal: "utility pole style noted", regions: [], confidence: 0.1 });

  return signals;
}

module.exports = {
  name: "photo-forensics",
  profileTypes: ["image"],

  async scan(profile, rateLimiter, { db: dbRef }) {
    const findings = [];

    // Get all existing findings for this profile to analyze
    const allFindings = await db.getOsintFindings({ profileId: profile.id, limit: 500 });

    // ── 1. EXIF temporal analysis ──
    const exifFindings = allFindings.filter(f => f.module === "exif-extract" || f.module === "exiftool-cli");
    let photoDate = null;
    let cameraInfo = null;

    for (const f of exifFindings) {
      const raw = f.raw_data || {};
      // Extract date
      const dateStr = raw.dateTime || raw.dateOriginal || raw.createDate ||
        raw.fullMetadata?.EXIF?.DateTimeOriginal || raw.fullMetadata?.EXIF?.CreateDate;
      if (dateStr && !photoDate) {
        try {
          photoDate = new Date(dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"));
          if (isNaN(photoDate.getTime())) photoDate = null;
        } catch { /* skip */ }
      }

      // Camera info
      const make = raw.cameraMake || raw.fullMetadata?.EXIF?.Make;
      const model = raw.cameraModel || raw.fullMetadata?.EXIF?.Model;
      const serial = raw.cameraSerial || raw.fullMetadata?.EXIF?.SerialNumber;
      if (make || model) {
        cameraInfo = { make, model, serial, lens: raw.lensModel || raw.fullMetadata?.EXIF?.LensModel };
      }

      // Focal length + sensor size → estimate distance to subject
      const focalLength = raw.focalLength || raw.fullMetadata?.EXIF?.FocalLength;
      const focalLength35 = raw.focalLengthIn35mm || raw.fullMetadata?.EXIF?.FocalLengthIn35mmFormat;
      if (focalLength && focalLength35) {
        const cropFactor = focalLength35 / focalLength;
        findings.push({
          category: "geoint",
          severity: "low",
          title: `Photo forensics: camera sensor crop factor ${cropFactor.toFixed(2)}x`,
          description: `Focal length: ${focalLength}mm (${focalLength35}mm equiv). Crop factor ${cropFactor.toFixed(2)}x suggests ${cropFactor > 1.4 ? "APS-C/phone" : cropFactor > 1.1 ? "APS-C" : "full-frame"} sensor.`,
          rawData: { type: "camera_forensics", focalLength, focalLength35, cropFactor },
        });
      }
    }

    // ── 2. Shadow analysis (if we have GPS + timestamp) ──
    const gpsFindings = allFindings.filter(f =>
      f.raw_data?.gps || (f.raw_data?.latitude && f.raw_data?.longitude)
    );

    if (photoDate && gpsFindings.length > 0) {
      const gps = gpsFindings[0].raw_data;
      const lat = gps.latitude;
      const lon = gps.longitude;
      if (lat && lon) {
        const sunPos = solarPosition(photoDate, lat, lon);
        findings.push({
          category: "geoint",
          severity: "medium",
          title: `Shadow analysis: sun at ${sunPos.altitude.toFixed(1)} altitude, ${sunPos.azimuth.toFixed(1)} azimuth`,
          description: `At ${photoDate.toISOString()} at [${lat.toFixed(4)}, ${lon.toFixed(4)}], solar altitude was ${sunPos.altitude.toFixed(1)}. ` +
            `Shadow direction: ${sunPos.azimuth > 180 ? "east" : "west"} of north. ` +
            `${sunPos.altitude < 0 ? "Sun was below horizon — photo timestamp may be incorrect." : `Shadow length ratio: ${(1 / Math.tan(sunPos.altitude * Math.PI / 180)).toFixed(2)}x object height.`}`,
          rawData: {
            type: "shadow_analysis",
            solarAltitude: sunPos.altitude,
            solarAzimuth: sunPos.azimuth,
            shadowDirection: sunPos.azimuth > 180 ? "east" : "west",
            photoDate: photoDate.toISOString(),
            coordinates: { lat, lon },
          },
        });

        // ── 3. Weather correlation ──
        const weather = await correlateWeather(lat, lon, photoDate);
        if (weather) {
          findings.push({
            category: "geoint",
            severity: "low",
            title: `Weather correlation: ${weatherCodeToDesc(weather.weatherCode)} on ${weather.date}`,
            description: `Historical weather at [${lat.toFixed(2)}, ${lon.toFixed(2)}] on ${weather.date}: ` +
              `${weatherCodeToDesc(weather.weatherCode)}, temp ${weather.tempMin}-${weather.tempMax}C, ` +
              `precip ${weather.precipitation}mm. Cross-reference with visible weather in photo.`,
            rawData: {
              type: "weather_correlation",
              weather,
              coordinates: { lat, lon },
              photoDate: photoDate.toISOString(),
            },
          });
        }
      }
    } else if (photoDate && gpsFindings.length === 0) {
      // No GPS but have date — note this for potential shadow-based geolocation
      findings.push({
        category: "geoint",
        severity: "info",
        title: "Photo forensics: timestamp available but no GPS — shadow geolocation possible with shadow measurements",
        description: `Photo dated ${photoDate.toISOString()}. If shadow angles can be measured from the image, latitude can be estimated.`,
        rawData: { type: "shadow_potential", photoDate: photoDate.toISOString() },
      });
    }

    // ── 4. Camera fingerprinting ──
    if (cameraInfo) {
      const desc = [
        cameraInfo.make && `Make: ${cameraInfo.make}`,
        cameraInfo.model && `Model: ${cameraInfo.model}`,
        cameraInfo.serial && `Serial: ${cameraInfo.serial}`,
        cameraInfo.lens && `Lens: ${cameraInfo.lens}`,
      ].filter(Boolean).join(" | ");

      findings.push({
        category: "geoint",
        severity: cameraInfo.serial ? "high" : "medium",
        title: `Camera fingerprint: ${cameraInfo.make || "Unknown"} ${cameraInfo.model || "Unknown"}${cameraInfo.serial ? " (S/N: " + cameraInfo.serial + ")" : ""}`,
        description: `${desc}. ${cameraInfo.serial ? "Serial number can link this camera to other photos across the internet." : "No serial number — limited camera fingerprinting."}`,
        rawData: { type: "camera_fingerprint", ...cameraInfo },
      });
    }

    // ── 5. GeoGuessr heuristics from scene analysis ──
    const sceneFindings = allFindings.filter(f => f.module === "scene-analysis" && f.raw_data?.analysis);
    for (const f of sceneFindings) {
      const heuristics = applyGeoGuessrHeuristics(f.raw_data.analysis);
      if (heuristics.length > 0) {
        findings.push({
          category: "geoint",
          severity: "medium",
          title: `GeoGuessr heuristics: ${heuristics.length} location signals from visual analysis`,
          description: heuristics.map(h => `${h.signal} -> ${h.regions.join(", ") || "unknown region"} (${(h.confidence * 100).toFixed(0)}%)`).join("\n"),
          rawData: {
            type: "geoguessr_heuristics",
            signals: heuristics,
            aggregatedRegions: aggregateRegions(heuristics),
          },
        });

        // Store high-confidence heuristic regions as locations
        const aggregated = aggregateRegions(heuristics);
        for (const region of aggregated.filter(r => r.score >= 0.4)) {
          try {
            // Rate-limited geocode
            await new Promise(r => setTimeout(r, 1100));
            const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(region.region)}&format=json&limit=1`;
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
                  location_text: `Visual heuristic: ${region.region}`,
                  source_module: "photo-forensics",
                  source_finding_id: f.id,
                  confidence: Math.min(0.6, region.score),
                  location_type: "visual_heuristic",
                  raw_data: { signals: region.signals, score: region.score },
                });
              }
            }
          } catch { /* skip geocoding failures */ }
        }
      }
    }

    // ── 6. Image steganography check (basic) ──
    const image = await db.getOsintImageByProfile(profile.id);
    if (image) {
      const fs = require("fs");
      if (fs.existsSync(image.file_path)) {
        try {
          const buf = fs.readFileSync(image.file_path);
          // Check for appended data after JPEG EOI marker (FF D9)
          if (image.mime_type?.includes("jpeg") || image.file_path.endsWith(".jpg") || image.file_path.endsWith(".jpeg")) {
            const eoiIdx = buf.lastIndexOf(Buffer.from([0xFF, 0xD9]));
            if (eoiIdx > 0 && eoiIdx < buf.length - 2) {
              const trailingBytes = buf.length - eoiIdx - 2;
              if (trailingBytes > 10) {
                findings.push({
                  category: "geoint",
                  severity: "high",
                  title: `Steganography alert: ${trailingBytes} bytes appended after JPEG end-of-image`,
                  description: `The JPEG EOI marker is at byte ${eoiIdx}, but the file continues for ${trailingBytes} more bytes. This could indicate hidden/appended data (steganography), a bundled file, or corrupt metadata.`,
                  rawData: { type: "stego_check", eoiOffset: eoiIdx, trailingBytes, fileSize: buf.length },
                });
              }
            }
          }

          // Check for embedded ZIP (PK header after image data)
          const pkIdx = buf.indexOf(Buffer.from([0x50, 0x4B, 0x03, 0x04]), 100); // skip first 100 bytes
          if (pkIdx > 0) {
            findings.push({
              category: "geoint",
              severity: "high",
              title: `Steganography alert: embedded ZIP archive detected at byte ${pkIdx}`,
              description: `A ZIP file signature (PK) was found embedded in the image at offset ${pkIdx}. This is a common steganography technique for hiding files inside images.`,
              rawData: { type: "stego_zip", zipOffset: pkIdx, fileSize: buf.length },
            });
          }
        } catch { /* skip file read errors */ }
      }
    }

    if (findings.length === 0) {
      findings.push({
        category: "geoint",
        severity: "info",
        title: "Photo forensics: no additional signals extracted",
        rawData: { type: "forensics_empty" },
      });
    }

    return findings;
  },
};

// Aggregate region mentions across heuristics, score by frequency + confidence
function aggregateRegions(heuristics) {
  const regionScores = {};
  for (const h of heuristics) {
    for (const region of h.regions) {
      if (!regionScores[region]) regionScores[region] = { region, score: 0, signals: [] };
      regionScores[region].score += h.confidence;
      regionScores[region].signals.push(h.signal);
    }
  }
  return Object.values(regionScores).sort((a, b) => b.score - a.score);
}
