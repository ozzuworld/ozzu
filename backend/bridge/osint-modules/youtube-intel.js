// YouTube Intelligence Module — yt-dlp for metadata extraction
// Extracts: channel name, description, subscriber count, video count, recent videos

const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

async function runInContainer(cmd, args, timeout = 30000) {
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec", "osint-tools", cmd, ...args,
    ], { timeout, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    return null;
  }
}

async function safeFetchJson(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ...options.headers,
      },
      signal: AbortSignal.timeout(options.timeout || 12000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

module.exports = {
  name: "youtube-intel",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];

    const release = await rateLimiter.acquire();
    try {
      // Strategy 1: yt-dlp channel metadata
      const channelUrl = `https://www.youtube.com/@${username}`;
      const raw = await runInContainer("yt-dlp", [
        "--dump-json", "--playlist-items", "1:5", "--flat-playlist",
        channelUrl,
      ], 45000);

      if (raw) {
        // yt-dlp outputs one JSON object per line for playlist items
        const lines = raw.split("\n").filter(l => l.trim().startsWith("{"));
        const videos = [];
        let channelName = username;
        let channelId = null;
        let subscriberCount = null;

        for (const line of lines.slice(0, 5)) {
          try {
            const item = JSON.parse(line);
            if (item.channel) channelName = item.channel;
            if (item.channel_id) channelId = item.channel_id;
            if (item.channel_follower_count) subscriberCount = item.channel_follower_count;
            videos.push({
              title: item.title,
              viewCount: item.view_count,
              uploadDate: item.upload_date,
              duration: item.duration,
              description: item.description?.substring(0, 200),
            });
          } catch (_) {}
        }

        if (videos.length > 0 || channelId) {
          const videoSummary = videos.length > 0
            ? `\nRecent videos:\n${videos.map(v => `  [${v.uploadDate || "?"}] ${v.title} (${v.viewCount?.toLocaleString() || "?"} views)`).join("\n")}`
            : "";

          findings.push({
            category: "account_found",
            severity: "medium",
            title: `YouTube: ${channelName} — ${subscriberCount ? subscriberCount.toLocaleString() + " subscribers" : "channel found"}`,
            description: [
              `Channel: ${channelName}`,
              subscriberCount && `Subscribers: ${subscriberCount.toLocaleString()}`,
              `Videos found: ${videos.length}`,
              videoSummary,
            ].filter(Boolean).join("\n"),
            sourceUrl: channelUrl,
            rawData: {
              platform: "youtube",
              profileData: {
                channelName,
                channelId,
                subscriberCount,
                channelUrl,
              },
              recentVideos: videos,
            },
            remediation: "Review YouTube channel privacy. Unlisted videos may still be discoverable via playlists.",
          });
          return findings;
        }
      }

      // Strategy 2: Search for username
      const searchRaw = await runInContainer("yt-dlp", [
        "--dump-json", "--flat-playlist", "--playlist-items", "1:3",
        `ytsearch3:${username}`,
      ], 30000);

      if (searchRaw) {
        const lines = searchRaw.split("\n").filter(l => l.trim().startsWith("{"));
        const results = [];
        for (const line of lines.slice(0, 3)) {
          try {
            const item = JSON.parse(line);
            if (item.channel?.toLowerCase() === username.toLowerCase() ||
                item.uploader?.toLowerCase() === username.toLowerCase()) {
              results.push({
                title: item.title,
                channel: item.channel || item.uploader,
                channelUrl: item.channel_url || item.uploader_url,
                viewCount: item.view_count,
              });
            }
          } catch (_) {}
        }

        if (results.length > 0) {
          findings.push({
            category: "account_found",
            severity: "low",
            title: `YouTube: search results match "${username}"`,
            description: `Found ${results.length} video(s) by channels matching "${username}":\n${results.map(r => `  ${r.channel}: ${r.title}`).join("\n")}`,
            sourceUrl: results[0].channelUrl || `https://www.youtube.com/results?search_query=${username}`,
            rawData: { platform: "youtube", searchResults: results, username },
          });
        }
      }
    } finally {
      release();
    }

    return findings;
  },
};
