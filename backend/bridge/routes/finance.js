// routes/finance.js — Bancolombia transaction tracking (fully local)

const Imap = require("imap");
const { simpleParser } = require("mailparser");
const db = require("../db");

const IMAP_CONFIG = {
  user: process.env.GMAIL_USER,
  password: process.env.GMAIL_APP_PASSWORD,
  host: "imap.gmail.com",
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
};

// ── Transaction regex patterns ──────────────────────────────────────────────
// 2026 new format: "Bancolombia: Compraste $15.350,00 en RAPPI con tu T.Deb *3070, el 27/02/2026 a las 06:48."
// 2023 mid format: "Bancolombia le informa Transferencia por $70,000 desde cta *7666 a cta *1234"
// 2022 old format: "Bancolombia le informa Compra por $132.950,00 en MERCHANT 15:17."

function parseAmount(str) {
  // Handles "15.350,00" (Colombian) and "2,500,000" (US-style) and "2,500,000.00"
  const s = str.trim();
  // If it has a comma before 2 digits at the end → Colombian decimal: 15.350,00
  if (/,\d{2}$/.test(s)) return parseFloat(s.replace(/\./g, "").replace(",", "."));
  // Otherwise: dots are thousands separators, no decimal → "2,500,000" or "2.500.000"
  return parseFloat(s.replace(/[.,]/g, "").replace(/(\d+)$/, (n) => n));
}

function parseAmountAny(str) {
  // More robust: strip everything except digits and last separator
  const cleaned = str.replace(/[^\d.,]/g, "");
  if (/,\d{2}$/.test(cleaned)) return parseFloat(cleaned.replace(/\./g, "").replace(",", "."));
  if (/\.\d{2}$/.test(cleaned)) return parseFloat(cleaned.replace(/,/g, ""));
  return parseFloat(cleaned.replace(/[.,]/g, "")) || 0;
}

function parseDate(dateStr, timeStr) {
  const [d, m, y] = dateStr.split("/");
  return new Date(`${y}-${m}-${d}T${timeStr}:00-05:00`);
}

