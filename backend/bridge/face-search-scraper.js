// Face Search Scraper — browser automation for reverse image search engines
// Submits face photo to Google Lens, Yandex, Bing and scrapes results
const fs = require("fs");
const path = require("path");

const BROWSER_API = "http://127.0.0.1:3334";
const FACE_API = "http://127.0.0.1:5555";
const RESIDENTIAL_PROXY = process.env.RESIDENTIAL_PROXY || "socks5://127.0.0.1:1080";

async function browserFetch(endpoint, body, timeout = 25000) {
  try {
    const res = await fetch(`${BROWSER_API}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Google Lens ──
async function scrapeGoogleLens(sessionId, imagePath, opts = {}) {
  const results = [];
  try {
    // Navigate to Google Lens upload page
    const nav = await browserFetch("/navigate", {
      url: "https://lens.google.com/",
      session_id: sessionId,
    }, 30000);
    if (!nav?.ok) return results;

    await wait(2000);

    // Read image and convert to base64 for upload via JS
    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString("base64");
    const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";

    // Use evaluate to create a file upload via drag-and-drop simulation
    const uploadResult = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(async () => {
        // Find the upload input or trigger the upload dialog
        const input = document.querySelector('input[type="file"]');
        if (input) {
          // Convert base64 to file and set it
          const byteChars = atob("${base64.substring(0, 100)}...");
          // Can't do full base64 in evaluate, use URL approach instead
          return JSON.stringify({ method: "input_found", inputExists: true });
        }
        // Try clicking the camera/upload button
        const btn = document.querySelector('[aria-label="Search by image"], .nDcEnd, .Gdd5U');
        if (btn) {
          btn.click();
          return JSON.stringify({ method: "button_clicked" });
        }
        return JSON.stringify({ method: "none", html: document.title });
      })()`,
    }, 10000);

    // Alternative: use the URL-based search
    // Google Lens can accept a URL parameter if the image is accessible
    const bridgeUrl = process.env.BRIDGE_PUBLIC_URL || "http://10.8.0.1:3333";
    const imageUrl = opts?.profileId ? `${bridgeUrl}/osint/images/${opts.profileId}` : `${bridgeUrl}/osint/images/upload/${path.basename(imagePath)}`;

    // Try URL-based lens search
    const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
    const lensNav = await browserFetch("/navigate", {
      url: lensUrl,
      session_id: sessionId,
    }, 30000);

    if (lensNav?.ok && !lensNav?.url?.includes('/sorry/')) {
      await wait(5000); // Wait for results to load

      const extractResult = await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `(() => {
          const results = [];
          // Extract visual matches
          document.querySelectorAll('a[href*="imgres"], a[data-action-url], .isv-r a').forEach(a => {
            const href = a.href || a.getAttribute('data-action-url') || '';
            const img = a.querySelector('img');
            const title = a.textContent?.trim()?.substring(0, 200) || '';
            if (href && !href.includes('google.com/search')) {
              results.push({ sourceUrl: href, title, imageUrl: img?.src || '' });
            }
          });
          // Extract "Pages with matching images"
          document.querySelectorAll('.kno-fv a, .r5a77d a, .VFACy a').forEach(a => {
            results.push({ sourceUrl: a.href, title: a.textContent?.trim()?.substring(0, 200) || '', type: 'page_match' });
          });
          // Extract text results
          document.querySelectorAll('.g a, [data-ved] a[href^="http"]').forEach(a => {
            if (a.href && !a.href.includes('google.com')) {
              results.push({ sourceUrl: a.href, title: a.textContent?.trim()?.substring(0, 200) || '', type: 'text_match' });
            }
          });
          return JSON.stringify(results.slice(0, 50));
        })()`,
      }, 15000);

      if (extractResult?.result) {
        try {
          const parsed = JSON.parse(extractResult.result);
          results.push(...parsed.map(r => ({ ...r, engine: "google_lens" })));
        } catch (_) {}
      }
    }

    // Also try Google reverse image search
    const risUrl = `https://www.google.com/searchbyimage?image_url=${encodeURIComponent(imageUrl)}`;
    const risNav = await browserFetch("/navigate", { url: risUrl, session_id: sessionId }, 30000);
    if (risNav?.ok && !risNav?.url?.includes('/sorry/')) {
      await wait(3000);
      const risExtract = await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `(() => {
          const results = [];
          document.querySelectorAll('#search .g a, #rso a').forEach(a => {
            if (a.href && !a.href.includes('google.com') && a.href.startsWith('http')) {
              results.push({ sourceUrl: a.href, title: a.closest('.g')?.querySelector('h3')?.textContent || a.textContent?.substring(0, 200) || '' });
            }
          });
          // Best guess label
          const bestGuess = document.querySelector('.fKDtNb, #topstuff a')?.textContent || '';
          if (bestGuess) results.unshift({ bestGuess, type: 'identity_guess' });
          return JSON.stringify(results.slice(0, 30));
        })()`,
      });
      if (risExtract?.result) {
        try {
          const parsed = JSON.parse(risExtract.result);
          results.push(...parsed.map(r => ({ ...r, engine: "google_ris" })));
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error("[face-search] Google Lens error:", err.message);
  }
  return results;
}

