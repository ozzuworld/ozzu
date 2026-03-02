// Colombian OSINT: Procuraduría General de la Nación — Disciplinary records
// Source: apps.procuraduria.gov.co/webcert/Certificado.aspx — disciplinary background
// Access: ASPX form with security questions (not reCAPTCHA). Requires 2-step postback.
// Also: CNDJ (antecedentesdisciplinarios.cndj.gov.co) for lawyer-specific sanctions
const { validateCedula, safeFetch, CO_HEADERS, extractAspxFields } = require("./co-utils");

const CERT_URL = "https://apps.procuraduria.gov.co/webcert/Certificado.aspx";
const CNDJ_API = "https://api-antecedentesdisciplinarios.cndj.gov.co";

module.exports = {
  name: "co-procuraduria",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Procuraduría: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    // Strategy 1: Try ASPX form with ViewState + security question bypass
    const release1 = await rateLimiter.acquire();
    let aspxFields = null;
    let sessionCookies = "";
    let pageHtml = "";
    try {
      const pageRes = await safeFetch(CERT_URL, { method: "GET" });
      if (pageRes.ok && typeof pageRes.body === "string") {
        pageHtml = pageRes.body;
        aspxFields = extractAspxFields(pageHtml);
        sessionCookies = pageRes.cookies || "";
      }
    } catch (e) {
      // Continue
    } finally {
      release1();
    }

    if (aspxFields && aspxFields.__VIEWSTATE) {
      // Step 2: Submit the form — the security question is generated server-side
      // We need to do a postback to get the question, then answer it
      const release2 = await rateLimiter.acquire();
      try {
        // First postback: select document type + enter number to trigger question generation
        const formData = new URLSearchParams();
        formData.append("__VIEWSTATE", aspxFields.__VIEWSTATE);
        if (aspxFields.__VIEWSTATEGENERATOR) formData.append("__VIEWSTATEGENERATOR", aspxFields.__VIEWSTATEGENERATOR);
        if (aspxFields.__EVENTVALIDATION) formData.append("__EVENTVALIDATION", aspxFields.__EVENTVALIDATION);
        formData.append("ddlTipoID", "1"); // 1=Cédula de ciudadanía
        formData.append("txtNumID", cedula);
        formData.append("rblTipoCert", "1"); // Ordinario
        formData.append("foo", "");
        // Simulate button click
        formData.append("btnConsultar", "Consultar");

        const res = await safeFetch(CERT_URL, {
          method: "POST",
          headers: {
            ...CO_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: CERT_URL,
            Origin: "https://apps.procuraduria.gov.co",
            Cookie: sessionCookies,
          },
          body: formData.toString(),
        }, 20000);

        if (res.ok && typeof res.body === "string") {
          const html = res.body;
          const lower = html.toLowerCase();

          // Check if we got a question (needs answer) or a direct result
          const questionMatch = html.match(/<span id="lblPregunta">([^<]+)<\/span>/);

          if (questionMatch && questionMatch[1].trim()) {
            // Security question received — try to solve it (usually simple math)
            const question = questionMatch[1].trim();
            const answer = solveMathQuestion(question);

            if (answer !== null) {
              // Extract new ViewState from the response
              const newFields = extractAspxFields(html);
              const newCookies = res.cookies || sessionCookies;

              const release3 = await rateLimiter.acquire();
              try {
                const answerForm = new URLSearchParams();
                answerForm.append("__VIEWSTATE", newFields.__VIEWSTATE || "");
                if (newFields.__VIEWSTATEGENERATOR) answerForm.append("__VIEWSTATEGENERATOR", newFields.__VIEWSTATEGENERATOR);
                if (newFields.__EVENTVALIDATION) answerForm.append("__EVENTVALIDATION", newFields.__EVENTVALIDATION);
                answerForm.append("ddlTipoID", "1"); // 1=Cédula de ciudadanía
                answerForm.append("txtNumID", cedula);
                answerForm.append("rblTipoCert", "1");
                answerForm.append("txtRespuestaPregunta", String(answer));
                answerForm.append("foo", "");
                answerForm.append("btnConsultar", "Consultar");

                const answerRes = await safeFetch(CERT_URL, {
                  method: "POST",
                  headers: {
                    ...CO_HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded",
                    Referer: CERT_URL,
                    Origin: "https://apps.procuraduria.gov.co",
                    Cookie: newCookies,
                  },
                  body: answerForm.toString(),
                }, 20000);

                if (answerRes.ok && typeof answerRes.body === "string") {
                  const resultHtml = answerRes.body;
                  const parsed = parseProcuraduriaResult(resultHtml, cedula);
                  if (parsed) {
                    findings.push(parsed);
                    return findings;
                  }
                }
              } finally {
                release3();
              }
            }

            // Couldn't solve the question or answer failed
            findings.push({
              category: "exposure",
              severity: "info",
              title: "Procuraduría: Security question required",
              description: [
                `The Procuraduría website requires answering a security question to view results.`,
                `Question: "${question}"`,
                `Check disciplinary records for CC: ${cedula} manually.`,
              ].join("\n"),
              sourceUrl: CERT_URL,
              rawData: { searched: cedula, question, reason: "security_question" },
              remediation: "Visit https://apps.procuraduria.gov.co/webcert/Certificado.aspx — enter cédula, answer the security question, and click Consultar.",
            });
            return findings;
          }

          // Check if we got a direct result (no question)
          const parsed = parseProcuraduriaResult(html, cedula);
          if (parsed) {
            findings.push(parsed);
            return findings;
          }
        }
      } catch (err) {
        // Continue to fallback
      } finally {
        release2();
      }
    }

    // Strategy 2: Try CNDJ API (works for lawyers/judicial staff)
    const release4 = await rateLimiter.acquire();
    try {
      const res = await safeFetch(
        `${CNDJ_API}/certificate/?documentType=1&documentNumber=${cedula}`,
        {
          headers: {
            ...CO_HEADERS,
            Accept: "application/json",
          },
        },
        15000
      );

      if (res.ok && res.body) {
        const data = typeof res.body === "string" ? {} : res.body;
        if (data.sanctions && Array.isArray(data.sanctions) && data.sanctions.length > 0) {
          findings.push({
            category: "exposure",
            severity: "critical",
            title: `Procuraduría/CNDJ: ${data.sanctions.length} disciplinary sanction(s)`,
            description: [
              `CC: ${cedula} has active disciplinary sanctions via CNDJ.`,
              ...data.sanctions.slice(0, 5).map((s, i) =>
                `${i + 1}. ${s.description || s.type || "Sanction"} — ${s.entity || "N/A"}`
              ),
            ].join("\n"),
            sourceUrl: "https://antecedentesdisciplinarios.cndj.gov.co/",
            rawData: data,
            remediation: "Disciplinary records are public. Consult a Colombian attorney for options.",
          });
          return findings;
        } else if (data.message || data.result) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Procuraduría/CNDJ: No lawyer sanctions",
            description: `No active disciplinary sanctions found in CNDJ for CC: ${cedula}. (Note: CNDJ covers lawyers/judicial staff only.)`,
            sourceUrl: "https://antecedentesdisciplinarios.cndj.gov.co/",
            rawData: { searched: cedula, source: "CNDJ" },
          });
          return findings;
        }
      }
    } catch (e) {
      // Continue to fallback
    } finally {
      release4();
    }

    // Fallback: provide manual link
    findings.push({
      category: "exposure",
      severity: "info",
      title: "Procuraduría: Manual verification required",
      description: [
        `Automatic query could not retrieve disciplinary records for CC: ${cedula}.`,
        `The site uses security questions that require manual interaction.`,
        `This is an important check — disciplinary records affect public employment eligibility.`,
      ].join("\n"),
      sourceUrl: CERT_URL,
      rawData: { searched: cedula, reason: "security_question_required" },
      remediation: "Visit https://apps.procuraduria.gov.co/webcert/Certificado.aspx — select CC, enter cédula, answer the security question.",
    });

    return findings;
  },
};

