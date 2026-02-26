// HIBP Pwned Passwords module — k-anonymity SHA-1 lookup
// Completely free, no API key, no rate limits

module.exports = {
  name: "hibp-password",
  profileTypes: ["password"],

  async scan(profile, rateLimiter) {
    const hash = profile.value.toUpperCase();
    const prefix = hash.substring(0, 5);
    const suffix = hash.substring(5);

    const release = await rateLimiter.acquire();
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "User-Agent": "ozzu-osint-scanner" },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        throw new Error(`HIBP API returned ${res.status}`);
      }

      const text = await res.text();
      const lines = text.split("\n");

      for (const line of lines) {
        const [hashSuffix, countStr] = line.trim().split(":");
        if (hashSuffix === suffix) {
          const count = parseInt(countStr, 10);
          let severity;
          if (count > 100000) severity = "critical";
          else if (count > 10000) severity = "high";
          else if (count > 1000) severity = "medium";
          else severity = "low";

          return [{
            category: "breach",
            severity,
            title: `Password found in ${count.toLocaleString()} data breaches`,
            description: `This password hash appears ${count.toLocaleString()} times in the Have I Been Pwned database. This means the password has been exposed in known data breaches and should be changed immediately.`,
            sourceUrl: "https://haveibeenpwned.com/Passwords",
            rawData: { count, prefix },
            remediation: "Change this password everywhere it's used. Use a unique, randomly generated password from a password manager.",
          }];
        }
      }

      // Not found — good news
      return [{
        category: "breach",
        severity: "info",
        title: "Password not found in known breaches",
        description: "This password hash was not found in the Have I Been Pwned database. This doesn't guarantee safety, but it hasn't appeared in any known data breaches.",
        sourceUrl: "https://haveibeenpwned.com/Passwords",
        rawData: { count: 0, prefix },
        remediation: null,
      }];
    } finally {
      release();
    }
  },
};
