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
// "Bancolombia: Compraste $15.350,00 en RAPPI COLOMBIA*DL con tu T.Deb *3070, el 27/02/2026 a las 06:48."
// "Bancolombia: Transferiste $2,500,000 desde tu cuenta *7666 a la cuenta *08300020853 el 21/02/2026 a las 09:54."
// "Bancolombia: Retiraste $200.000,00 en CAJERO BANCOLOMBIA con tu T.Deb *3070, el 01/03/2026 a las 10:00."
// "Bancolombia: Recibiste $500.000,00 en tu cuenta *7666 el 10/03/2026 a las 08:00."
// "Bancolombia: Pagaste $50.000,00 a NETFLIX con tu T.Cre *1234, el 05/03/2026 a las 00:00."

function parseAmount(str) {
  // Handles both "15.350,00" and "2,500,000" formats
  const cleaned = str.replace(/\./g, "").replace(/,/g, ".");
  return parseFloat(cleaned);
}

function parseDate(dateStr, timeStr) {
  // "27/02/2026" + "06:48" → Date
  const [d, m, y] = dateStr.split("/");
  return new Date(`${y}-${m}-${d}T${timeStr}:00-05:00`); // Colombia is UTC-5
}

function parseTransactionText(text) {
  // Purchase with debit card
  let m = text.match(/Compraste \$([0-9.,]+) en (.+?) con tu T\.Deb \*(\d+),? el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "purchase", amount: -parseAmount(m[1]), merchant: m[2].trim(), card_last4: m[3], date: parseDate(m[4], m[5]) };

  // Purchase with credit card
  m = text.match(/Compraste \$([0-9.,]+) en (.+?) con tu T\.Cre \*(\d+),? el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "purchase", amount: -parseAmount(m[1]), merchant: m[2].trim(), card_last4: m[3], date: parseDate(m[4], m[5]) };

  // Payment (bill pay)
  m = text.match(/Pagaste \$([0-9.,]+) a (.+?) con tu T\.(Deb|Cre) \*(\d+),? el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "payment", amount: -parseAmount(m[1]), merchant: m[2].trim(), card_last4: m[4], date: parseDate(m[5], m[6]) };

  // Transfer out
  m = text.match(/Transferiste \$([0-9.,]+) desde tu cuenta \*(\d+) a la cuenta \*(\d+) el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "transfer_out", amount: -parseAmount(m[1]), merchant: `Transfer → *${m[3]}`, account_last4: m[2], date: parseDate(m[4], m[5]) };

  // Withdrawal ATM
  m = text.match(/Retiraste \$([0-9.,]+) en (.+?) con tu T\.Deb \*(\d+),? el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "withdrawal", amount: -parseAmount(m[1]), merchant: m[2].trim(), card_last4: m[3], date: parseDate(m[4], m[5]) };

  // Received money (transfer in)
  m = text.match(/Recibiste \$([0-9.,]+) en tu cuenta \*(\d+) el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "transfer_in", amount: parseAmount(m[1]), merchant: "Transfer received", account_last4: m[2], date: parseDate(m[3], m[4]) };

  // Deposit
  m = text.match(/Consignaste? \$([0-9.,]+) en tu cuenta \*(\d+) el (\d{2}\/\d{2}\/\d{4}) a las (\d{2}:\d{2})/i);
  if (m) return { type: "deposit", amount: parseAmount(m[1]), merchant: "Deposit", account_last4: m[2], date: parseDate(m[3], m[4]) };

  // Generic balance notification
  m = text.match(/Saldo disponible[:\s]+\$([0-9.,]+)/i);
  if (m) return { type: "balance_update", amount: 0, balance: parseAmount(m[1]), merchant: null, date: new Date() };

  return null;
}

async function fetchAndParseEmails(since, onTransaction) {
  return new Promise((resolve, reject) => {
    const imap = new Imap(IMAP_CONFIG);
    imap.once("ready", () => {
      imap.openBox("Ozzu/Finance", true, (err) => {
        if (err) { imap.end(); return reject(err); }

        const criteria = [
          ["FROM", "notificacionesbancolombia.com"],
          since ? ["SINCE", since] : ["ALL"],
        ].filter(Boolean);

        // Flatten: since makes it [SINCE, date], otherwise just search all from bancolombia
        const searchCriteria = since
          ? [["FROM", "notificacionesbancolombia.com"], ["SINCE", since]]
          : [["FROM", "notificacionesbancolombia.com"]];

        imap.search(searchCriteria, (err, uids) => {
          if (err || !uids || uids.length === 0) { imap.end(); return resolve(0); }

          let processed = 0;
          const fetch = imap.fetch(uids, { bodies: "" });

          fetch.on("message", (msg, uid) => {
            let buffer = "";
            let attrs = {};
            msg.on("attributes", (a) => { attrs = a; });
            msg.on("body", (stream) => {
              stream.on("data", (chunk) => { buffer += chunk.toString("utf8"); });
            });
            msg.once("end", () => {
              simpleParser(buffer).then((parsed) => {
                const text = parsed.text || "";
                const txn = parseTransactionText(text);
                if (txn) {
                  const emailUid = `bancolombia_${attrs.uid || Date.now()}`;
                  onTransaction({ ...txn, email_uid: emailUid, raw_text: text.substring(0, 500) });
                  processed++;
                }
              }).catch(() => {});
            });
          });

          fetch.once("end", () => { setTimeout(() => { imap.end(); resolve(processed); }, 2000); });
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