/**
 * Try to solve simple math security questions like "¿Cuánto es 3 + 5?" or "7 - 2 = ?"
 */
function solveMathQuestion(question) {
  // Common patterns: "¿Cuánto es 3 + 5?", "3 + 5 = ?", "Ingrese el resultado de 7 - 2"
  const patterns = [
    /(\d+)\s*\+\s*(\d+)/,
    /(\d+)\s*-\s*(\d+)/,
    /(\d+)\s*\*\s*(\d+)/,
    /(\d+)\s*[xX×]\s*(\d+)/,
  ];

  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (match) {
      const a = parseInt(match[1], 10);
      const b = parseInt(match[2], 10);
      if (question.includes("+")) return a + b;
      if (question.includes("-")) return a - b;
      if (question.includes("*") || question.includes("x") || question.includes("X") || question.includes("×")) return a * b;
    }
  }
  return null;
}

function parseProcuraduriaResult(html, cedula) {
  const lower = html.toLowerCase();

  // Check for "no tiene antecedentes" or similar clean record
  const isClean = lower.includes("no tiene antecedentes") ||
    lower.includes("no aparece registrado") ||
    lower.includes("no registra antecedentes") ||
    lower.includes("no tiene sanciones");

  // Check for records found
  const hasRecords = (lower.includes("sancion") || lower.includes("antecedente")) &&
    (lower.includes("vigente") || lower.includes("inhabilidad") || lower.includes("destituci")) &&
    !isClean;

  if (isClean) {
    return {
      category: "exposure",
      severity: "info",
      title: "Procuraduría: No disciplinary records",
      description: `CC: ${cedula} has no disciplinary records in the Procuraduría General de la Nación. Clean disciplinary background.`,
      sourceUrl: CERT_URL,
      rawData: { searched: cedula, clean: true },
    };
  }

  if (hasRecords) {
    return {
      category: "exposure",
      severity: "critical",
      title: "Procuraduría: DISCIPLINARY RECORDS FOUND",
      description: [
        `CC: ${cedula} has disciplinary records in Procuraduría.`,
        `This indicates formal sanctions by the Colombian government.`,
        `This can include dismissals, suspensions, and disqualifications from public office.`,
      ].join("\n"),
      sourceUrl: CERT_URL,
      rawData: { searched: cedula, hasRecords: true },
      remediation: "Disciplinary records from the Procuraduría are public. Consult a Colombian attorney for expungement options if applicable.",
    };
  }

  return null;
}
