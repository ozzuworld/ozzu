// Document discovery + metadata extraction module
// Google CSE for PDFs/docs containing the target value, download + extract author/GPS/dates

module.exports = {
  name: "document-meta",
  profileTypes: ["email", "username"],

  async scan(profile, rateLimiter) {
    const value = profile.value;
    const findings = [];

    const googleApiKey = process.env.GOOGLE_API_KEY;
    const googleCseId = process.env.GOOGLE_CSE_ID;

    if (!googleApiKey || !googleCseId) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Document search skipped — no Google CSE API key",
        description: `Set GOOGLE_API_KEY and GOOGLE_CSE_ID for automated document discovery. Manual query: filetype:pdf OR filetype:docx "${value}"`,
        rawData: { reason: "no_google_api_key", manualQuery: `filetype:pdf OR filetype:docx "${value}"` },
        remediation: "Set GOOGLE_API_KEY and GOOGLE_CSE_ID environment variables (100 free queries/day).",
      });
      return findings;
    }

    // 1. Search for PDFs containing the value
    const queries = [
      { query: `filetype:pdf "${value}"`, type: "PDF" },
      { query: `filetype:docx "${value}"`, type: "DOCX" },
    ];

    const discoveredDocs = [];

    for (const q of queries) {
      const release = await rateLimiter.acquire();
      try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCseId}&q=${encodeURIComponent(q.query)}&num=5`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

        if (res.ok) {
          const data = await res.json();
          const totalResults = parseInt(data.searchInformation?.totalResults || "0", 10);

          if (totalResults > 0 && data.items) {
            for (const item of data.items.slice(0, 3)) {
              discoveredDocs.push({
                title: item.title,
                link: item.link,
                snippet: item.snippet,
                type: q.type,
              });
            }
          }
        }
      } catch (_) {
        // Skip on error
      } finally {
        release();
      }
    }

    if (discoveredDocs.length > 0) {
      findings.push({
        category: "exposure",
        severity: "high",
        title: `${discoveredDocs.length} document(s) found containing "${value}"`,
        description: discoveredDocs.map((d) =>
          `[${d.type}] ${d.title}\n  ${d.link}${d.snippet ? `\n  ${d.snippet.substring(0, 100)}...` : ""}`
        ).join("\n\n"),
        rawData: { documents: discoveredDocs, query: value },
        remediation: "Request removal of documents exposing your personal information. Use Google's removal tool for cached results. Contact site owners for original files.",
      });
    }

    // 2. Attempt to download + extract metadata from discovered docs (limit: 3 docs, max 10MB)
    let exifr;
    try {
      exifr = require("exifr");
    } catch (_) {
      // exifr not installed — skip metadata extraction
      if (discoveredDocs.length > 0) {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "Document metadata extraction unavailable",
          description: "Install the 'exifr' package for automated PDF/image metadata extraction (author, GPS, creation dates).",
          rawData: { reason: "exifr_not_installed" },
        });
      }
      if (findings.length === 0) {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "No documents found",
          description: `No public PDFs or documents containing "${value}" were found in Google search results.`,
          rawData: { value, found: false },
        });
      }
      return findings;
    }

    for (const doc of discoveredDocs.slice(0, 3)) {
      if (!doc.link.match(/\.(pdf|jpg|jpeg|png|gif|tiff?)$/i)) continue;

      const release = await rateLimiter.acquire();
      try {
        // HEAD check for file size
        const headRes = await fetch(doc.link, {
          method: "HEAD",
          signal: AbortSignal.timeout(5000),
        });

        const contentLength = parseInt(headRes.headers.get("content-length") || "0", 10);
        if (contentLength > 10 * 1024 * 1024) continue; // Skip files > 10MB

        // Download the file
        const fileRes = await fetch(doc.link, {
          signal: AbortSignal.timeout(30000),
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        });

        if (fileRes.ok) {
          const buffer = Buffer.from(await fileRes.arrayBuffer());

          // Extract EXIF/metadata
          const metadata = await exifr.parse(buffer, { xmp: true, iptc: true }).catch(() => null);

          if (metadata) {
            const sensitiveFields = [];
            if (metadata.Author || metadata.creator) sensitiveFields.push(`Author: ${metadata.Author || metadata.creator}`);
            if (metadata.Producer) sensitiveFields.push(`Producer: ${metadata.Producer}`);
            if (metadata.Creator) sensitiveFields.push(`Creator app: ${metadata.Creator}`);
            if (metadata.GPSLatitude || metadata.latitude) sensitiveFields.push(`GPS: ${metadata.GPSLatitude || metadata.latitude}, ${metadata.GPSLongitude || metadata.longitude}`);
            if (metadata.CreateDate) sensitiveFields.push(`Created: ${metadata.CreateDate}`);
            if (metadata.ModifyDate) sensitiveFields.push(`Modified: ${metadata.ModifyDate}`);
            if (metadata.Title) sensitiveFields.push(`Title: ${metadata.Title}`);
            if (metadata.Subject) sensitiveFields.push(`Subject: ${metadata.Subject}`);

            if (sensitiveFields.length > 0) {
              const hasGps = !!(metadata.GPSLatitude || metadata.latitude);
              const hasAuthor = !!(metadata.Author || metadata.creator);

              findings.push({
                category: "exposure",
                severity: hasGps ? "critical" : hasAuthor ? "high" : "medium",
                title: `Document metadata exposes ${sensitiveFields.length} field(s): ${doc.title}`,
                description: sensitiveFields.join("\n"),
                sourceUrl: doc.link,
                rawData: { document: doc, metadata, sensitiveFields },
                remediation: hasGps
                  ? "CRITICAL: GPS coordinates found in document metadata. Remove metadata before publishing (use ExifTool or PDF sanitizer)."
                  : "Remove document metadata before publishing. Use ExifTool: 'exiftool -all= filename.pdf'",
              });
            }
          }
        }
      } catch (_) {
        // Download/parse failed — skip
      } finally {
        release();
      }
    }

    if (findings.length === 0) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "No documents found",
        description: `No public PDFs or documents containing "${value}" were found in Google search results.`,
        rawData: { value, found: false },
      });
    }

    return findings;
  },
};
