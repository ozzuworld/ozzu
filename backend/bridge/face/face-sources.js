// Face Sources — high-volume candidate collection for face identification
// Goal: 300+ candidates per target, not 40
//
// Sources:
//   REVERSE IMAGE (upload photo, find where it appears):
//     - Yandex reverse image (browser — deep scroll + pagination)
//     - Bing Visual Search (browser — deep scroll)
//     - Google Lens (browser — CAPTCHA detection)
//   NAME-BASED IMAGE SEARCH (once identity guessed, search by name):
//     - Yandex image search by name
//     - Bing image search by name
//   ENRICHMENT (free APIs):
//     - Wikipedia/Wikidata + Wikimedia Commons deep category search
//     - Google News RSS → OG images
//   SOCIAL MEDIA (browser scraping):
//     - Twitter/X profile + media tab
//     - Instagram profile (public, no login)
//   PAID APIs (stubs until keys added):
//     - SerpApi, FaceCheck.ID, Search4Faces

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
// SOURCE 1: Yandex Reverse Image (browser — DEEP)
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

    // Click "Sites" tab
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

    // DEEP SCROLL — 15 iterations instead of 3
    for (let i = 0; i < 15; i++) {
      await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `window.scrollTo(0, document.body.scrollHeight); "scrolled"`,
      });
      await wait(1500);
    }

    // Click "Show more" / "More results" buttons if present
    await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const btns = document.querySelectorAll('.CbirSites-MoreButton, .Button2, button, [class*="More"]');
        let clicked = 0;
        for (const b of btns) {
          const t = b.textContent?.toLowerCase() || '';
          if (t.includes('more') || t.includes('ещё') || t.includes('показать') || t.includes('show')) {
            b.click(); clicked++;
          }
        }
        return 'clicked:' + clicked;
      })()`,
    });
    await wait(3000);

    // Scroll more after loading
    for (let i = 0; i < 5; i++) {
      await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `window.scrollTo(0, document.body.scrollHeight); "scrolled"`,
      });
      await wait(1500);
    }

    // Extract ALL results — NO CAP
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

        // 1. People/face recognition results
        document.querySelectorAll('.CbirPeople-Item, .CbirFaces-Item').forEach(el => {
          const img = el.querySelector('img');
          const name = el.querySelector('.CbirPeople-ItemName, .CbirFaces-ItemName')?.textContent?.trim();
          const link = el.querySelector('a')?.href;
          if (img) add(img.getAttribute('data-src') || img.src, link, name, 'face');
        });

        // 2. Sites with matching images
        document.querySelectorAll('.CbirSites-Item, .CbirSites-ItemThumb').forEach(el => {
          const item = el.closest('.CbirSites-Item') || el;
          const img = item.querySelector('img');
          const link = item.querySelector('a')?.href;
          const title = item.querySelector('.CbirSites-ItemTitle, .CbirSites-ItemDomain')?.textContent?.trim();
          if (img) {
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

        // 4. ALL thumbnails on page
        document.querySelectorAll('img[src*="avatars.mds.yandex"]').forEach(img => {
          const parent = img.closest('a');
          add(img.src, parent?.href, '', 'yandex_thumb');
        });

        // 5. Identity guesses
        document.querySelectorAll('.CbirObjectResponse-Title, .Tags-Wrapper .Tags-Item, .CbirTags-Item, .CbirObjectResponse-Description').forEach(el => {
          const text = el.textContent?.trim();
          if (text && text.length > 1) results.push({ label: text, type: 'identity_guess' });
        });

        return JSON.stringify(results);
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
  console.log(`[face-sources] Yandex reverse: ${results.filter(r => r.imageUrl).length} images`);
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 2: Bing Visual Search (browser — DEEP)
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

    // DEEP SCROLL — 10 iterations
    for (let i = 0; i < 10; i++) {
      await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `window.scrollTo(0, document.body.scrollHeight); "scrolled"`,
      });
      await wait(1500);
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

        // All image results
        document.querySelectorAll('.img_cont img, .imgpt img, .vsc img, .richImgLnk img, .iusc img, .mimg').forEach(function(img) {
          var src = img.getAttribute('data-src-hq') || img.getAttribute('data-src') || img.getAttribute('src2') || img.src;
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

        return JSON.stringify(results);
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
  console.log(`[face-sources] Bing visual: ${results.filter(r => r.imageUrl).length} images`);
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 3: Google Lens (browser — CAPTCHA detection)
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

    // Deep scroll
    for (let i = 0; i < 8; i++) {
      await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `window.scrollTo(0, document.body.scrollHeight); "scrolled"`,
      });
      await wait(1500);
    }

    const extract = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const results = [];
        const seen = new Set();
        const guess = document.querySelector('.fKDtNb, #topstuff a, .rg_anbg')?.textContent?.trim();
        if (guess) results.push({ label: guess, type: 'identity_guess' });

        document.querySelectorAll('img[data-src], img.rg_i, img.YQ4gaf, .isv-r img').forEach(img => {
          const src = img.getAttribute('data-src') || img.src;
          if (src && src.startsWith('http') && !src.includes('google.com/images') && !seen.has(src)) {
            seen.add(src);
            const parent = img.closest('a');
            results.push({ imageUrl: src, sourceUrl: parent?.href || '', type: 'image' });
          }
        });

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

        return JSON.stringify(results);
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
  console.log(`[face-sources] Google lens: ${results.filter(r => r.imageUrl).length} images`);
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 4: Yandex NAME-BASED Image Search (NEW)
// Once we know who the person is, search by name
// ═══════════════════════════════════════════════

async function searchYandexByName(sessionId, identityGuesses) {
  const results = [];
  if (!identityGuesses?.length) return results;

  for (const name of identityGuesses.slice(0, 3)) {
    try {
      await browserFetch("/navigate", {
        url: `https://yandex.com/images/search?text=${encodeURIComponent(name)}`,
        session_id: sessionId,
      }, 30000);
      await wait(4000);

      // Deep scroll to load many results
      for (let i = 0; i < 12; i++) {
        await browserFetch("/evaluate", {
          session_id: sessionId,
          script: `window.scrollTo(0, document.body.scrollHeight); "scrolled"`,
        });
        await wait(1500);
      }

      const extract = await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `(() => {
          const results = [];
          const seen = new Set();
          document.querySelectorAll('.serp-item, .serp-item__thumb, .justifier__item').forEach(item => {
            const img = item.querySelector('img');
            if (!img) return;
            const src = img.getAttribute('data-src') || img.getAttribute('src');
            if (!src || seen.has(src)) return;
            seen.add(src);

            // Try to get full-size URL from data attributes
            let fullUrl = src;
            try {
              const dataStr = item.getAttribute('data-bem');
              if (dataStr) {
                const data = JSON.parse(dataStr);
                const serpItem = data['serp-item'] || {};
                if (serpItem.img_href) fullUrl = serpItem.img_href;
              }
            } catch {}

            const link = item.querySelector('a');
            results.push({
              imageUrl: fullUrl.startsWith('//') ? 'https:' + fullUrl : fullUrl,
              sourceUrl: link?.href || '',
              type: 'name_search'
            });
          });
          return JSON.stringify(results);
        })()`,
      }, 15000);

      if (extract?.result) {
        try {
          const parsed = JSON.parse(extract.result);
          for (const r of parsed) {
            if (r.imageUrl && r.imageUrl.startsWith("http")) {
              results.push({ imageUrl: r.imageUrl, sourceUrl: r.sourceUrl || "", label: name, engine: "yandex_name", type: r.type });
            }
          }
        } catch {}
      }
    } catch (err) {
      console.error(`[face-sources] Yandex name search error for "${name}":`, err.message);
    }
  }
  console.log(`[face-sources] Yandex name search: ${results.length} images`);
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 5: Bing NAME-BASED Image Search (NEW)
// ═══════════════════════════════════════════════

