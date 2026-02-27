// GHunt email module — Google account OSINT via GHunt CLI
// Extracts: Gaia ID, display name, profile photo, YouTube, Maps reviews, linked services
const cliRunner = require("../osint-cli-runner");

module.exports = {
  name: "ghunt-email",
  profileTypes: ["email"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const email = profile.value;

    // Only run on Gmail addresses
    if (!email.toLowerCase().endsWith("@gmail.com")) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "GHunt skipped — not a Gmail address",
        description: `GHunt only works with Gmail addresses. "${email}" is not a Gmail account.`,
        rawData: { reason: "not_gmail", email },
      });
      return findings;
    }

    // Check if ghunt is available
    const available = await cliRunner.isToolAvailable("/opt/osint-venv/bin/ghunt");
    if (!available) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "GHunt scan skipped — tool not available",
        description: "GHunt CLI is not installed in the osint-tools container. Install with: pip install ghunt",
        rawData: { reason: "tool_unavailable", tool: "ghunt" },
      });
      return findings;
    }

    // Check for auth cookies
    try {
      const cookieCheck = await cliRunner.runTool("ls", ["/app/data/ghunt-cookies/"], {
        timeout: 5000,
        parseJson: false,
      });
      if (!cookieCheck.stdout || cookieCheck.stdout.trim().length === 0) {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "GHunt requires authentication setup",
          description: "GHunt needs Google cookies for auth. Run: docker exec -it bridge /opt/osint-venv/bin/ghunt login",
          rawData: { reason: "no_auth", tool: "ghunt" },
        });
        return findings;
      }
    } catch {
      // If can't check cookies, try running anyway
    }

    const release = await rateLimiter.acquire();
    try {
      const crypto = require("crypto");
      const outputFile = `/tmp/ghunt-${crypto.randomUUID()}.json`;

      const result = await cliRunner.runTool("/opt/osint-venv/bin/ghunt", [
        "email", email, "--json", outputFile,
      ], { timeout: 60000, parseJson: false });

      // Try to read JSON output
      let data = null;
      try {
        const fileResult = await cliRunner.runTool("cat", [outputFile], { timeout: 5000 });
        data = fileResult.parsed;
      } catch {
        try { data = JSON.parse(result.stdout); } catch { /* not JSON */ }
      }

      // Clean up
      cliRunner.runTool("rm", ["-f", outputFile], { timeout: 5000 }).catch(() => {});

      if (data) {
        // Extract Gaia ID
        if (data.gaiaId || data.gaia_id) {
          const gaiaId = data.gaiaId || data.gaia_id;
          findings.push({
            category: "exposure",
            severity: "info",
            title: `Google Gaia ID: ${gaiaId}`,
            description: `Unique Google account identifier for ${email}.`,
            rawData: { gaiaId, email, tool: "ghunt" },
          });
        }

        // Display name
        const displayName = data.name || data.displayName || data.display_name;
        if (displayName) {
          findings.push({
            category: "exposure",
            severity: "medium",
            title: `Google display name: ${displayName}`,
            description: `Public display name associated with ${email}. Can be cross-referenced with other platforms.`,
            rawData: { displayName, email, tool: "ghunt" },
            remediation: "Consider changing your Google display name if you want to reduce cross-platform linkability.",
          });
        }

        // Profile photo
        const profilePhoto = data.profilePhoto || data.profile_photo || data.photo_url;
        if (profilePhoto && profilePhoto !== "default") {
          findings.push({
            category: "exposure",
            severity: "medium",
            title: "Google profile photo found",
            description: "Profile photo URL can be used for reverse-image searches to find other accounts.",
            sourceUrl: profilePhoto,
            rawData: { profilePhoto, email, tool: "ghunt" },
            remediation: "Use a unique avatar per platform to prevent cross-platform tracking via reverse image search.",
          });
        }

        // YouTube channels
        const youtube = data.youtube || data.youtubeChannels || data.youtube_channels;
        if (youtube && (Array.isArray(youtube) ? youtube.length > 0 : true)) {
          const channels = Array.isArray(youtube) ? youtube : [youtube];
          findings.push({
            category: "exposure",
            severity: "high",
            title: `YouTube channel${channels.length > 1 ? "s" : ""} linked to Google account`,
            description: channels.map((c) => `${c.name || c.title || "Channel"}: ${c.url || c.channelUrl || "N/A"}`).join("\n"),
            sourceUrl: channels[0]?.url || channels[0]?.channelUrl,
            rawData: { youtube: channels, email, tool: "ghunt" },
            remediation: "YouTube channels reveal content interests and activity patterns. Review channel privacy settings.",
          });
        }

        // Google Maps reviews (reveals physical locations)
        const mapsReviews = data.maps || data.mapsReviews || data.maps_reviews || data.reviews;
        if (mapsReviews && (Array.isArray(mapsReviews) ? mapsReviews.length > 0 : true)) {
          const reviews = Array.isArray(mapsReviews) ? mapsReviews : [mapsReviews];
          findings.push({
            category: "exposure",
            severity: "critical",
            title: `Google Maps reviews reveal ${reviews.length} physical location${reviews.length > 1 ? "s" : ""}`,
            description: `Maps reviews expose places visited. ${reviews.slice(0, 5).map((r) => r.place || r.name || r.location || "Unknown place").join(", ")}`,
            rawData: { reviews: reviews.slice(0, 20), totalReviews: reviews.length, email, tool: "ghunt" },
            remediation: "Google Maps reviews are public by default. Delete reviews or set your profile to private in Google Maps settings.",
          });
        }

        // Last profile edit
        const lastEdit = data.lastEdit || data.last_edit || data.lastUpdated;
        if (lastEdit) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: `Last Google profile edit: ${lastEdit}`,
            description: "Indicates when the Google account was last modified.",
            rawData: { lastEdit, email, tool: "ghunt" },
          });
        }

        // Linked services summary
        const services = data.services || data.linkedServices || data.linked_services;
        if (services && (Array.isArray(services) ? services.length > 0 : Object.keys(services).length > 0)) {
          const serviceList = Array.isArray(services) ? services : Object.keys(services);
          findings.push({
            category: "exposure",
            severity: "info",
            title: `${serviceList.length} linked Google services detected`,
            description: `Services: ${serviceList.join(", ")}`,
            rawData: { services: serviceList, email, tool: "ghunt" },
          });
        }

        // Fallback if no structured data parsed
        if (findings.length === 0 && result.stdout) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: `GHunt scan completed for ${email}`,
            description: result.stdout.slice(0, 500),
            rawData: { stdout: result.stdout.slice(0, 2000), tool: "ghunt" },
          });
        }
      } else if (result.stdout) {
        findings.push({
          category: "exposure",
          severity: "info",
          title: `GHunt: Results for ${email}`,
          description: result.stdout.slice(0, 500),
          rawData: { stdout: result.stdout.slice(0, 2000), tool: "ghunt" },
        });
      } else {
        findings.push({
          category: "exposure",
          severity: "info",
          title: `GHunt: No data found for ${email}`,
          description: "GHunt returned no data for this Gmail address.",
          rawData: { email, tool: "ghunt" },
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: `GHunt scan error: ${err.message}`,
        description: `Failed to run GHunt for "${email}". Run: docker exec -it bridge /opt/osint-venv/bin/ghunt login`,
        rawData: { error: err.message, tool: "ghunt" },
      });
    } finally {
      release();
    }

    return findings;
  },
};
