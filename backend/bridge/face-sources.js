// Face Sources — external APIs and enrichment sources for face identification
// Each source provides candidate image URLs that get biometrically verified via ArcFace
//
// Sources:
//   - Yandex (browser scraping — enhanced with scrolling + full-size URLs)
//   - Bing Visual Search (browser scraping)
//   - Wikipedia/Wikidata API (free, no auth)
//   - Google News RSS (free, no auth)
//   - SerpApi/Yandex (API — 100 free/mo)
//   - FaceCheck.ID (API — stub until prod)
//   - Search4Faces (API — stub until prod)

const fs = require("fs");
const path = require("path");

const BROWSER_API = "http://127.0.0.1:3334";

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
  } catch {
    return null;
  }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function getPublicImageUrl(profileId) {
  const bridgeUrl = process.env.BRIDGE_PUBLIC_URL || "https://home.ozzu.world/bridge";
  return `${bridgeUrl}/osint/images/${profileId}`;
}

// ═══════════════════════════════════════════════
// SOURCE 1: Yandex (browser — enhanced)
// ═══════════════════════════════════════════════

async function scrapeYandex(sessionId, imagePath, profileId) {
  const results = [];
  try {
    const nav = await browserFetch("/navigate", {
      url: "https://yandex.com/images/",
      session_id: sessionId,
    }, 30000);
    if (!nav?.ok) return results;
    await wait(2000);

    // Click camera button
    await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const btn = document.querySelector('.input__cbir-button, .HeaderDesktopForm-VisualSearch, [class*="CbirButton"]');
        if (btn) { btn.click(); return "ok"; }
        return "not_found";
      })()`,
    });
    await wait(2000);

    // Upload file
    const buf = fs.readFileSync(imagePath);
    const upload = await browserFetch("/upload-file", {
      session_id: sessionId,
      base64: buf.toString("base64"),
      filename: path.basename(imagePath),
      mime_type: "image/jpeg",
    }, 30000);

    if (!upload?.ok) {
      const imageUrl = getPublicImageUrl(profileId);
      await browserFetch("/navigate", {
        url: `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(imageUrl)}`,
        session_id: sessionId,
      }, 30000);
    }
    await wait(5000);

    // Click "Sites" tab to see pages containing this face
    await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const tabs = document.querySelectorAll('.CbirNavigation-Tab, .cbir-panel__tab, [class*="Tab"]');
        for (const tab of tabs) {
          const t = tab.textContent?.toLowerCase() || '';
          if (t.includes('site') || t.includes('сайт') || t.includes('pages')) {
            tab.click(); return 'clicked:' + t;
          }
        }
        return 'no_sites_tab';
      })()`,
    });
    await wait(3000);

    // Scroll down to load more results
    for (let i = 0; i < 3; i++) {
      await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `window.scrollTo(0, document.body.scrollHeight); "scrolled"`,
      });
      await wait(2000);
    }

    // Extract ALL image URLs — enhanced extraction
    const extract = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const results = [];
        const seen = new Set();
        function add(url, sourceUrl, label, type) {
          if (!url || seen.has(url)) return;
          seen.add(url);
          results.push({ imageUrl: url, sourceUrl: sourceUrl || '', label: label || '', type });
        }

        // 1. People/face recognition results (highest value)
        document.querySelectorAll('.CbirPeople-Item, .CbirFaces-Item').forEach(el => {
          const img = el.querySelector('img');
          const name = el.querySelector('.CbirPeople-ItemName, .CbirFaces-ItemName')?.textContent?.trim();
          const link = el.querySelector('a')?.href;
          if (img) {
            // Try data-src first (full-size), then src (thumbnail)
            add(img.getAttribute('data-src') || img.src, link, name, 'face');
          }
        });

        // 2. Sites with matching images
        document.querySelectorAll('.CbirSites-Item, .CbirSites-ItemThumb').forEach(el => {
          const item = el.closest('.CbirSites-Item') || el;
          const img = item.querySelector('img');
          const link = item.querySelector('a')?.href;
          const title = item.querySelector('.CbirSites-ItemTitle, .CbirSites-ItemDomain')?.textContent?.trim();
          if (img) {
            // Original image URL often in data-url or data-original
            const fullUrl = img.getAttribute('data-url') || img.getAttribute('data-original') || img.getAttribute('data-src') || img.src;
            add(fullUrl, link, title, 'site');
          }
        });

        // 3. Similar images
        document.querySelectorAll('.CbirOtherSizes-Item img, .similar__thumb img, .CbirRelated-Item img, .serp-item__thumb img').forEach(img => {
          const parent = img.closest('a');
          const fullUrl = img.getAttribute('data-src') || img.getAttribute('data-original') || img.src;
          add(fullUrl, parent?.href, '', 'similar');
        });

        // 4. Any remaining images on the page with external URLs
        document.querySelectorAll('img[src*="avatars.mds.yandex"]').forEach(img => {
          const parent = img.closest('a');
          add(img.src, parent?.href, '', 'yandex_thumb');
        });

        // 5. Identity guesses
        document.querySelectorAll('.CbirObjectResponse-Title, .Tags-Wrapper .Tags-Item, .CbirTags-Item, .CbirObjectResponse-Description').forEach(el => {
          const text = el.textContent?.trim();
          if (text && text.length > 1) results.push({ label: text, type: 'identity_guess' });
        });

        return JSON.stringify(results.slice(0, 150));
      })()`,
    }, 15000);

    if (extract?.result) {
      try {
        const parsed = JSON.parse(extract.result);
        for (const r of parsed) {
          if (r.imageUrl) {
            const url = r.imageUrl.startsWith("//") ? `https:${r.imageUrl}` : r.imageUrl;
            if (url.startsWith("http")) {
              results.push({ imageUrl: url, sourceUrl: r.sourceUrl || "", label: r.label || "", engine: "yandex", type: r.type });
            }
          } else if (r.type === "identity_guess") {
            results.push({ label: r.label, engine: "yandex", type: "identity_guess" });
          }
        }
      } catch {}
    }
  } catch (err) {
    console.error("[face-sources] Yandex error:", err.message);
  }
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 2: Bing Visual Search (browser)
// ═══════════════════════════════════════════════

async function scrapeBing(sessionId, imagePath, profileId) {
  const results = [];
  try {
    const nav = await browserFetch("/navigate", {
      url: "https://www.bing.com/visualsearch",
      session_id: sessionId,
    }, 30000);
    if (!nav?.ok) return results;
    await wait(2000);

    const buf = fs.readFileSync(imagePath);
    const upload = await browserFetch("/upload-file", {
      session_id: sessionId,
      base64: buf.toString("base64"),
      filename: path.basename(imagePath),
      mime_type: "image/jpeg",
    }, 30000);

    if (!upload?.ok) {
      const imageUrl = getPublicImageUrl(profileId);
      await browserFetch("/navigate", {
        url: `https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:${encodeURIComponent(imageUrl)}`,
        session_id: sessionId,
      }, 30000);
    }
    await wait(6000);

    // Scroll for more results
    for (let i = 0; i < 2; i++) {
      await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `window.scrollTo(0, document.body.scrollHeight); "scrolled"`,
      });
      await wait(2000);
    }

    const extract = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        var results = [];
        var seen = new Set();
        function add(url, src, label, type) {
          if (!url || seen.has(url)) return;
          seen.add(url);
          results.push({ imageUrl: url, sourceUrl: src || '', label: label || '', type: type });
        }

        // Entity recognition
        var entity = document.querySelector('.b_entityTitle, .sbi_entityLabel, .entity_name');
        if (entity) results.push({ label: entity.textContent.trim(), type: 'identity_guess' });

        // Image thumbnails from visual search results
        document.querySelectorAll('.img_cont img, .imgpt img, .vsc img, .richImgLnk img').forEach(function(img) {
          var src = img.getAttribute('data-src-hq') || img.getAttribute('data-src') || img.src;
          var parent = img.closest('a');
          var href = parent ? parent.href : '';
          if (src && src.indexOf('bing.com') === -1 && src.indexOf('data:') !== 0) {
            add(src, href, '', 'visual');
          }
        });

        // Page results
        document.querySelectorAll('.b_algo h2 a, .b_title a, .infnmpt a').forEach(function(a) {
          var href = a.href || '';
          if (href && href.indexOf('bing.com') === -1 && href.indexOf('microsoft.com') === -1) {
            var img = a.closest('.b_algo, .infnmpt')?.querySelector('img');
            if (img) {
              add(img.getAttribute('data-src') || img.src, href, a.textContent.trim().substring(0, 200), 'page');
            }
          }
        });

        return JSON.stringify(results.slice(0, 80));
      })()`,
    }, 15000);

    if (extract?.result) {
      try {
        const parsed = JSON.parse(extract.result);
        for (const r of parsed) {
          if (r.imageUrl) {
            results.push({ imageUrl: r.imageUrl, sourceUrl: r.sourceUrl || "", label: r.label || "", engine: "bing", type: r.type });
          } else if (r.type === "identity_guess") {
            results.push({ label: r.label, engine: "bing", type: "identity_guess" });
          }
        }
      } catch {}
    }
  } catch (err) {
    console.error("[face-sources] Bing error:", err.message);
  }
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 3: Google (browser — with CAPTCHA detection)
// ═══════════════════════════════════════════════