async function searchBingByName(sessionId, identityGuesses) {
  const results = [];
  if (!identityGuesses?.length) return results;

  for (const name of identityGuesses.slice(0, 3)) {
    try {
      await browserFetch("/navigate", {
        url: `https://www.bing.com/images/search?q=${encodeURIComponent(name)}&qft=+filterui:face-face`,
        session_id: sessionId,
      }, 30000);
      await wait(4000);

      // Deep scroll
      for (let i = 0; i < 10; i++) {
        await browserFetch("/evaluate", {
          session_id: sessionId,
          script: `window.scrollTo(0, document.body.scrollHeight); "scrolled"`,
        });
        await wait(1500);
      }

      const extract = await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `(() => {
          var results = [];
          var seen = new Set();
          document.querySelectorAll('.iusc, .imgpt, .img_cont').forEach(function(item) {
            try {
              var mStr = item.getAttribute('m') || item.getAttribute('data-m');
              if (mStr) {
                var m = JSON.parse(mStr);
                var url = m.murl || m.imgUrl;
                if (url && !seen.has(url)) {
                  seen.add(url);
                  results.push({ imageUrl: url, sourceUrl: m.purl || m.ru || '', type: 'name_search' });
                }
              }
            } catch {}
            // Fallback: get img src
            var img = item.querySelector('img');
            if (img) {
              var src = img.getAttribute('data-src') || img.src;
              if (src && src.startsWith('http') && !src.includes('bing.com') && !seen.has(src)) {
                seen.add(src);
                results.push({ imageUrl: src, sourceUrl: '', type: 'name_search' });
              }
            }
          });
          return JSON.stringify(results);
        })()`,
      }, 15000);

      if (extract?.result) {
        try {
          const parsed = JSON.parse(extract.result);
          for (const r of parsed) {
            if (r.imageUrl && r.imageUrl.startsWith("http")) {
              results.push({ imageUrl: r.imageUrl, sourceUrl: r.sourceUrl || "", label: name, engine: "bing_name", type: r.type });
            }
          }
        } catch {}
      }
    } catch (err) {
      console.error(`[face-sources] Bing name search error for "${name}":`, err.message);
    }
  }
  console.log(`[face-sources] Bing name search: ${results.length} images`);
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 6: Twitter/X Profile Scraping (NEW)
// ═══════════════════════════════════════════════