// ── Yandex Images ──
async function scrapeYandexImages(sessionId, imagePath, opts = {}) {
  const results = [];
  try {
    const bridgeUrl = process.env.BRIDGE_PUBLIC_URL || "http://10.8.0.1:3333";
    const imageUrl = opts?.profileId ? `${bridgeUrl}/osint/images/${opts.profileId}` : `${bridgeUrl}/osint/images/upload/${path.basename(imagePath)}`;

    // Yandex reverse image search URL
    const yandexUrl = `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(imageUrl)}`;
    const nav = await browserFetch("/navigate", { url: yandexUrl, session_id: sessionId }, 30000);
    if (!nav?.ok) return results;

    await wait(5000);

    const extractResult = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const results = [];
        // "Sites where this image was found"
        document.querySelectorAll('.CbirSites-Item a, .other-sites__item a').forEach(a => {
          results.push({
            sourceUrl: a.href,
            title: a.textContent?.trim()?.substring(0, 200) || '',
            type: 'site_match'
          });
        });
        // Similar images
        document.querySelectorAll('.CbirOtherSizes-Item a, .similar__thumb a').forEach(a => {
          const img = a.querySelector('img');
          results.push({
            sourceUrl: a.href,
            imageUrl: img?.src || '',
            type: 'similar_image'
          });
        });
        // Text/description from results
        document.querySelectorAll('.CbirObjectResponse-Title, .Tags-Wrapper .Tags-Item, .CbirTags-Item').forEach(el => {
          const text = el.textContent?.trim();
          if (text) results.push({ bestGuess: text, type: 'identity_guess' });
        });
        return JSON.stringify(results.slice(0, 30));
      })()`,
    }, 15000);

    if (extractResult?.result) {
      try {
        const parsed = JSON.parse(extractResult.result);
        results.push(...parsed.map(r => ({ ...r, engine: "yandex" })));
      } catch (_) {}
    }
  } catch (err) {
    console.error("[face-search] Yandex error:", err.message);
  }
  return results;
}

// ── Bing Visual Search ──
async function scrapeBingVisual(sessionId, imagePath, opts = {}) {
  const results = [];
  try {
    const bridgeUrl = process.env.BRIDGE_PUBLIC_URL || "http://10.8.0.1:3333";
    const imageUrl = opts?.profileId ? `${bridgeUrl}/osint/images/${opts.profileId}` : `${bridgeUrl}/osint/images/upload/${path.basename(imagePath)}`;

    const bingUrl = `https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:${encodeURIComponent(imageUrl)}`;
    const nav = await browserFetch("/navigate", { url: bingUrl, session_id: sessionId }, 30000);
    if (!nav?.ok) return results;

    await wait(5000);

    const extractResult = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        var results = [];
        // Extract identity from page title (Bing uses "Name - Search" format)
        var title = document.title || '';
        if (title.indexOf(' - Search') > 0) {
          results.push({ bestGuess: title.replace(' - Search', '').trim(), type: 'identity_guess' });
        }
        // Entity label from knowledge panel
        var entity = document.querySelector('.b_entityTitle, .sbi_entityLabel, .b_lBottom .b_factrow');
        if (entity) results.push({ bestGuess: entity.textContent.trim(), type: 'identity_guess' });
        // Extract h2 headings as identity signals
        var h2s = document.querySelectorAll('h2');
        for (var i = 0; i < Math.min(h2s.length, 5); i++) {
          var txt = h2s[i].textContent.trim();
          if (txt.length > 3 && txt.length < 100) {
            results.push({ bestGuess: txt, type: 'identity_guess' });
          }
        }
        // Pages containing this image + search results
        var links = document.querySelectorAll('.b_algo h2 a, .b_title a, .sbi_sp a, .infnmpt a');
        for (var j = 0; j < Math.min(links.length, 20); j++) {
          var a = links[j];
          var href = a.href || '';
          // Decode Bing redirect URLs
          var realUrl = href;
          var match = href.match(/[?&]u=a1(.+?)(&|$)/);
          if (match) {
            try { realUrl = atob(match[1]); } catch(e) { realUrl = href; }
          }
          if (realUrl && realUrl.indexOf('bing.com') === -1 && realUrl.indexOf('microsoft.com') === -1) {
            results.push({
              sourceUrl: realUrl,
              title: a.textContent.trim().substring(0, 200),
              type: 'page_match'
            });
          }
        }
        return JSON.stringify(results.slice(0, 30));
      })()`,
    }, 15000);

    if (extractResult?.result) {
      try {
        const parsed = JSON.parse(extractResult.result);
        results.push(...parsed.map(r => ({ ...r, engine: "bing" })));
      } catch (_) {}
    }
  } catch (err) {
    console.error("[face-search] Bing error:", err.message);
  }
  return results;
}