async function scrapeGoogle(sessionId, imagePath, profileId) {
  const results = [];
  try {
    const nav = await browserFetch("/navigate", {
      url: "https://www.google.com/imghp",
      session_id: sessionId,
    }, 30000);
    if (!nav?.ok) return results;
    await wait(2000);

    const cam = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const btn = document.querySelector('[aria-label="Search by image"], .nDcEnd, .Gdd5U, .tdmBEe');
        if (btn) { btn.click(); return "ok"; }
        return "not_found";
      })()`,
    });
    if (!cam?.result?.includes("ok")) return results;
    await wait(2000);

    const buf = fs.readFileSync(imagePath);
    const upload = await browserFetch("/upload-file", {
      session_id: sessionId,
      base64: buf.toString("base64"),
      filename: path.basename(imagePath),
      mime_type: "image/jpeg",
    }, 30000);
    if (!upload?.ok) return results;
    await wait(6000);

    // CAPTCHA check
    const captcha = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `document.title.includes('sorry') || document.title.includes('captcha') || !!document.querySelector('#captcha-form') ? 'captcha' : 'ok'`,
    });
    if (captcha?.result === "captcha") {
      console.log("[face-sources] Google CAPTCHA — skipping");
      return results;
    }

    const extract = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const results = [];
        const seen = new Set();
        // Best guess
        const guess = document.querySelector('.fKDtNb, #topstuff a, .rg_anbg')?.textContent?.trim();
        if (guess) results.push({ label: guess, type: 'identity_guess' });

        // Image results
        document.querySelectorAll('img[data-src], img.rg_i, img.YQ4gaf, .isv-r img').forEach(img => {
          const src = img.getAttribute('data-src') || img.src;
          if (src && src.startsWith('http') && !src.includes('google.com/images') && !seen.has(src)) {
            seen.add(src);
            const parent = img.closest('a');
            results.push({ imageUrl: src, sourceUrl: parent?.href || '', type: 'image' });
          }
        });

        // Page results with images
        document.querySelectorAll('#search .g, #rso .g').forEach(g => {
          const a = g.querySelector('a[href^="http"]');
          const img = g.querySelector('img');
          if (a && !a.href.includes('google.com') && img) {
            const src = img.getAttribute('data-src') || img.src;
            if (src && src.startsWith('http') && !seen.has(src)) {
              seen.add(src);
              results.push({ imageUrl: src, sourceUrl: a.href, label: g.querySelector('h3')?.textContent || '', type: 'page' });
            }
          }
        });

        return JSON.stringify(results.slice(0, 60));
      })()`,
    }, 15000);

    if (extract?.result) {
      try {
        const parsed = JSON.parse(extract.result);
        for (const r of parsed) {
          if (r.imageUrl) {
            results.push({ imageUrl: r.imageUrl, sourceUrl: r.sourceUrl || "", label: r.label || "", engine: "google", type: r.type });
          } else if (r.type === "identity_guess") {
            results.push({ label: r.label, engine: "google", type: "identity_guess" });
          }
        }
      } catch {}
    }
  } catch (err) {
    console.error("[face-sources] Google error:", err.message);
  }
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 4: Wikipedia/Wikidata API (free, no auth)
// ═══════════════════════════════════════════════