async function scrapeTwitter(sessionId, identityGuesses) {
  const results = [];
  if (!identityGuesses?.length) return results;

  for (const name of identityGuesses.slice(0, 2)) {
    try {
      // Search Twitter for the person's name + photos
      const searchQuery = encodeURIComponent(`${name} filter:images`);
      await browserFetch("/navigate", {
        url: `https://nitter.net/search?f=tweets&q=${searchQuery}`,
        session_id: sessionId,
      }, 30000);
      await wait(4000);

      // Scroll to load more
      for (let i = 0; i < 5; i++) {
        await browserFetch("/evaluate", {
          session_id: sessionId,
          script: `window.scrollTo(0, document.body.scrollHeight); "scrolled"`,
        });
        await wait(2000);
      }

      const extract = await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `(() => {
          const results = [];
          const seen = new Set();
          // Nitter shows images inline
          document.querySelectorAll('.still-image, .attachment img, .timeline-item img').forEach(el => {
            let src = el.getAttribute('href') || el.getAttribute('data-src') || el.src;
            if (!src) return;
            // Convert nitter image proxy to original twitter URL if possible
            if (src.startsWith('/pic/')) src = 'https://pbs.twimg.com' + src.replace('/pic', '');
            if (src.startsWith('http') && !seen.has(src)) {
              seen.add(src);
              const tweet = el.closest('.timeline-item');
              const link = tweet?.querySelector('.tweet-link')?.getAttribute('href');
              results.push({ imageUrl: src, sourceUrl: link ? 'https://twitter.com' + link : '', type: 'twitter' });
            }
          });
          // Also get profile pictures
          document.querySelectorAll('.tweet-avatar img, .profile-card-avatar img').forEach(img => {
            const src = img.src;
            if (src && src.startsWith('http') && !seen.has(src)) {
              seen.add(src);
              results.push({ imageUrl: src, sourceUrl: '', type: 'twitter_avatar' });
            }
          });
          return JSON.stringify(results);
        })()`,
      }, 15000);

      if (extract?.result) {
        try {
          const parsed = JSON.parse(extract.result);
          for (const r of parsed) {
            if (r.imageUrl && r.imageUrl.startsWith("http")) {
              results.push({ imageUrl: r.imageUrl, sourceUrl: r.sourceUrl || "", label: name, engine: "twitter", type: r.type });
            }
          }
        } catch {}
      }

      // Also try direct profile if name looks like it could be a handle
      const handle = name.toLowerCase().replace(/\s+/g, "");
      await browserFetch("/navigate", {
        url: `https://nitter.net/${handle}/media`,
        session_id: sessionId,
      }, 20000);
      await wait(3000);

      for (let i = 0; i < 5; i++) {
        await browserFetch("/evaluate", {
          session_id: sessionId,
          script: `window.scrollTo(0, document.body.scrollHeight); "scrolled"`,
        });
        await wait(1500);
      }

      const mediaExtract = await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `(() => {
          const results = [];
          const seen = new Set();
          document.querySelectorAll('.still-image, .attachment img, .gallery-row img').forEach(el => {
            let src = el.getAttribute('href') || el.getAttribute('data-src') || el.src;
            if (!src) return;
            if (src.startsWith('/pic/')) src = 'https://pbs.twimg.com' + src.replace('/pic', '');
            if (src.startsWith('http') && !seen.has(src)) {
              seen.add(src);
              results.push({ imageUrl: src, type: 'twitter_media' });
            }
          });
          return JSON.stringify(results);
        })()`,
      }, 15000);

      if (mediaExtract?.result) {
        try {
          const parsed = JSON.parse(mediaExtract.result);
          for (const r of parsed) {
            if (r.imageUrl && r.imageUrl.startsWith("http")) {
              results.push({ imageUrl: r.imageUrl, sourceUrl: "", label: name, engine: "twitter", type: r.type });
            }
          }
        } catch {}
      }
    } catch (err) {
      console.error(`[face-sources] Twitter error for "${name}":`, err.message);
    }
  }
  console.log(`[face-sources] Twitter: ${results.length} images`);
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 7: Instagram Public Profile (NEW)
// ═══════════════════════════════════════════════