// ── ArcFace Verification ──
async function verifyFaceMatch(originalImagePath, candidateImageUrl) {
  try {
    const originalBuffer = fs.readFileSync(originalImagePath);

    // Download candidate image
    const res = await fetch(candidateImageUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const candidateBuffer = Buffer.from(await res.arrayBuffer());

    // Compare via ArcFace
    const form = new FormData();
    form.append("base64_image1", originalBuffer.toString("base64"));
    form.append("base64_image2", candidateBuffer.toString("base64"));
    const compareRes = await fetch(`${FACE_API}/compare`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!compareRes.ok) return null;
    const data = await compareRes.json();
    return data;
  } catch (_) {
    return null;
  }
}

// ── Main Search Function ──
async function searchFace(imagePath, opts = {}) {
  const allResults = [];
  const sessionId = `face-search-${Date.now()}`;

  // Create proxy sessions for Google/Bing (residential IP avoids CAPTCHAs)
  // Yandex works fine from datacenter IP — no proxy needed
  const useProxy = opts.useProxy !== false;
  if (useProxy) {
    await browserFetch("/session/new", { session_id: sessionId, proxy: RESIDENTIAL_PROXY }, 15000);
    await browserFetch("/session/new", { session_id: `${sessionId}-bing`, proxy: RESIDENTIAL_PROXY }, 15000);
    console.log(`[face-search] Created proxy sessions for Google/Bing via ${RESIDENTIAL_PROXY}`);
  }

  // Run searches sequentially
  const googleResults = await scrapeGoogleLens(sessionId, imagePath, opts);
  allResults.push(...googleResults);

  const yandexResults = await scrapeYandexImages(`${sessionId}-yx`, imagePath, opts);
  allResults.push(...yandexResults);

  const bingResults = await scrapeBingVisual(`${sessionId}-bing`, imagePath, opts);
  allResults.push(...bingResults);

  console.log(`[face-search] Results: Google=${googleResults.length}, Yandex=${yandexResults.length}, Bing=${bingResults.length}`);

  // Clean up sessions
  await browserFetch("/session/close", { session_id: sessionId }).catch(() => {});
  await browserFetch("/session/close", { session_id: `${sessionId}-yx` }).catch(() => {});
  await browserFetch("/session/close", { session_id: `${sessionId}-bing` }).catch(() => {});

  // De-duplicate by URL
  const seen = new Set();
  const unique = [];
  for (const r of allResults) {
    const key = r.sourceUrl || r.bestGuess || JSON.stringify(r);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }

  // Extract identity guesses (filter out dimension strings like "2924×3843" and generic words)
  const dimensionRe = /^\d+[×x]\d+$/;
  const genericWords = new Set(["человек", "person", "people", "man", "woman", "photo", "image"]);
  const identityGuesses = unique
    .filter(r => r.type === "identity_guess")
    .map(r => r.bestGuess)
    .filter(g => g && !dimensionRe.test(g) && !genericWords.has(g.toLowerCase()));

  return {
    results: unique.filter(r => r.sourceUrl),
    identityGuesses,
    totalResults: unique.length,
    engines: {
      google: googleResults.length,
      yandex: yandexResults.length,
      bing: bingResults.length,
    },
  };
}

module.exports = { searchFace, verifyFaceMatch, scrapeGoogleLens, scrapeYandexImages, scrapeBingVisual };