async function searchWikipedia(identityGuesses) {
  const results = [];
  if (!identityGuesses?.length) return results;

  for (const guess of identityGuesses.slice(0, 3)) {
    try {
      // Search Wikidata for entity
      const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(guess)}&language=en&format=json&limit=3&type=item`;
      const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
      if (!searchRes.ok) continue;
      const searchData = await searchRes.json();

      for (const entity of (searchData.search || []).slice(0, 2)) {
        // Get entity details including image
        const entityUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entity.id}&props=claims|sitelinks&format=json`;
        const entityRes = await fetch(entityUrl, { signal: AbortSignal.timeout(8000) });
        if (!entityRes.ok) continue;
        const entityData = await entityRes.json();
        const claims = entityData.entities?.[entity.id]?.claims || {};

        // P18 = image property
        const imageClaim = claims.P18?.[0]?.mainsnak?.datavalue?.value;
        if (imageClaim) {
          // Construct Commons URL
          const filename = imageClaim.replace(/ /g, "_");
          const md5 = await _md5(filename);
          const imageUrl = `https://upload.wikimedia.org/wikipedia/commons/${md5[0]}/${md5.slice(0, 2)}/${encodeURIComponent(filename)}`;
          results.push({
            imageUrl,
            sourceUrl: `https://www.wikidata.org/wiki/${entity.id}`,
            label: entity.label || guess,
            engine: "wikipedia",
            type: "wikidata_image",
          });
        }

        // Get Wikipedia article images
        const sitelinks = entityData.entities?.[entity.id]?.sitelinks;
        const enWiki = sitelinks?.enwiki?.title;
        if (enWiki) {
          const wikiImgUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(enWiki)}&prop=pageimages|images&piprop=original&format=json`;
          const wikiRes = await fetch(wikiImgUrl, { signal: AbortSignal.timeout(8000) });
          if (wikiRes.ok) {
            const wikiData = await wikiRes.json();
            const pages = wikiData.query?.pages || {};
            for (const page of Object.values(pages)) {
              if (page.original?.source) {
                results.push({
                  imageUrl: page.original.source,
                  sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(enWiki)}`,
                  label: enWiki,
                  engine: "wikipedia",
                  type: "wiki_main_image",
                });
              }
              // Additional images from article
              for (const img of (page.images || []).slice(0, 5)) {
                if (img.title && !img.title.includes("Commons-logo") && !img.title.includes("Wiki") && img.title.match(/\.(jpg|jpeg|png)$/i)) {
                  const imgName = img.title.replace("File:", "").replace(/ /g, "_");
                  const imgMd5 = await _md5(imgName);
                  results.push({
                    imageUrl: `https://upload.wikimedia.org/wikipedia/commons/${imgMd5[0]}/${imgMd5.slice(0, 2)}/${encodeURIComponent(imgName)}`,
                    sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(enWiki)}`,
                    label: enWiki,
                    engine: "wikipedia",
                    type: "wiki_article_image",
                  });
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[face-sources] Wikipedia error for "${guess}":`, err.message);
    }
  }
  return results;
}

