// Scene Analysis Module — visual context extraction from photographs
// Uses Gemini Vision API to extract intelligence signals from image content
const fs = require("fs");
const db = require("../db");

module.exports = {
  name: "scene-analysis",
  profileTypes: ["image"],

  async scan(profile, rateLimiter) {
    const findings = [];

    const image = await db.getOsintImageByProfile(profile.id);
    if (!image || !fs.existsSync(image.file_path)) {
      findings.push({
        category: "context",
        severity: "info",
        title: "Scene analysis: no image file available",
        rawData: { reason: "no_image_file" },
      });
      return findings;
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      findings.push({
        category: "context",
        severity: "info",
        title: "Scene analysis: GEMINI_API_KEY not configured",
        rawData: { reason: "no_api_key" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      const imageBuffer = fs.readFileSync(image.file_path);
      const base64 = imageBuffer.toString("base64");
      const mimeType = image.mime_type || "image/jpeg";

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                {
                  inlineData: { mimeType, data: base64 },
                },
                {
                  text: `You are an intelligence analyst performing scene analysis on a photograph. Extract ALL observable intelligence from this image. Return ONLY valid JSON with this structure:

{
  "people": {
    "count": number,
    "details": [{"estimated_age_range": "20-30", "gender": "male/female/unknown", "distinguishing_features": "description", "clothing": "description"}]
  },
  "location": {
    "indicators": ["sign text", "architecture style", "vegetation type"],
    "estimated_region": "country/city if determinable",
    "environment": "indoor/outdoor",
    "climate_clues": "tropical/temperate/etc",
    "confidence": "high/medium/low"
  },
  "organizations": {
    "logos": ["company names visible"],
    "uniforms": ["description"],
    "badges": ["text on badges"],
    "affiliations": ["inferred organizations"]
  },
  "technology": {
    "devices": ["phone model", "laptop brand"],
    "vehicles": ["make/model if visible"],
    "license_plates": ["text if readable"]
  },
  "text_ocr": {
    "signs": ["readable sign text"],
    "name_tags": ["names on badges/tags"],
    "documents": ["visible document text"],
    "other": ["any other readable text"]
  },
  "context": {
    "event_type": "conference/restaurant/office/outdoor/social/etc",
    "time_of_day": "morning/afternoon/evening/night",
    "season": "summer/winter/etc if determinable",
    "mood": "formal/casual/celebratory/etc"
  },
  "landmarks": ["recognized landmarks or notable locations"],
  "intelligence_notes": "free-form analyst observations not covered above"
}`
                },
              ],
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 4096,
            },
          }),
          signal: AbortSignal.timeout(30000),
        }
      );

      if (!res.ok) {
        findings.push({
          category: "context",
          severity: "info",
          title: "Scene analysis: Gemini API error",
          rawData: { status: res.status, reason: "api_error" },
        });
        return findings;
      }

      const data = await res.json();
      const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

      // Parse JSON from response (may be wrapped in markdown code block)
      let analysis;
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysis = JSON.parse(jsonMatch[0]);
        }
      } catch (parseErr) {
        findings.push({
          category: "context",
          severity: "info",
          title: "Scene analysis: failed to parse AI response",
          rawData: { responseText: responseText.substring(0, 500), error: parseErr.message },
        });
        return findings;
      }

      if (!analysis) return findings;

      // Generate findings from analysis
      const parts = [];

      // People
      if (analysis.people?.count > 0) {
        parts.push(`People detected: ${analysis.people.count}`);
        for (const p of (analysis.people.details || []).slice(0, 5)) {
          parts.push(`  Age: ${p.estimated_age_range || "?"}, ${p.gender || "?"}, ${p.clothing || ""}`);
        }
      }

      // Location
      if (analysis.location) {
        const loc = analysis.location;
        if (loc.estimated_region) parts.push(`Location estimate: ${loc.estimated_region} (${loc.confidence || "?"} confidence)`);
        if (loc.environment) parts.push(`Environment: ${loc.environment}`);
        if (loc.indicators?.length) parts.push(`Location clues: ${loc.indicators.join(", ")}`);
      }

      // Organizations
      if (analysis.organizations) {
        const org = analysis.organizations;
        if (org.logos?.length) parts.push(`Logos visible: ${org.logos.join(", ")}`);
        if (org.badges?.length) parts.push(`Badges: ${org.badges.join(", ")}`);
        if (org.affiliations?.length) parts.push(`Affiliations: ${org.affiliations.join(", ")}`);
      }

      // Text/OCR
      if (analysis.text_ocr) {
        const ocr = analysis.text_ocr;
        if (ocr.name_tags?.length) parts.push(`Name tags: ${ocr.name_tags.join(", ")}`);
        if (ocr.signs?.length) parts.push(`Signs: ${ocr.signs.join(", ")}`);
        if (ocr.documents?.length) parts.push(`Documents: ${ocr.documents.join(", ")}`);
      }

      // Context
      if (analysis.context) {
        parts.push(`Context: ${analysis.context.event_type || "?"}, ${analysis.context.time_of_day || "?"}`);
      }

      // Landmarks
      if (analysis.landmarks?.length) {
        parts.push(`Landmarks: ${analysis.landmarks.join(", ")}`);
      }

      const severity = (analysis.text_ocr?.name_tags?.length > 0 || analysis.location?.confidence === "high") ? "high" : "medium";

      findings.push({
        category: "context",
        severity,
        title: `Scene analysis: ${analysis.people?.count || 0} people, ${analysis.location?.estimated_region || "location unknown"}`,
        description: parts.join("\n"),
        rawData: {
          analysis,
          type: "scene_analysis",
          // Identity seeds from scene
          nameTagSeeds: analysis.text_ocr?.name_tags || [],
          locationSeeds: analysis.location ? [analysis.location.estimated_region].filter(Boolean) : [],
          orgSeeds: [
            ...(analysis.organizations?.logos || []),
            ...(analysis.organizations?.affiliations || []),
          ],
        },
      });

      // Generate specific findings for high-value intelligence
      if (analysis.text_ocr?.name_tags?.length > 0) {
        findings.push({
          category: "identity",
          severity: "high",
          title: `Scene analysis: name tag(s) detected — ${analysis.text_ocr.name_tags.join(", ")}`,
          description: `Names visible in the image: ${analysis.text_ocr.name_tags.join(", ")}. These are identity seed candidates for investigation.`,
          rawData: {
            names: analysis.text_ocr.name_tags,
            type: "name_tag_detection",
            pivotRecommended: true,
          },
        });
      }

      if (analysis.organizations?.logos?.length > 0) {
        findings.push({
          category: "context",
          severity: "medium",
          title: `Scene analysis: organization(s) identified — ${analysis.organizations.logos.join(", ")}`,
          description: `Organizations visible: ${analysis.organizations.logos.join(", ")}`,
          rawData: {
            organizations: analysis.organizations.logos,
            type: "org_detection",
          },
        });
      }

      if (analysis.location?.estimated_region && analysis.location.confidence === "high") {
        findings.push({
          category: "context",
          severity: "medium",
          title: `Scene analysis: location identified — ${analysis.location.estimated_region}`,
          description: `High-confidence location from visual clues: ${analysis.location.indicators?.join(", ") || ""}`,
          rawData: {
            location: analysis.location,
            type: "location_detection",
          },
        });
      }

      if (analysis.intelligence_notes) {
        findings.push({
          category: "context",
          severity: "info",
          title: "Scene analysis: analyst notes",
          description: analysis.intelligence_notes,
          rawData: { notes: analysis.intelligence_notes, type: "analyst_notes" },
        });
      }
    } finally {
      release();
    }

    return findings;
  },
};