async function scrapeInstagram(sessionId, identityGuesses) {
  const results = [];
  if (!identityGuesses?.length) return results;

  for (const name of identityGuesses.slice(0, 2)) {
    try {
      const handle = name.toLowerCase().replace(/\s+/g, "");
      await browserFetch("/navigate", {
        url: `https://www.instagram.com/${handle}/`,
        session_id: sessionId,
      }, 30000);
      await wait(5000);

      // Check if page loaded (not login wall)
      const check = await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `(() => {
          if (document.querySelector('[data-testid="login-form"]') || document.title.includes('Login')) return 'login_wall';
          if (document.title.includes('not found') || document.title.includes('404')) return 'not_found';
          return 'ok';
        })()`,
      });
      if (check?.result !== "ok") continue;

      // Scroll to load posts
      for (let i = 0; i < 8; i++) {
        await browserFetch("/evaluate", {
          session_id: sessionId,
          script: `window.scrollTo(0, document.body.scrollHeight); "scrolled"`,
        });
        await wait(2000);
      }

      const extract = await browserFetch("/evaluate", {
        session_id: sessionId,
        script: `(() => {
          const results = [];
          const seen = new Set();
          // Profile picture
          document.querySelectorAll('img[alt*="profile"], header img').forEach(img => {
            const src = img.src;
            if (src && !seen.has(src)) {
              seen.add(src);
              results.push({ imageUrl: src, type: 'instagram_profile' });
            }
          });
          // Post images
          document.querySelectorAll('article img, ._aagv img, ._aagt img').forEach(img => {
            const src = img.src;
            if (src && src.startsWith('http') && !seen.has(src)) {
              seen.add(src);
              const link = img.closest('a')?.href;
              results.push({ imageUrl: src, sourceUrl: link || '', type: 'instagram_post' });
            }
          });
          return JSON.stringify(results);
        })()`,
      }, 15000);

      if (extract?.result) {
        try {
          const parsed = JSON.parse(extract.result);
          for (const r of parsed) {
            if (r.imageUrl && r.imageUrl.startsWith("http")) {
              results.push({ imageUrl: r.imageUrl, sourceUrl: r.sourceUrl || "", label: name, engine: "instagram", type: r.type });
            }
          }
        } catch {}
      }
    } catch (err) {
      console.error(`[face-sources] Instagram error for "${name}":`, err.message);
    }
  }
  console.log(`[face-sources] Instagram: ${results.length} images`);
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 8: Wikipedia + Wikimedia Commons DEEP (enhanced)
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
        const entityUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entity.id}&props=claims|sitelinks&format=json`;
        const entityRes = await fetch(entityUrl, { signal: AbortSignal.timeout(8000) });
        if (!entityRes.ok) continue;
        const entityData = await entityRes.json();
        const claims = entityData.entities?.[entity.id]?.claims || {};

        // P18 = image
        const imageClaim = claims.P18?.[0]?.mainsnak?.datavalue?.value;
        if (imageClaim) {
          const filename = imageClaim.replace(/ /g, "_");
          const md5 = await _md5(filename);
          results.push({
            imageUrl: `https://upload.wikimedia.org/wikipedia/commons/${md5[0]}/${md5.slice(0, 2)}/${encodeURIComponent(filename)}`,
            sourceUrl: `https://www.wikidata.org/wiki/${entity.id}`,
            label: entity.label || guess,
            engine: "wikipedia",
            type: "wikidata_image",
          });
        }

        // Get Wikipedia article + ALL images (not capped at 5)
        const sitelinks = entityData.entities?.[entity.id]?.sitelinks;
        const enWiki = sitelinks?.enwiki?.title;
        if (enWiki) {
          // Get main page image
          const wikiImgUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(enWiki)}&prop=pageimages|images&piprop=original&imlimit=50&format=json`;
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
              // ALL article images (removed the .slice(0, 5) cap)
              for (const img of (page.images || [])) {
                if (img.title && !img.title.includes("Commons-logo") && !img.title.includes("Wiki") && !img.title.includes("Flag_of") && !img.title.includes("Icon") && img.title.match(/\.(jpg|jpeg|png)$/i)) {
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

          // NEW: Search Wikimedia Commons category for this person
          await _searchCommonsCategory(guess, results);
        }
      }
    } catch (err) {
      console.error(`[face-sources] Wikipedia error for "${guess}":`, err.message);
    }
  }
  console.log(`[face-sources] Wikipedia + Commons: ${results.length} images`);
  return results;
}

// Search Wikimedia Commons for all images in a person's category
async function _searchCommonsCategory(personName, results) {
  try {
    // Search Commons for categories matching the person
    const catSearchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(personName)}&srnamespace=14&srlimit=3&format=json`;
    const catRes = await fetch(catSearchUrl, { signal: AbortSignal.timeout(8000) });
    if (!catRes.ok) return;
    const catData = await catRes.json();

    for (const cat of (catData.query?.search || []).slice(0, 2)) {
      const catTitle = cat.title; // e.g., "Category:Elon Musk"

      // Get all files in this category
      const filesUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent(catTitle)}&cmtype=file&cmlimit=100&format=json`;
      const filesRes = await fetch(filesUrl, { signal: AbortSignal.timeout(10000) });
      if (!filesRes.ok) continue;
      const filesData = await filesRes.json();

      for (const file of (filesData.query?.categorymembers || [])) {
        if (file.title && file.title.match(/\.(jpg|jpeg|png)$/i)) {
          const imgName = file.title.replace("File:", "").replace(/ /g, "_");
          const imgMd5 = await _md5(imgName);
          results.push({
            imageUrl: `https://upload.wikimedia.org/wikipedia/commons/${imgMd5[0]}/${imgMd5.slice(0, 2)}/${encodeURIComponent(imgName)}`,
            sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(file.title)}`,
            label: personName,
            engine: "wikimedia_commons",
            type: "commons_category",
          });
        }
      }
    }
  } catch (err) {
    console.error(`[face-sources] Commons category error:`, err.message);
  }
}

async function _md5(str) {
  const crypto = require("crypto");
  return crypto.createHash("md5").update(str).digest("hex");
}

// ═══════════════════════════════════════════════
// SOURCE 9: Google News RSS (free, no auth)
// ═══════════════════════════════════════════════

async function searchGoogleNews(identityGuesses) {
  const results = [];
  if (!identityGuesses?.length) return results;

  for (const guess of identityGuesses.slice(0, 3)) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(guess)}&hl=en-US&gl=US&ceid=US:en`;
      const res = await fetch(rssUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const xml = await res.text();

      const urlMatches = xml.matchAll(/<link>([^<]+)<\/link>/g);
      const articleUrls = [];
      for (const m of urlMatches) {
        const url = m[1].trim();
        if (url.startsWith("http") && !url.includes("news.google.com")) {
          articleUrls.push(url);
        }
      }

      // Check MORE articles — 15 instead of 5
      for (const articleUrl of articleUrls.slice(0, 15)) {
        try {
          const pageRes = await fetch(articleUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
            signal: AbortSignal.timeout(8000),
            redirect: "follow",
          });
          if (!pageRes.ok) continue;
          const html = await pageRes.text();

          // Extract og:image AND twitter:image AND any large images
          const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i) ||
                          html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i);
          const twitterMatch = html.match(/<meta[^>]*name="twitter:image"[^>]*content="([^"]+)"/i) ||
                               html.match(/<meta[^>]*content="([^"]+)"[^>]*name="twitter:image"/i);

          const seen = new Set();
          for (const match of [ogMatch, twitterMatch]) {
            if (match?.[1] && !seen.has(match[1])) {
              seen.add(match[1]);
              results.push({
                imageUrl: match[1],
                sourceUrl: articleUrl,
                label: guess,
                engine: "google_news",
                type: "news_article",
              });
            }
          }
        } catch {}
      }
    } catch (err) {
      console.error(`[face-sources] Google News error for "${guess}":`, err.message);
    }
  }
  console.log(`[face-sources] Google News: ${results.length} images`);
  return results;
}

