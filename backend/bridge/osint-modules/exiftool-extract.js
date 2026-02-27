// ExifTool comprehensive metadata extraction — 400+ file formats
// Wraps: exiftool (Phil Harvey's Perl tool, the gold standard)
const cli = require("./cli-runner");
const db = require("../db");
const fs = require("fs");

module.exports = {
  name: "exiftool-extract",
  profileTypes: ["image"],

  async scan(profile, rateLimiter) {
    const findings = [];

    if (!cli.binaryExists("exiftool")) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "ExifTool unavailable — not installed",
        rawData: { reason: "no_exiftool" },
      });
      return findings;
    }

    const image = await db.getOsintImageByProfile(profile.id);
    if (!image || !fs.existsSync(image.file_path)) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "No image file for ExifTool analysis",
        rawData: { reason: "no_image_file" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      // ExifTool with grouped JSON output — much more thorough than exifr
      const stdout = await cli.run("exiftool", ["-json", "-g", "-n", image.file_path], {
        timeout: 15000,
      });

      let metadata;
      try { metadata = JSON.parse(stdout); } catch { metadata = null; }
      if (!metadata || !metadata[0]) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "ExifTool: no metadata extracted",
          rawData: { source: "exiftool" },
        });
        return findings;
      }

      const data = metadata[0];
      const groups = Object.keys(data).filter((k) => typeof data[k] === "object");

      // GPS coordinates (numeric with -n flag)
      const gps = data.Composite || data.EXIF || {};
      const lat = gps.GPSLatitude ?? data.EXIF?.GPSLatitude;
      const lon = gps.GPSLongitude ?? data.EXIF?.GPSLongitude;
      if (lat != null && lon != null && lat !== 0 && lon !== 0) {
        findings.push({
          category: "exposure",
          severity: "critical",
          title: "ExifTool: GPS coordinates in metadata",
          description: `Location: ${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`,
          rawData: { latitude: lat, longitude: lon, gps: true, source: "exiftool" },
          remediation: "Strip EXIF GPS data before sharing photos.",
        });
      }

      // Camera serial number
      const exif = data.EXIF || {};
      const serial = exif.SerialNumber || exif.BodySerialNumber || exif.InternalSerialNumber;
      if (serial) {
        findings.push({
          category: "exposure",
          severity: "high",
          title: "ExifTool: camera serial number found",
          description: `Serial: ${serial}`,
          rawData: { serialNumber: String(serial), source: "exiftool" },
          remediation: "Camera serial numbers uniquely identify your device across all photos.",
        });
      }

      // Author/artist/copyright
      const author = exif.Artist || data.IPTC?.["By-line"] || data.XMP?.Creator;
      const copyright = exif.Copyright || data.IPTC?.CopyrightNotice || data.XMP?.Rights;
      if (author || copyright) {
        findings.push({
          category: "exposure",
          severity: "high",
          title: "ExifTool: author/copyright info found",
          description: [
            author ? `Author: ${author}` : null,
            copyright ? `Copyright: ${copyright}` : null,
          ].filter(Boolean).join("\n"),
          rawData: { author, copyright, source: "exiftool" },
          remediation: "Author metadata may reveal your real name.",
        });
      }

      // Camera make/model/lens
      if (exif.Make || exif.Model) {
        findings.push({
          category: "metadata",
          severity: "medium",
          title: `ExifTool: ${exif.Make || ""} ${exif.Model || ""}`.trim(),
          description: [
            exif.Make ? `Make: ${exif.Make}` : null,
            exif.Model ? `Model: ${exif.Model}` : null,
            exif.LensModel ? `Lens: ${exif.LensModel}` : null,
            exif.Software ? `Software: ${exif.Software}` : null,
          ].filter(Boolean).join("\n"),
          rawData: { make: exif.Make, model: exif.Model, lens: exif.LensModel, software: exif.Software, source: "exiftool" },
        });
      }

      // XMP/IPTC keywords
      const keywords = data.IPTC?.Keywords || data.XMP?.Subject;
      if (keywords) {
        const kwList = Array.isArray(keywords) ? keywords : [keywords];
        findings.push({
          category: "metadata",
          severity: "low",
          title: `ExifTool: ${kwList.length} keyword(s) found`,
          description: kwList.join(", "),
          rawData: { keywords: kwList, source: "exiftool" },
        });
      }

      // Thumbnail presence (can leak data even after EXIF strip)
      if (data.EXIF?.ThumbnailImage || data.EXIF?.ThumbnailLength) {
        findings.push({
          category: "metadata",
          severity: "low",
          title: "ExifTool: embedded thumbnail detected",
          description: "Embedded thumbnails may preserve original framing even if the image was cropped.",
          rawData: { hasThumbnail: true, source: "exiftool" },
        });
      }

      // ICC profile (can identify software/monitor)
      if (data.ICC_Profile) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: `ExifTool: ICC color profile — ${data.ICC_Profile.ProfileDescription || "unknown"}`,
          rawData: { iccProfile: data.ICC_Profile.ProfileDescription, source: "exiftool" },
        });
      }

      // Summary
      const totalFields = groups.reduce((sum, g) => sum + Object.keys(data[g]).length, 0);
      findings.push({
        category: "metadata",
        severity: "info",
        title: `ExifTool: ${totalFields} fields across ${groups.length} groups`,
        description: `Groups: ${groups.join(", ")}`,
        rawData: { totalFields, groups, source: "exiftool", fullData: data },
      });
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "ExifTool extraction error",
        description: err.message,
        rawData: { error: err.message, source: "exiftool" },
      });
    } finally {
      release();
    }

    return findings;
  },
};