function parseTransactionText(text, emailDate) {
  const fallbackDate = emailDate || new Date();
  // Normalize soft line wraps — emails wrap long lines with \n, rejoin them
  text = text.replace(/\n([A-ZÁÉÍÓÚÑ*])/g, " $1");  // uppercase/special after newline = continuation
  text = text.replace(/\n(\s)/g, " ");               // newline + whitespace = space
  let m;

  // ── 2026 NEW FORMAT ─────────────────────────────────────────────────────────
  // Purchase debit/credit
  m = text.match(/Compraste \$([0-9.,]+) en (.+?) con tu T\.[A-Za-z]{3} \*(\d+),? el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "purchase", amount: -parseAmountAny(m[1]), merchant: m[2].trim(), card_last4: m[3], date: parseDate(m[4], m[5]) };

  // Payment bill
  m = text.match(/Pagaste \$([0-9.,]+) a (.+?) con tu T\.[A-Za-z]{3} \*(\d+),? el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "payment", amount: -parseAmountAny(m[1]), merchant: m[2].trim(), card_last4: m[3], date: parseDate(m[4], m[5]) };

  // Transfer out
  m = text.match(/Transferiste \$([0-9.,]+) desde tu cuenta \*(\d+) a la cuenta \*(\d+) el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "transfer_out", amount: -parseAmountAny(m[1]), merchant: `Transfer → *${m[3]}`, account_last4: m[2], date: parseDate(m[4], m[5]) };

  // Withdrawal
  m = text.match(/Retiraste \$([0-9.,]+) en (.+?) con tu T\.[A-Za-z]{3} \*(\d+),? el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "withdrawal", amount: -parseAmountAny(m[1]), merchant: m[2].trim(), card_last4: m[3], date: parseDate(m[4], m[5]) };

  // Received / transfer in
  m = text.match(/Recibiste \$([0-9.,]+) en tu cuenta \*(\d+) el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "transfer_in", amount: parseAmountAny(m[1]), merchant: "Transferencia recibida", account_last4: m[2], date: parseDate(m[3], m[4]) };

  // Deposit
  m = text.match(/Consign[óo] \$([0-9.,]+) en tu cuenta \*(\d+) el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "deposit", amount: parseAmountAny(m[1]), merchant: "Consignación", account_last4: m[2], date: parseDate(m[3], m[4]) };

  // ── 2023 MID FORMAT ─────────────────────────────────────────────────────────
  // "Bancolombia le informa Transferencia por $70,000 desde cta *7666 a cta *1234"
  m = text.match(/informa (?:un? )?Transferencia por \$([0-9.,]+) desde cta \*(\d+) a cta \*?(\d+)/i);
  if (m) return { type: "transfer_out", amount: -parseAmountAny(m[1]), merchant: `Transfer → *${m[3]}`, account_last4: m[2], date: fallbackDate };

  // "Bancolombia le informa Pago por $350,000.00 a BANCOLOMBIA desde producto"
  m = text.match(/informa (?:un? )?Pago por \$([0-9.,]+) a ([^\n]+?) (?:desde|con)/i);
  if (m) return { type: "payment", amount: -parseAmountAny(m[1]), merchant: m[2].trim(), date: fallbackDate };

  // "Bancolombia le informa un Pago de Nomina de CENTER SOURCE C por $3,068,000.00"
  m = text.match(/Pago de Nomina de (.+?) por \$([0-9.,]+)/i);
  if (m) return { type: "transfer_in", amount: parseAmountAny(m[2]), merchant: `Nómina: ${m[1].trim()}`, date: fallbackDate };

  // "Bancolombia le informa Compra por $350,000.00 desde producto"
  m = text.match(/informa (?:un? )?Compra por \$([0-9.,]+) (?:en|desde|con) ([^\n.]+)/i);
  if (m) return { type: "purchase", amount: -parseAmountAny(m[1]), merchant: m[2].trim(), date: fallbackDate };

  // ── 2022 OLD FORMAT ─────────────────────────────────────────────────────────
  // "Bancolombia le informa Compra por $132.950,00 en FERREMATERIALES SAN 15:17."
  m = text.match(/informa Compra por \$([0-9.,]+) en (.+?) \d{2}:\d{2}/i);
  if (m) return { type: "purchase", amount: -parseAmountAny(m[1]), merchant: m[2].trim(), date: fallbackDate };

  // "Bancolombia le informa Retiro por $200.000,00 en BAR_SILENC1. Hora 14:55"
  m = text.match(/informa Retiro por \$([0-9.,]+) en ([^.\n]+)/i);
  if (m) return { type: "withdrawal", amount: -parseAmountAny(m[1]), merchant: m[2].trim(), date: fallbackDate };

  // Generic recepción / consignación
  m = text.match(/informa (?:Recepci[oó]n|Consignaci[oó]n) por \$([0-9.,]+)/i);
  if (m) return { type: "transfer_in", amount: parseAmountAny(m[1]), merchant: "Consignación/Recepción", date: fallbackDate };

  return null;
}

async function fetchAndParseEmails(since, onTransaction) {
  return new Promise((resolve, reject) => {
    const imap = new Imap(IMAP_CONFIG);
    imap.once("ready", () => {
      imap.openBox("Ozzu/Finance", true, (err) => {
        if (err) { imap.end(); return reject(err); }

        const searchCriteria = since
          ? [["FROM", "notificacionesbancolombia.com"], ["SINCE", since]]
          : [["FROM", "notificacionesbancolombia.com"]];

        imap.search(searchCriteria, (err, uids) => {
          if (err || !uids || uids.length === 0) { imap.end(); return resolve(0); }

          // Collect all raw messages first, parse after fetch completes
          const pendingMessages = [];
          const fetch = imap.fetch(uids, { bodies: "" });

          fetch.on("message", (msg) => {
            const msgData = { buffer: "", uid: null, date: null };
            pendingMessages.push(msgData);
            msg.on("attributes", (a) => { msgData.uid = a.uid; msgData.date = a.date; });
            msg.on("body", (stream) => {
              stream.on("data", (chunk) => { msgData.buffer += chunk.toString("utf8"); });
            });
          });

          fetch.once("end", async () => {
            // Now parse all messages
            const parsePromises = pendingMessages.map(async (m) => {
              try {
                const parsed = await simpleParser(m.buffer);
                const text = parsed.text || "";
                const emailDate = parsed.date || m.date || new Date();
                const txn = parseTransactionText(text, emailDate);
                if (txn) {
                  const emailUid = `bancolombia_${m.uid || Math.random()}`;
                  onTransaction({ ...txn, email_uid: emailUid, raw_text: text.substring(0, 500) });
                }
              } catch (e) { /* skip unparseable */ }
            });
            await Promise.all(parsePromises);
            imap.end();
            resolve(pendingMessages.length);
          });
        });
      });
    });
    imap.once("error", reject);
    imap.connect();
  });
}