// Simple MD5 for Wikimedia Commons URL construction
async function _md5(str) {
  const crypto = require("crypto");
  return crypto.createHash("md5").update(str).digest("hex");
}

// ═══════════════════════════════════════════════
// SOURCE 5: Google News RSS (free, no auth)
// ═══════════════════════════════════════════════

async function searchGoogleNews(identityGuesses) {
  const results = [];
  if (!identityGuesses?.length) return results;

  for (const guess of identityGuesses.slice(0, 2)) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(guess)}&hl=en-US&gl=US&ceid=US:en`;
      const res = await fetch(rssUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const xml = await res.text();

      // Extract article URLs from RSS
      const urlMatches = xml.matchAll(/<link>([^<]+)<\/link>/g);
      const articleUrls = [];
      for (const m of urlMatches) {
        const url = m[1].trim();
        if (url.startsWith("http") && !url.includes("news.google.com")) {
          articleUrls.push(url);
        }
      }

      // For each article, try to get OG image
      for (const articleUrl of articleUrls.slice(0, 5)) {
        try {
          const pageRes = await fetch(articleUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
            signal: AbortSignal.timeout(8000),
            redirect: "follow",
          });
          if (!pageRes.ok) continue;
          const html = await pageRes.text();

          // Extract og:image
          const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i) ||
                          html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i);
          if (ogMatch?.[1]) {
            results.push({
              imageUrl: ogMatch[1],
              sourceUrl: articleUrl,
              label: guess,
              engine: "google_news",
              type: "news_article",
            });
          }
        } catch {}
      }
    } catch (err) {
      console.error(`[face-sources] Google News error for "${guess}":`, err.message);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 6: SerpApi — Yandex Image Search (API, 100 free/mo)
// ═══════════════════════════════════════════════

async function searchSerpApi(imagePath, profileId) {
  const results = [];
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return results;

  try {
    const imageUrl = getPublicImageUrl(profileId);
    const serpUrl = `https://serpapi.com/search.json?engine=yandex_images&url=${encodeURIComponent(imageUrl)}&api_key=${apiKey}`;

    const res = await fetch(serpUrl, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      console.log(`[face-sources] SerpApi error: ${res.status}`);
      return results;
    }

    const data = await res.json();

    // Extract image results
    for (const img of (data.images_results || []).slice(0, 30)) {
      if (img.original || img.thumbnail) {
        results.push({
          imageUrl: img.original || img.thumbnail,
          sourceUrl: img.source || img.link || "",
          label: img.title || "",
          engine: "serpapi_yandex",
          type: "api_result",
        });
      }
    }

    console.log(`[face-sources] SerpApi: ${results.length} results`);
  } catch (err) {
    console.error("[face-sources] SerpApi error:", err.message);
  }
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 7: FaceCheck.ID (API — stub for prod)
// ═══════════════════════════════════════════════

