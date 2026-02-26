// Data broker / people search site detection module
// Checks if a name or username appears on major data broker / people-search sites
// Free — HTTP HEAD/GET checks, no API keys needed

const DATA_BROKERS = [
  // People search engines
  {
    name: "Spokeo",
    url: "https://www.spokeo.com/{}",
    profileTypes: ["username"],
    severity: "high",
    category: "exposure",
    description: "Spokeo aggregates public records, social media, and other data sources. A profile here exposes personal information to anyone who searches.",
    remediation: "Opt out at https://www.spokeo.com/optout — requires email verification. Allow 24-48 hours for removal.",
  },
  {
    name: "BeenVerified",
    url: "https://www.beenverified.com/people/{}",
    profileTypes: ["username"],
    severity: "high",
    category: "exposure",
    description: "BeenVerified compiles public records, social media, and property data. Profile presence means your information is being sold.",
    remediation: "Opt out at https://www.beenverified.com/app/optout/search — requires personal info to verify identity.",
  },
  {
    name: "WhitePages",
    url: "https://www.whitepages.com/name/{}",
    profileTypes: ["username"],
    severity: "high",
    category: "exposure",
    description: "WhitePages is one of the largest people-search directories. Listings often include address, phone, and relatives.",
    remediation: "Opt out at https://www.whitepages.com/suppression-requests — verify by phone or mail.",
  },
  {
    name: "PeekYou",
    url: "https://www.peekyou.com/{}",
    profileTypes: ["username"],
    severity: "medium",
    category: "exposure",
    description: "PeekYou indexes social media profiles, blog posts, and public records under a unified profile.",
    remediation: "Opt out at https://www.peekyou.com/about/contact/optout/",
  },
  {
    name: "That'sThem",
    url: "https://thatsthem.com/name/{}",
    profileTypes: ["username"],
    severity: "medium",
    category: "exposure",
    description: "That'sThem provides free people search including address, email, and phone lookups.",
    remediation: "Opt out at https://thatsthem.com/optout",
  },
  {
    name: "Pipl",
    url: "https://pipl.com/search/?q={}",
    profileTypes: ["username", "email"],
    severity: "high",
    category: "exposure",
    description: "Pipl is a professional identity search engine used by businesses and investigators. A profile here is widely accessible.",
    remediation: "Contact Pipl support to request removal of your profile.",
  },
  {
    name: "Intelius",
    url: "https://www.intelius.com/people-search/{}",
    profileTypes: ["username"],
    severity: "high",
    category: "exposure",
    description: "Intelius provides detailed background reports including criminal records, addresses, and relationships.",
    remediation: "Opt out at https://www.intelius.com/opt-out/submit/ — requires personal info and ID verification.",
  },
  {
    name: "FastPeopleSearch",
    url: "https://www.fastpeoplesearch.com/name/{}",
    profileTypes: ["username"],
    severity: "high",
    category: "exposure",
    description: "FastPeopleSearch offers free people lookups including address, phone, and email.",
    remediation: "Opt out at https://www.fastpeoplesearch.com/removal",
  },
  {
    name: "TruePeopleSearch",
    url: "https://www.truepeoplesearch.com/results?name={}",
    profileTypes: ["username"],
    severity: "high",
    category: "exposure",
    description: "TruePeopleSearch provides free access to address, phone, email, and associated people.",
    remediation: "Opt out at https://www.truepeoplesearch.com/removal",
  },
  {
    name: "Radaris",
    url: "https://radaris.com/p/{}/",
    profileTypes: ["username"],
    severity: "medium",
    category: "exposure",
    description: "Radaris aggregates public records and social media into searchable profiles.",
    remediation: "Opt out at https://radaris.com/control/privacy — requires account creation.",
  },
  // Email-specific data brokers
  {
    name: "Hunter.io",
    url: "https://hunter.io/email-verifier/{}",
    profileTypes: ["email"],
    severity: "medium",
    category: "exposure",
    description: "Hunter.io is an email finding tool used by sales teams. If your email is indexed, it's being used for cold outreach.",
    remediation: "Request removal at https://hunter.io/claim",
  },
  {
    name: "EmailRep",
    url: "https://emailrep.io/{}",
    profileTypes: ["email"],
    severity: "low",
    category: "exposure",
    description: "EmailRep.io provides email reputation data. Being indexed means your email has been seen in various public contexts.",
    remediation: "Email reputation data cannot be easily removed — it's aggregated from many public sources.",
  },
];

module.exports = {
  name: "data-broker",
  profileTypes: ["username", "email"],

  async scan(profile, rateLimiter) {
    const value = profile.value;
    const applicableBrokers = DATA_BROKERS.filter((b) =>
      b.profileTypes.includes(profile.profile_type)
    );

    const findings = [];

    const checkBroker = async (broker) => {
      const release = await rateLimiter.acquire();
      try {
        const url = broker.url.replace("{}", encodeURIComponent(value));
        const res = await fetch(url, {
          method: "HEAD",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });

        // 200 = page exists (may or may not have actual data)
        // 3xx to a profile page = likely has data
        if (res.status === 200) {
          return {
            category: broker.category,
            severity: broker.severity,
            title: `Potential listing on ${broker.name}`,
            description: broker.description,
            sourceUrl: url,
            rawData: { broker: broker.name, status: res.status, profileType: profile.profile_type },
            remediation: broker.remediation,
          };
        }
      } catch (_) {
        // Timeout or network error — skip
      } finally {
        release();
      }
      return null;
    };

    const results = await Promise.all(applicableBrokers.map(checkBroker));
    for (const result of results) {
      if (result) findings.push(result);
    }

    if (findings.length === 0) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: `No data broker listings found (${applicableBrokers.length} sites checked)`,
        description: `No listings were found on ${applicableBrokers.length} major data broker and people-search sites. This doesn't guarantee absence — some sites require exact name matching or paid access to reveal results.`,
        rawData: { sitesChecked: applicableBrokers.length, profileType: profile.profile_type },
        remediation: null,
      });
    } else {
      // Add summary finding
      findings.unshift({
        category: "exposure",
        severity: findings.length >= 5 ? "high" : "medium",
        title: `Found on ${findings.length} data broker site${findings.length !== 1 ? "s" : ""}`,
        description: `Your information appears on ${findings.length} data broker/people-search sites: ${findings.map((f) => f.rawData?.broker).filter(Boolean).join(", ")}. These sites aggregate and sell personal information.`,
        rawData: { totalBrokers: findings.length, brokers: findings.map((f) => f.rawData?.broker).filter(Boolean) },
        remediation: "Opt out from each site individually. Consider using a data removal service like DeleteMe or Privacy Duck for bulk removal.",
      });
    }

    return findings;
  },
};
