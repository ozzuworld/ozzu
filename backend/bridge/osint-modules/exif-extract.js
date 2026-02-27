// EXIF/IPTC/XMP metadata extraction for uploaded images
// Reads local image file, extracts GPS, camera info, author, dates
const db = require("../db");
const fs = require("fs");
let exifr;
try { exifr = require("exifr"); } catch { exifr = null; }

module.exports = {
  name: "exif-extract",
  profileTypes: ["image"],

  async scan(profile, rateLimiter) {
    const findings = [];

    if (!exifr) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "EXIF extraction unavailable — exifr package not installed",
        description: "Install exifr for metadata extraction: npm install exifr",
        rawData: { reason: "no_exifr" },
      });
      return findings;
    }

    // Get image file path from osint_images
    const image = await db.getOsintImageByProfile(profile.id);
    if (!image || !fs.existsSync(image.file_path)) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "No image file found for this profile",
        description: "Upload an image first, then scan.",
        rawData: { reason: "no_image_file" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      const buffer = fs.readFileSync(image.file_path);

      const exif = await exifr.parse(buffer, {
        gps: true, exif: true, iptc: true, xmp: true, icc: false,
        translateValues: true, reviveValues: true,
      }).catch(() => null);

      if (!exif) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "No EXIF metadata found in image",
          description: "This image has been stripped of metadata or was created without it.",
          rawData: { fileHash: image.file_hash, fileSize: image.file_size },
        });
        return findings;
      }

      // GPS coordinates — critical location leak
      if (exif.latitude && exif.longitude) {
        findings.push({
          category: "exposure",
          severity: "critical",
          title: "GPS coordinates found in image EXIF",
          description: `Location: ${exif.latitude.toFixed(6)}, ${exif.longitude.toFixed(6)}${exif.GPSAltitude ? `\nAltitude: ${exif.GPSAltitude.toFixed(1)}m` : ""}\nThis reveals the exact location where the photo was taken.`,
          rawData: {
            latitude: exif.latitude, longitude: exif.longitude,
            altitude: exif.GPSAltitude || null, gps: true,
            fileHash: image.file_hash,
          },
          remediation: "Strip EXIF metadata before sharing photos. Most social platforms auto-strip, but messaging apps and forums may not.",
        });
      }

      // Camera serial number — device fingerprint (high severity)
      const serial = exif.SerialNumber || exif.BodySerialNumber || exif.InternalSerialNumber;
      if (serial) {
        findings.push({
          category: "exposure",
          severity: "high",
          title: "Camera serial number in image metadata",
          description: `Serial: ${serial}\nThis uniquely identifies the camera/device used. Can be correlated across all photos taken with this device.`,
          rawData: { serialNumber: serial, fileHash: image.file_hash },
          remediation: "Camera serial numbers can link photos across platforms. Strip metadata before uploading.",
        });
      }

      // Author/copyright — real name leak (high severity)
      const author = exif.Artist || exif.Copyright || exif.Creator ||
        (exif.XPAuthor ? String(exif.XPAuthor) : null) ||
        exif["By-line"] || exif["By-lineTitle"];
      if (author) {
        findings.push({
          category: "exposure",
          severity: "high",
          title: "Author/copyright info in image metadata",
          description: `Author: ${author}${exif.Copyright ? `\nCopyright: ${exif.Copyright}` : ""}\nThis may reveal the photographer's real name.`,
          rawData: { author, copyright: exif.Copyright, fileHash: image.file_hash },
          remediation: "Remove author metadata from photos to prevent real name exposure.",
        });
      }

      // Camera make/model — device fingerprint (medium)
      if (exif.Make || exif.Model) {
        findings.push({
          category: "metadata",
          severity: "medium",
          title: "Camera/device info in image metadata",
          description: `Make: ${exif.Make || "N/A"}\nModel: ${exif.Model || "N/A"}${exif.LensModel ? `\nLens: ${exif.LensModel}` : ""}${exif.Software ? `\nSoftware: ${exif.Software}` : ""}`,
          rawData: {
            make: exif.Make, model: exif.Model, software: exif.Software,
            lensModel: exif.LensModel, fileHash: image.file_hash,
          },
          remediation: "Camera model and lens info can identify the device used across photos.",
        });
      }

      // IPTC location data
      const iptcLocation = [exif.City, exif["Province-State"], exif["Country-PrimaryLocationName"]].filter(Boolean);
      if (iptcLocation.length > 0) {
        findings.push({
          category: "exposure",
          severity: "high",
          title: "IPTC location data in image metadata",
          description: `Location: ${iptcLocation.join(", ")}`,
          rawData: {
            city: exif.City, province: exif["Province-State"],
            country: exif["Country-PrimaryLocationName"], fileHash: image.file_hash,
          },
          remediation: "IPTC location tags reveal where the photo was taken or categorized.",
        });
      }

      // IPTC keywords/tags
      const keywords = exif.Keywords || exif["2:025"];
      if (keywords) {
        const kwList = Array.isArray(keywords) ? keywords : [keywords];
        findings.push({
          category: "metadata",
          severity: "low",
          title: `${kwList.length} IPTC keyword(s) in image metadata`,
          description: kwList.join(", "),
          rawData: { keywords: kwList, fileHash: image.file_hash },
        });
      }

      // Creation date
      if (exif.DateTimeOriginal || exif.CreateDate) {
        const date = exif.DateTimeOriginal || exif.CreateDate;
        findings.push({
          category: "metadata",
          severity: "low",
          title: "Creation date in image metadata",
          description: `Date: ${date}${exif.OffsetTimeOriginal ? ` (${exif.OffsetTimeOriginal})` : ""}`,
          rawData: { dateTimeOriginal: String(date), timezone: exif.OffsetTimeOriginal, fileHash: image.file_hash },
        });
      }

      // XMP creator tool
      if (exif.CreatorTool || exif.HistorySoftwareAgent) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "Software/creator tool in image metadata",
          description: `Tool: ${exif.CreatorTool || exif.HistorySoftwareAgent}`,
          rawData: { creatorTool: exif.CreatorTool, historySoftwareAgent: exif.HistorySoftwareAgent, fileHash: image.file_hash },
        });
      }

      // XMP document ID (can link edits of same document)
      if (exif.DocumentID || exif.OriginalDocumentID) {
        findings.push({
          category: "metadata",
          severity: "low",
          title: "Document ID in image metadata",
          description: `Document ID: ${exif.DocumentID || ""}\n${exif.OriginalDocumentID ? `Original: ${exif.OriginalDocumentID}` : ""}`.trim(),
          rawData: { documentId: exif.DocumentID, originalDocumentId: exif.OriginalDocumentID, fileHash: image.file_hash },
        });
      }

      // Summary finding
      const fields = Object.keys(exif).length;
      findings.push({
        category: "metadata",
        severity: "info",
        title: `${fields} EXIF/IPTC/XMP fields extracted from image`,
        description: `Dimensions: ${image.width}x${image.height}\nFormat: ${image.mime_type}\nSize: ${(image.file_size / 1024).toFixed(1)}KB`,
        rawData: { totalFields: fields, width: image.width, height: image.height, fileHash: image.file_hash },
      });
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "EXIF extraction error",
        description: err.message,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};
