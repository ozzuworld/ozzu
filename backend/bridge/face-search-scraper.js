// Face Search Scraper — browser automation for reverse image search engines
// Submits face photo to Google Lens, Yandex, Bing and scrapes results
// Primary method: direct file upload via browser. Fallback: URL-based search.
const fs = require("fs");
const path = require("path");

const BROWSER_API = "http://127.0.0.1:3334";
const FACE_API = "http://127.0.0.1:5555";

function getPublicImageUrl(profileId) {
  const bridgeUrl = process.env.BRIDGE_PUBLIC_URL || "https://home.ozzu.world/bridge";
  return `${bridgeUrl}/osint/images/${profileId}`;
}

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

// ── Google Lens — direct file upload ──
async function scrapeGoogleLens(sessionId, imagePath, opts = {}) {
  const results = [];
  try {
    // Navigate to Google Images
    const nav = await browserFetch("/navigate", {
      url: "https://www.google.com/imghp",
      session_id: sessionId,
    }, 30000);
    if (!nav?.ok) return results;
    await wait(2000);

    // Click the camera/search-by-image button
    const camClick = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const btn = document.querySelector('[aria-label="Search by image"], .nDcEnd, .Gdd5U, .tdmBEe');
        if (btn) { btn.click(); return "clicked"; }
        return "not_found:" + document.title;
      })()`,
    }, 10000);
    if (!camClick?.result?.includes("clicked")) {
      // Fallback: try URL-based search
      return await scrapeGoogleLensUrl(sessionId, opts);
    }
    await wait(2000);

    // Upload file directly
    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString("base64");
    const upload = await browserFetch("/upload-file", {
      session_id: sessionId,
      base64,
      filename: path.basename(imagePath),
      mime_type: imagePath.endsWith(".png") ? "image/png" : "image/jpeg",
    }, 30000);

    if (!upload?.ok) {
      // Fallback to URL
      return await scrapeGoogleLensUrl(sessionId, opts);
    }

    await wait(6000); // Wait for Google to process

    // Extract results
    const extractResult = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const results = [];
        // Best guess / entity name
        const bestGuess = document.querySelector('.fKDtNb, #topstuff a, .rg_anbg, .cSBmKb')?.textContent?.trim();
        if (bestGuess) results.push({ bestGuess, type: 'identity_guess' });

        // Visual matches
        document.querySelectorAll('a[href*="imgres"], a[data-action-url], .isv-r a').forEach(a => {
          const href = a.href || a.getAttribute('data-action-url') || '';
          const title = a.textContent?.trim()?.substring(0, 200) || '';
          if (href && !href.includes('google.com/search')) {
            results.push({ sourceUrl: href, title, type: 'visual_match' });
          }
        });
        // Pages with matching images
        document.querySelectorAll('.kno-fv a, .r5a77d a, .VFACy a, .g a').forEach(a => {
          if (a.href && !a.href.includes('google.com')) {
            results.push({ sourceUrl: a.href, title: a.textContent?.trim()?.substring(0, 200) || '', type: 'page_match' });
          }
        });
        // Text results
        document.querySelectorAll('#search .g a, #rso a, [data-ved] a[href^="http"]').forEach(a => {
          if (a.href && !a.href.includes('google.com')) {
            const h3 = a.closest('.g')?.querySelector('h3');
            results.push({ sourceUrl: a.href, title: h3?.textContent || a.textContent?.trim()?.substring(0, 200) || '', type: 'text_match' });
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
  } catch (err) {
    console.error("[face-search] Google Lens error:", err.message);
  }
  return results;
}

// Google Lens URL fallback
async function scrapeGoogleLensUrl(sessionId, opts = {}) {
  const results = [];
  if (!opts.profileId) return results;
  const imageUrl = getPublicImageUrl(opts.profileId);

  const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
  const nav = await browserFetch("/navigate", { url: lensUrl, session_id: sessionId }, 30000);
  if (!nav?.ok || nav?.url?.includes('/sorry/')) return results;
  await wait(5000);

  const extract = await browserFetch("/evaluate", {
    session_id: sessionId,
    script: `(() => {
      const results = [];
      document.querySelectorAll('a[href*="imgres"], .g a, #rso a').forEach(a => {
        if (a.href && !a.href.includes('google.com')) {
          results.push({ sourceUrl: a.href, title: a.textContent?.trim()?.substring(0, 200) || '' });
        }
      });
      const bestGuess = document.querySelector('.fKDtNb, #topstuff a')?.textContent;
      if (bestGuess) results.unshift({ bestGuess, type: 'identity_guess' });
      return JSON.stringify(results.slice(0, 30));
    })()`,
  });
  if (extract?.result) {
    try {
      const parsed = JSON.parse(extract.result);
      results.push(...parsed.map(r => ({ ...r, engine: "google_lens" })));
    } catch (_) {}
  }
  return results;
}

// ── Yandex Images — direct file upload ──
async function scrapeYandexImages(sessionId, imagePath, opts = {}) {
  const results = [];
  try {
    // Navigate to Yandex Images
    const nav = await browserFetch("/navigate", {
      url: "https://yandex.com/images/",
      session_id: sessionId,
    }, 30000);
    if (!nav?.ok) return results;
    await wait(2000);

    // Click camera/reverse-search button
    const camClick = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const btn = document.querySelector('.input__cbir-button, .HeaderDesktopForm-VisualSearch, [class*="CbirButton"], button[aria-label*="image"]');
        if (btn) { btn.click(); return "clicked"; }
        // Try by aria
        const all = document.querySelectorAll('button, [role="button"]');
        for (const el of all) {
          if (el.getAttribute('aria-label')?.toLowerCase()?.includes('image') || el.className?.includes('cbir')) {
            el.click(); return "clicked:" + el.className;
          }
        }
        return "not_found:" + document.title;
      })()`,
    }, 10000);

    await wait(2000);

    // Try direct file upload first
    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString("base64");
    let uploaded = false;

    const upload = await browserFetch("/upload-file", {
      session_id: sessionId,
      base64,
      filename: path.basename(imagePath),
      mime_type: imagePath.endsWith(".png") ? "image/png" : "image/jpeg",
    }, 30000);

    if (upload?.ok) {
      uploaded = true;
      await wait(6000); // Wait for Yandex to process
    }

    // If upload didn't work, try URL-based
    if (!uploaded && opts.profileId) {
      const imageUrl = getPublicImageUrl(opts.profileId);
      const yandexUrl = `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(imageUrl)}`;
      const urlNav = await browserFetch("/navigate", { url: yandexUrl, session_id: sessionId }, 30000);
      if (urlNav?.ok) await wait(5000);
    }

    // Extract results
    const extractResult = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const results = [];
        // Identity tags (Yandex often identifies people)
        document.querySelectorAll('.CbirObjectResponse-Title, .Tags-Wrapper .Tags-Item, .CbirTags-Item, .CbirObjectResponse-Description').forEach(el => {
          const text = el.textContent?.trim();
          if (text && text.length > 1) results.push({ bestGuess: text, type: 'identity_guess' });
        });
        // Sites where image was found
        document.querySelectorAll('.CbirSites-Item a, .other-sites__item a, .CbirSites-ItemTitle a').forEach(a => {
          results.push({ sourceUrl: a.href, title: a.textContent?.trim()?.substring(0, 200) || '', type: 'site_match' });
        });
        // Similar images links
        document.querySelectorAll('.CbirOtherSizes-Item a, .similar__thumb a, .CbirOtherSizes a').forEach(a => {
          const img = a.querySelector('img');
          results.push({ sourceUrl: a.href, imageUrl: img?.src || '', type: 'similar_image' });
        });
        // People tags
        document.querySelectorAll('.CbirPeople-Item, .CbirFaces-Item').forEach(el => {
          const name = el.querySelector('.CbirPeople-ItemName, .CbirFaces-ItemName')?.textContent?.trim();
          const link = el.querySelector('a')?.href;
          if (name) results.push({ bestGuess: name, sourceUrl: link || '', type: 'identity_guess' });
        });
        return JSON.stringify(results.slice(0, 50));
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