async function insertTransaction(txn) {
  try {
    await db.query(`
      INSERT INTO transactions (date, amount, merchant, type, account_last4, card_last4, balance, raw_text, source, email_uid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'email_notification', $9)
      ON CONFLICT (email_uid) DO NOTHING
    `, [txn.date, txn.amount, txn.merchant, txn.type, txn.account_last4 || null, txn.card_last4 || null, txn.balance || null, txn.raw_text, txn.email_uid]);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = function createFinanceRoutes(ctx) {
  const { log: logObj, sendJSON, parseBody } = ctx;
  const log = (...args) => (logObj?.bridge ? logObj.bridge.info(...args) : console.log(...args));

  let _pollingTimer = null;
  let _lastPollTime = null;
  let _polling = false;

  async function pollNewTransactions() {
    if (_polling) return;
    _polling = true;
    try {
      const since = _lastPollTime ? new Date(_lastPollTime) : new Date(Date.now() - 10 * 60 * 1000);
      _lastPollTime = Date.now();
      const transactions = [];
      await fetchAndParseEmails(since, (txn) => transactions.push(txn));
      let inserted = 0;
      for (const txn of transactions) {
        if (await insertTransaction(txn)) inserted++;
      }
      if (inserted > 0) log(`[finance] Polled ${inserted} new transaction(s)`);
    } catch (e) {
      log(`[finance] Poll error: ${e.message}`);
    } finally {
      _polling = false;
    }
  }

  // Start 2-minute polling
  function startPolling() {
    if (_pollingTimer) return;
    _lastPollTime = Date.now() - 5 * 60 * 1000; // check last 5 min on startup
    pollNewTransactions();
    _pollingTimer = setInterval(pollNewTransactions, 2 * 60 * 1000);
    log("[finance] Real-time transaction polling started (every 2 min)");
  }
  startPolling();

  return async function handleFinanceRoutes(req, res, pathname) {

    // GET /api/finance/transactions — list transactions with filters
    if (req.method === "GET" && pathname === "/api/finance/transactions") {
      try {
        const url = new URL(req.url, "http://x");
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const offset = parseInt(url.searchParams.get("offset") || "0");
        const type = url.searchParams.get("type");
        const month = url.searchParams.get("month"); // "2026-03"

        let query = "SELECT * FROM transactions WHERE 1=1";
        const params = [];
        if (type) { params.push(type); query += ` AND type = $${params.length}`; }
        if (month) {
          params.push(`${month}-01`);
          params.push(`${month}-01`);
          query += ` AND date >= $${params.length-1}::date AND date < $${params.length}::date + interval '1 month'`;
        }
        query += ` ORDER BY date DESC LIMIT ${limit} OFFSET ${offset}`;

        const result = await db.query(query, params);
        const total = await db.query("SELECT COUNT(*) FROM transactions" + (type ? " WHERE type=$1" : ""), type ? [type] : []);
        sendJSON(res, 200, { transactions: result.rows, total: parseInt(total.rows[0].count) });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return true;
    }

    // GET /api/finance/summary — monthly summary
    if (req.method === "GET" && pathname === "/api/finance/summary") {
      try {
        const url = new URL(req.url, "http://x");
        const months = parseInt(url.searchParams.get("months") || "6");

        const result = await db.query(`
          SELECT
            to_char(date, 'YYYY-MM') as month,
            SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
            SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses,
            COUNT(*) as count
          FROM transactions
          WHERE date >= NOW() - INTERVAL '${months} months'
          GROUP BY to_char(date, 'YYYY-MM')
          ORDER BY month DESC
        `);

        const latest = await db.query(
          `SELECT balance FROM transactions WHERE balance IS NOT NULL ORDER BY date DESC LIMIT 1`
        );

        const byType = await db.query(`
          SELECT type, COUNT(*) as count, SUM(ABS(amount)) as total
          FROM transactions
          WHERE date >= NOW() - INTERVAL '1 month'
          GROUP BY type ORDER BY total DESC
        `);

        sendJSON(res, 200, {
          monthly: result.rows,
          last_known_balance: latest.rows[0]?.balance || null,
          this_month_by_type: byType.rows,
        });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return true;
    }

    // POST /api/finance/import — run historical import of all Bancolombia emails
    if (req.method === "POST" && pathname === "/api/finance/import") {
      try {
        const transactions = [];
        await fetchAndParseEmails(null, (txn) => transactions.push(txn));
        let imported = 0;
        for (const txn of transactions) {
          if (await insertTransaction(txn)) imported++;
        }
        sendJSON(res, 200, { imported, total_parsed: transactions.length });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return true;
    }

    return false;
  };
};
