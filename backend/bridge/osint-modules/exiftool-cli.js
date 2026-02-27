// ExifTool CLI module — comprehensive image/document metadata extraction (400+ formats)
// Falls back to existing exif-extract module if CLI unavailable
// Uses exiftool via docker exec osint-tools
const cliRunner = require("../osint-cli-runner");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

module.exports = {
  name: "exiftool-cli",
  profileTypes: ["image"],

  async scan(profile, rateLimiter) {
    const findings = [];

    const available = await cliRunner.isToolAvailable("exiftool");
    if (!available) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "ExifTool CLI skipped — tool not available",
        description: "ExifTool CLI is not installed. Falling back to JS-based EXIF extraction.",
        rawData: { reason: "tool_unavailable", tool: "exiftool" },
      });
      return findings;
    }

    // Get the image file path — profile value may be a file path or we need to look up osint_images
    let imagePath = profile.value;

    // If the value doesn't look like a path, try to construct one from profile metadata
    if (!imagePath.startsWith("/") && profile.metadata && profile.metadata.file_path) {
      imagePath = profile.metadata.file_path;
    }

    // Check if file exists on the host and copy to shared volume if needed
    const outputId = crypto.randomBytes(4).toString("hex");
    const sharedPath = `/tmp/osint-data/exif-input-${outputId}${path.extname(imagePath) || ".img"}`;

    try {
      // Copy image to shared volume (accessible by both bridge and osint-tools containers)
      if (fs.existsSync(imagePath)) {
        fs.copyFileSync(imagePath, sharedPath);
      } else {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "ExifTool: Image file not accessible",
          description: `Could not access image at ${imagePath}`,
          rawData: { imagePath, reason: "file_not_found" },
        });
        return findings;
      }

      const result = await cliRunner.runTool("exiftool", [
        "-json",
        "-g",      // Group tags by category
        "-n",      // Numeric output (no formatting)
        sharedPath,
      ], { timeout: 30000 });

      // Clean up
      try { fs.unlinkSync(sharedPath); } catch { /* ignore */ }

      if (result.parsed && Array.isArray(result.parsed) && result.parsed.length > 0) {
        const meta = result.parsed[0];

        // Check for GPS data
        const gpsGroups = meta.Composite || meta.EXIF || {};
        const lat = gpsGroups.GPSLatitude || (meta.EXIF && meta.EXIF.GPSLatitude);
        const lng = gpsGroups.GPSLongitude || (meta.EXIF && meta.EXIF.GPSLongitude);

        if (lat && lng) {
          findings.push({
            category: "metadata",
            severity: "critical",
            title: `GPS coordinates found: ${lat.toFixed(6)}, ${lng.toFixed(6)}`,
            description: `Exact GPS location embedded in image metadata. This reveals where the photo was taken.`,
            rawData: { latitude: lat, longitude: lng, source: "exiftool-cli" },
            remediation: "Strip GPS metadata before sharing photos. Most phones have a setting to disable location in photos.",
          });
        }

        // Check for camera/device info
        const exifData = meta.EXIF || {};
        const make = exifData.Make || (meta.IFD0 && meta.IFD0.Make);
        const model = exifData.Model || (meta.IFD0 && meta.IFD0.Model);
        const software = exifData.Software || (meta.IFD0 && meta.IFD0.Software);

        if (make || model) {
          findings.push({
            category: "metadata",
            severity: "medium",
            title: `Camera/Device: ${[make, model].filter(Boolean).join(" ")}`,
            description: `Make: ${make || "N/A"}\nModel: ${model || "N/A"}\nSoftware: ${software || "N/A"}`,
            rawData: { make, model, software, source: "exiftool-cli" },
            remediation: "Device information can be used to identify the owner. Strip EXIF data before sharing.",
          });
        }

        // Check for author/creator info
        const iptc = meta.IPTC || {};
        const xmp = meta.XMP || {};
        const author = xmp.Creator || xmp.Author || iptc["By-line"] || exifData.Artist;
        const copyright = xmp.Rights || iptc.CopyrightNotice || exifData.Copyright;

        if (author || copyright) {
          findings.push({
            category: "metadata",
            severity: "high",
            title: `Author/Creator: ${author || copyright}`,
            description: `Author: ${author || "N/A"}\nCopyright: ${copyright || "N/A"}`,
            rawData: { author, copyright, source: "exiftool-cli" },
            remediation: "Author metadata reveals identity. Remove before sharing images publicly.",
          });
        }

        // Check for timestamps
        const dateOriginal = exifData.DateTimeOriginal || exifData.CreateDate;
        if (dateOriginal) {
          findings.push({
            category: "metadata",
            severity: "low",
            title: `Photo timestamp: ${dateOriginal}`,
            description: `Original date/time recorded in metadata.`,
            rawData: { dateOriginal, source: "exiftool-cli" },
          });
        }

        // Summary of all metadata groups found
        const groups = Object.keys(meta).filter((k) => typeof meta[k] === "object");
        const totalTags = groups.reduce((sum, g) => sum + Object.keys(meta[g]).length, 0);

        findings.push({
          category: "metadata",
          severity: "info",
          title: `ExifTool: ${totalTags} metadata tags across ${groups.length} groups`,
          description: `Groups: ${groups.join(", ")}`,
          rawData: { groups, totalTags, fullMetadata: meta },
        });
      }
    } catch (err) {
      // Clean up on error
      try { fs.unlinkSync(sharedPath); } catch { /* ignore */ }

      findings.push({
        category: "metadata",
        severity: "info",
        title: `ExifTool scan error: ${err.message}`,
        description: `Failed to extract metadata from image.`,
        rawData: { error: err.message, tool: "exiftool" },
      });
    }

    return findings;
  },
};