// ── Bing Visual Search — direct file upload ──
async function scrapeBingVisual(sessionId, imagePath, opts = {}) {
  const results = [];
  try {
    // Navigate to Bing Visual Search
    const nav = await browserFetch("/navigate", {
      url: "https://www.bing.com/visualsearch",
      session_id: sessionId,
    }, 30000);
    if (!nav?.ok) return results;
    await wait(2000);

    // Try file upload
    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString("base64");
    let uploaded = false;

    const upload = await browserFetch("/upload-file", {
      session_id: sessionId,
      base64,
      filename: path.basename(imagePath),
      mime_type: imagePath.endsWith(".png") ? "image/png" : "image/jpeg",
    }, 30000);

    if (upload?.ok) {
      uploaded = true;
      await wait(6000);
    }

    // URL fallback
    if (!uploaded && opts.profileId) {
      const imageUrl = getPublicImageUrl(opts.profileId);
      const bingUrl = `https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:${encodeURIComponent(imageUrl)}`;
      const urlNav = await browserFetch("/navigate", { url: bingUrl, session_id: sessionId }, 30000);
      if (urlNav?.ok) await wait(5000);
    }

    // Extract results
    const extractResult = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        var results = [];
        // Entity name from knowledge panel
        var entity = document.querySelector('.b_entityTitle, .sbi_entityLabel, .b_lBottom .b_factrow, .entity_name');
        if (entity) results.push({ bestGuess: entity.textContent.trim(), type: 'identity_guess' });
        // Page title as identity signal
        var title = document.title || '';
        if (title.indexOf(' - Search') > 0) {
          results.push({ bestGuess: title.replace(' - Search', '').trim(), type: 'identity_guess' });
        }
        // Pages containing this image
        var links = document.querySelectorAll('.b_algo h2 a, .b_title a, .sbi_sp a, .infnmpt a');
        for (var j = 0; j < Math.min(links.length, 20); j++) {
          var a = links[j];
          var href = a.href || '';
          var realUrl = href;
          var match = href.match(/[?&]u=a1(.+?)(&|$)/);
          if (match) { try { realUrl = atob(match[1]); } catch(e) {} }
          if (realUrl && realUrl.indexOf('bing.com') === -1 && realUrl.indexOf('microsoft.com') === -1) {
            results.push({ sourceUrl: realUrl, title: a.textContent.trim().substring(0, 200), type: 'page_match' });
          }
        }
        // Visual matches
        document.querySelectorAll('.img_cont a, .imgpt a').forEach(function(a) {
          if (a.href && !a.href.includes('bing.com')) {
            results.push({ sourceUrl: a.href, title: '', type: 'visual_match' });
          }
        });
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

    const res = await fetch(candidateImageUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const candidateBuffer = Buffer.from(await res.arrayBuffer());

    const form = new FormData();
    form.append("base64_image1", originalBuffer.toString("base64"));
    form.append("base64_image2", candidateBuffer.toString("base64"));
    const compareRes = await fetch(`${FACE_API}/compare`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!compareRes.ok) return null;
    return await compareRes.json();
  } catch (_) {
    return null;
  }
}

// ── Main Search Function ──
async function searchFace(imagePath, opts = {}) {
  const allResults = [];
  const sessionId = `face-search-${Date.now()}`;

  // Create sessions — no proxy needed for direct upload approach
  await browserFetch("/session/new", { session_id: sessionId }, 15000);
  await browserFetch("/session/new", { session_id: `${sessionId}-yx` }, 15000);
  await browserFetch("/session/new", { session_id: `${sessionId}-bing` }, 15000);

  // Run searches sequentially (avoids overloading browser)
  console.log(`[face-search] Starting face search for ${opts.profileId || "unknown"} using direct upload + URL fallback`);

  const googleResults = await scrapeGoogleLens(sessionId, imagePath, opts);
  allResults.push(...googleResults);
  console.log(`[face-search] Google: ${googleResults.length} results`);

  const yandexResults = await scrapeYandexImages(`${sessionId}-yx`, imagePath, opts);
  allResults.push(...yandexResults);
  console.log(`[face-search] Yandex: ${yandexResults.length} results`);

  const bingResults = await scrapeBingVisual(`${sessionId}-bing`, imagePath, opts);
  allResults.push(...bingResults);
  console.log(`[face-search] Bing: ${bingResults.length} results`);

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

  // Extract identity guesses
  const dimensionRe = /^\d+[×x]\d+$/;
  const genericWords = new Set(["человек", "person", "people", "man", "woman", "photo", "image", "picture", "resultado"]);
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