// ═══════════════════════════════════════════════
// SOURCE 10: SerpApi (100 free/mo)
// ═══════════════════════════════════════════════

async function searchSerpApi(imagePath, profileId) {
  const results = [];
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return results;

  try {
    const imageUrl = getPublicImageUrl(profileId);
    const serpUrl = `https://serpapi.com/search.json?engine=yandex_images&url=${encodeURIComponent(imageUrl)}&api_key=${apiKey}`;

    const res = await fetch(serpUrl, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return results;
    const data = await res.json();

    // No cap — take all results
    for (const img of (data.images_results || [])) {
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
// SOURCE 11: FaceCheck.ID (API — stub for prod)
// ═══════════════════════════════════════════════

async function searchFaceCheckId(imagePath) {
  const results = [];
  const apiKey = process.env.FACECHECK_API_KEY;
  if (!apiKey) return results;

  try {
    const buf = fs.readFileSync(imagePath);
    const base64 = buf.toString("base64");

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

    for (let i = 0; i < 6; i++) {
      await wait(5000);
      const pollRes = await fetch(`https://facecheck.id/api/search_result?id_search=${searchId}`, {
        headers: { "Authorization": apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (!pollRes.ok) continue;
      const pollData = await pollRes.json();

      if (pollData.output?.items) {
        for (const item of pollData.output.items) {
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
// SOURCE 12: Search4Faces (API — stub for prod)
// ═══════════════════════════════════════════════

async function searchSearch4Faces(imagePath) {
  const results = [];
  const apiKey = process.env.SEARCH4FACES_API_KEY;
  if (!apiKey) return results;

  try {
    const buf = fs.readFileSync(imagePath);
    const base64 = buf.toString("base64");

    for (const source of ["vk", "tiktok", "clubhouse"]) {
      try {
        const res = await fetch("https://search4faces.com/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify({ photo: base64, source, count: 50 }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) continue;
        const data = await res.json();

        for (const item of (data.result || [])) {
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
// ORCHESTRATOR: Run ALL sources — two phases
// Phase A: Reverse image search (parallel)
// Phase B: Name-based search + social media (needs identity guesses from Phase A)
// ═══════════════════════════════════════════════

async function collectAllCandidates(imagePath, profileId, identityGuesses = []) {
  const allResults = [];
  const sessionPrefix = `face-src-${Date.now()}`;
  const sessions = {
    yandex: `${sessionPrefix}-yx`,
    bing: `${sessionPrefix}-bing`,
    google: `${sessionPrefix}-ggl`,
    yandexName: `${sessionPrefix}-yxn`,
    bingName: `${sessionPrefix}-bng`,
    twitter: `${sessionPrefix}-tw`,
    instagram: `${sessionPrefix}-ig`,
  };

  // Create ALL browser sessions upfront
  await Promise.all(
    Object.values(sessions).map(s => browserFetch("/session/new", { session_id: s }))
  );

  const sources = {
    yandex: 0, bing: 0, google: 0, yandex_name: 0, bing_name: 0,
    twitter: 0, instagram: 0,
    wikipedia: 0, wikimedia_commons: 0, google_news: 0,
    serpapi: 0, facecheck: 0, search4faces: 0,
  };

  try {
    // ── PHASE A: Reverse image search + API sources (parallel) ──
    console.log("[face-sources] Phase A: Reverse image search...");
    const [yandexR, bingR, googleR, serpR, fcR, s4fR] = await Promise.allSettled([
      scrapeYandex(sessions.yandex, imagePath, profileId),
      scrapeBing(sessions.bing, imagePath, profileId),
      scrapeGoogle(sessions.google, imagePath, profileId),
      searchSerpApi(imagePath, profileId),
      searchFaceCheckId(imagePath),
      searchSearch4Faces(imagePath),
    ]);

    for (const [name, result] of [
      ["yandex", yandexR], ["bing", bingR], ["google", googleR],
      ["serpapi", serpR], ["facecheck", fcR], ["search4faces", s4fR],
    ]) {
      if (result.status === "fulfilled" && result.value?.length) {
        allResults.push(...result.value);
        sources[name] = result.value.filter(r => r.imageUrl).length;
      }
    }

    // ── Collect identity guesses from Phase A ──
    const dimRe = /^\d+[×x]\d+$/;
    const genericWords = new Set(["человек", "person", "people", "man", "woman", "photo", "image", "picture"]);
    const phaseAGuesses = [];
    for (const r of allResults) {
      if (r.type === "identity_guess" && r.label) phaseAGuesses.push(r.label);
    }
    const allGuesses = [...new Set([...identityGuesses, ...phaseAGuesses])]
      .filter(g => g && !dimRe.test(g) && !genericWords.has(g.toLowerCase()) && g.length > 2);

    console.log(`[face-sources] Phase A complete: ${allResults.filter(r => r.imageUrl).length} images | Guesses: ${allGuesses.join(", ") || "none"}`);

    // ── PHASE B: Name-based search + social media + enrichment (parallel) ──
    if (allGuesses.length > 0) {
      console.log("[face-sources] Phase B: Name-based + social + enrichment...");
      const [yxNameR, bingNameR, twitterR, igR, wikiR, newsR] = await Promise.allSettled([
        searchYandexByName(sessions.yandexName, allGuesses),
        searchBingByName(sessions.bingName, allGuesses),
        scrapeTwitter(sessions.twitter, allGuesses),
        scrapeInstagram(sessions.instagram, allGuesses),
        searchWikipedia(allGuesses),
        searchGoogleNews(allGuesses),
      ]);

      for (const [name, result] of [
        ["yandex_name", yxNameR], ["bing_name", bingNameR],
        ["twitter", twitterR], ["instagram", igR],
        ["wikipedia", wikiR], ["google_news", newsR],
      ]) {
        if (result.status === "fulfilled" && result.value?.length) {
          allResults.push(...result.value);
          // Split wikipedia vs commons
          if (name === "wikipedia") {
            sources.wikipedia = result.value.filter(r => r.engine === "wikipedia").length;
            sources.wikimedia_commons = result.value.filter(r => r.engine === "wikimedia_commons").length;
          } else {
            sources[name] = result.value.filter(r => r.imageUrl).length;
          }
        }
      }
    }

    const totalImages = allResults.filter(r => r.imageUrl).length;
    console.log(`[face-sources] TOTAL: ${totalImages} candidates | ${Object.entries(sources).filter(([,v]) => v > 0).map(([k,v]) => `${k}=${v}`).join(", ")}`);

    return { candidates: allResults, sources };
  } finally {
    // Clean up ALL browser sessions
    await Promise.all(
      Object.values(sessions).map(s => browserFetch("/session/close", { session_id: s }).catch(() => {}))
    );
  }
}

module.exports = {
  scrapeYandex,
  scrapeBing,
  scrapeGoogle,
  searchYandexByName,
  searchBingByName,
  scrapeTwitter,
  scrapeInstagram,
  searchWikipedia,
  searchGoogleNews,
  searchSerpApi,
  searchFaceCheckId,
  searchSearch4Faces,
  collectAllCandidates,
};
