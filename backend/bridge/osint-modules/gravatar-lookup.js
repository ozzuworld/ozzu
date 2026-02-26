// Gravatar profile lookup module — checks if email has a public Gravatar profile
// Free — uses MD5 hash of email, no API key needed

const crypto = require("crypto");

module.exports = {
  name: "gravatar-lookup",
  profileTypes: ["email"],

  async scan(profile, rateLimiter) {
    const email = profile.value.toLowerCase().trim();
    const hash = crypto.createHash("md5").update(email).digest("hex");
    const findings = [];

    // 1. Check Gravatar profile JSON
    const release = await rateLimiter.acquire();
    try {
      const profileUrl = `https://gravatar.com/${hash}.json`;
      const res = await fetch(profileUrl, {
        headers: { "User-Agent": "ozzu-osint-scanner" },
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json();
        const entry = data.entry && data.entry[0];

        if (entry) {
          // Profile exists — this is an exposure
          const profileInfo = [];
          if (entry.displayName) profileInfo.push(`Display name: ${entry.displayName}`);
          if (entry.preferredUsername) profileInfo.push(`Username: ${entry.preferredUsername}`);
          if (entry.aboutMe) profileInfo.push(`Bio: ${entry.aboutMe}`);
          if (entry.currentLocation) profileInfo.push(`Location: ${entry.currentLocation}`);
          if (entry.urls && entry.urls.length > 0) {
            profileInfo.push(`Links: ${entry.urls.map((u) => u.value).join(", ")}`);
          }
          if (entry.accounts && entry.accounts.length > 0) {
            profileInfo.push(`Linked accounts: ${entry.accounts.map((a) => `${a.shortname || a.domain}`).join(", ")}`);
          }

          const infoStr = profileInfo.length > 0 ? "\n\n" + profileInfo.join("\n") : "";
          const hasPersonalInfo = entry.currentLocation || entry.aboutMe || (entry.urls && entry.urls.length > 0);

          findings.push({
            category: "exposure",
            severity: hasPersonalInfo ? "medium" : "low",
            title: `Gravatar profile found${entry.displayName ? `: ${entry.displayName}` : ""}`,
            description: `This email has a public Gravatar profile. Anyone who knows the email can see this profile information.${infoStr}`,
            sourceUrl: `https://gravatar.com/${hash}`,
            rawData: {
              hash,
              displayName: entry.displayName || null,
              username: entry.preferredUsername || null,
              location: entry.currentLocation || null,
              aboutMe: entry.aboutMe || null,
              urls: entry.urls || [],
              accounts: entry.accounts || [],
              photos: entry.photos ? entry.photos.length : 0,
            },
            remediation: "Review your Gravatar profile at https://gravatar.com and remove any personal information you don't want publicly linked to this email. You can also delete the Gravatar account entirely.",
          });

          // Check linked accounts (these cross-reference identities)
          if (entry.accounts && entry.accounts.length > 0) {
            findings.push({
              category: "exposure",
              severity: "medium",
              title: `${entry.accounts.length} linked account${entry.accounts.length !== 1 ? "s" : ""} on Gravatar`,
              description: `The Gravatar profile links to these accounts: ${entry.accounts.map((a) => `${a.shortname || a.domain} (${a.username || a.url})`).join(", ")}. This allows cross-referencing the email with these identities.`,
              sourceUrl: `https://gravatar.com/${hash}`,
              rawData: { accounts: entry.accounts },
              remediation: "Remove linked accounts from Gravatar that you don't want associated with this email address.",
            });
          }
        }
      }
      // 404 = no profile, which is fine — no finding needed
    } catch (err) {
      // Network error — skip
    } finally {
      release();
    }

    // 2. Check if avatar image exists (separate from profile)
    if (findings.length === 0) {
      const release2 = await rateLimiter.acquire();
      try {
        const avatarUrl = `https://gravatar.com/avatar/${hash}?d=404`;
        const res = await fetch(avatarUrl, {
          method: "HEAD",
          headers: { "User-Agent": "ozzu-osint-scanner" },
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok) {
          findings.push({
            category: "exposure",
            severity: "low",
            title: "Gravatar avatar image exists",
            description: `This email has a Gravatar avatar image (but no detailed profile). The avatar is publicly accessible via the email's MD5 hash.`,
            sourceUrl: `https://gravatar.com/avatar/${hash}`,
            rawData: { hash, hasAvatar: true, hasProfile: false },
            remediation: "If you don't want an avatar linked to this email, remove it at https://gravatar.com.",
          });
        }
      } catch (_) {
        // Network error — skip
      } finally {
        release2();
      }
    }

    // If nothing found, that's good
    if (findings.length === 0) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "No Gravatar profile found",
        description: `No Gravatar profile or avatar is associated with this email. This is good for privacy.`,
        rawData: { hash, found: false },
        remediation: null,
      });
    }

    return findings;
  },
};