async function searchFaceCheckId(imagePath) {
  const results = [];
  const apiKey = process.env.FACECHECK_API_KEY;
  if (!apiKey) return results;

  try {
    const buf = fs.readFileSync(imagePath);
    const base64 = buf.toString("base64");

    // Step 1: Submit search
    const submitRes = await fetch("https://facecheck.id/api/upload_pic", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": apiKey },
      body: JSON.stringify({ images: [`data:image/jpeg;base64,${base64}`] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!submitRes.ok) return results;
    const submitData = await submitRes.json();
    const searchId = submitData.id_search;
    if (!searchId) return results;

    // Step 2: Poll for results (up to 30s)
    for (let i = 0; i < 6; i++) {
      await wait(5000);
      const pollRes = await fetch(`https://facecheck.id/api/search_result?id_search=${searchId}`, {
        headers: { "Authorization": apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (!pollRes.ok) continue;
      const pollData = await pollRes.json();

      if (pollData.output?.items) {
        for (const item of pollData.output.items.slice(0, 30)) {
          results.push({
            imageUrl: item.image_url || item.base62 || "",
            sourceUrl: item.url || "",
            label: item.name_on_page || "",
            engine: "facecheck",
            type: "api_face_match",
            score: item.score || 0,
          });
        }
        break;
      }
    }
    console.log(`[face-sources] FaceCheck.ID: ${results.length} results`);
  } catch (err) {
    console.error("[face-sources] FaceCheck.ID error:", err.message);
  }
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 8: Search4Faces (API — stub for prod)
// ═══════════════════════════════════════════════

async function searchSearch4Faces(imagePath) {
  const results = [];
  const apiKey = process.env.SEARCH4FACES_API_KEY;
  if (!apiKey) return results;

  try {
    const buf = fs.readFileSync(imagePath);
    const base64 = buf.toString("base64");

    // Search VK + TikTok databases
    for (const source of ["vk", "tiktok", "clubhouse"]) {
      try {
        const res = await fetch("https://search4faces.com/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify({ photo: base64, source, count: 20 }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) continue;
        const data = await res.json();

        for (const item of (data.result || []).slice(0, 15)) {
          results.push({
            imageUrl: item.photo || "",
            sourceUrl: item.profile || item.url || "",
            label: `${item.first_name || ""} ${item.last_name || ""}`.trim(),
            engine: `search4faces_${source}`,
            type: "api_face_match",
            score: item.score || 0,
          });
        }
      } catch {}
    }
    console.log(`[face-sources] Search4Faces: ${results.length} results`);
  } catch (err) {
    console.error("[face-sources] Search4Faces error:", err.message);
  }
  return results;
}

// ═══════════════════════════════════════════════
// ORCHESTRATOR: Run all sources
// ═══════════════════════════════════════════════

async function collectAllCandidates(imagePath, profileId, identityGuesses = []) {
  const allResults = [];
  const sessionPrefix = `face-src-${Date.now()}`;
  const sessions = {
    yandex: `${sessionPrefix}-yx`,
    bing: `${sessionPrefix}-bing`,
    google: `${sessionPrefix}-ggl`,
  };

  // Create browser sessions in parallel
  await Promise.all([
    browserFetch("/session/new", { session_id: sessions.yandex }),
    browserFetch("/session/new", { session_id: sessions.bing }),
    browserFetch("/session/new", { session_id: sessions.google }),
  ]);

  try {
    // Run browser scrapers + API sources in parallel
    const [yandexR, bingR, googleR, wikiR, newsR, serpR, fcR, s4fR] = await Promise.allSettled([
      scrapeYandex(sessions.yandex, imagePath, profileId),
      scrapeBing(sessions.bing, imagePath, profileId),
      scrapeGoogle(sessions.google, imagePath, profileId),
      searchWikipedia(identityGuesses),
      searchGoogleNews(identityGuesses),
      searchSerpApi(imagePath, profileId),
      searchFaceCheckId(imagePath),
      searchSearch4Faces(imagePath),
    ]);

    const sources = { yandex: 0, bing: 0, google: 0, wikipedia: 0, google_news: 0, serpapi: 0, facecheck: 0, search4faces: 0 };

    for (const [name, result] of [
      ["yandex", yandexR], ["bing", bingR], ["google", googleR],
      ["wikipedia", wikiR], ["google_news", newsR], ["serpapi", serpR],
      ["facecheck", fcR], ["search4faces", s4fR],
    ]) {
      if (result.status === "fulfilled" && result.value?.length) {
        allResults.push(...result.value);
        sources[name] = result.value.filter(r => r.imageUrl).length;
      }
    }

    console.log(`[face-sources] Total candidates: ${allResults.length} | ${Object.entries(sources).filter(([,v]) => v > 0).map(([k,v]) => `${k}=${v}`).join(", ")}`);

    return { candidates: allResults, sources };
  } finally {
    // Clean up browser sessions
    await Promise.all(Object.values(sessions).map(s =>
      browserFetch("/session/close", { session_id: s }).catch(() => {})
    ));
  }
}

module.exports = {
  scrapeYandex,
  scrapeBing,
  scrapeGoogle,
  searchWikipedia,
  searchGoogleNews,
  searchSerpApi,
  searchFaceCheckId,
  searchSearch4Faces,
  collectAllCandidates,
};
