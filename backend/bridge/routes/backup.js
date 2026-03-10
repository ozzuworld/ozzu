// routes/backup.js — Backup management: create, list, download, schedule

module.exports = function createBackupRoutes(ctx) {
  const { log: logObj, sendJSON, parseBody, requireAuth, fs, path } = ctx;
  const log = typeof logObj === 'function' ? logObj : (...args) => (logObj.bridge ? logObj.bridge.info(...args) : console.log(...args));

  const BACKUP_DIR = "/home/gcp/ozzu/backups";
  const BACKUP_SCRIPT = "/home/gcp/ozzu/scripts/backup.sh";

  // Ensure backup dir exists
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  return async function handleBackupRoutes(req, res, pathname, url) {

    // GET /api/backups — List available backups
    if (req.method === "GET" && pathname === "/api/backups") {
      try {
        const files = fs.readdirSync(BACKUP_DIR)
          .filter(f => f.startsWith("ozzu-backup-") && (f.endsWith(".tar.gz") || f.endsWith(".tar.gz.enc")))
          .sort()
          .reverse();

        const backups = files.map(f => {
          const stat = fs.statSync(path.join(BACKUP_DIR, f));
          const encrypted = f.endsWith(".enc");
          // Parse timestamp from filename: ozzu-backup-YYYYMMDD_HHMMSS
          const match = f.match(/ozzu-backup-(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
          let timestamp = stat.mtime.toISOString();
          if (match) {
            timestamp = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
          }
          return {
            filename: f,
            size: stat.size,
            sizeHuman: formatBytes(stat.size),
            encrypted,
            timestamp,
            createdAt: stat.mtime.toISOString(),
          };
        });

        // Check cron status
        const { execSync } = require("child_process");
        let cronEnabled = false;
        try {
          const crontab = execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
          cronEnabled = crontab.includes("backup.sh");
        } catch {}

        sendJSON(res, 200, {
          backups,
          total: backups.length,
          cronEnabled,
          backupDir: BACKUP_DIR,
        });
      } catch (err) {
        log(`[backup] List error: ${err.message}`);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /api/backups — Trigger a new backup
    if (req.method === "POST" && pathname === "/api/backups") {
      if (!requireAuth(req, res)) return true;
      try {
        const { execSync } = require("child_process");
        log("[backup] Manual backup triggered");

        // Run backup script synchronously (typically takes <30s)
        const output = execSync(`bash ${BACKUP_SCRIPT}`, {
          encoding: "utf8",
          timeout: 120000,
          env: { ...process.env, PATH: process.env.PATH },
        });

        // Parse result
        const fileLine = output.match(/File:\s+(.+)/);
        const sizeLine = output.match(/Size:\s+(.+)/);
        const checksumLine = output.match(/Checksum:\s+(.+)/);

        const result = {
          ok: true,
          file: fileLine ? fileLine[1].trim() : null,
          size: sizeLine ? sizeLine[1].trim() : null,
          checksum: checksumLine ? checksumLine[1].trim() : null,
          output: output.split("\n").filter(l => l.trim()),
        };

        log(`[backup] Complete: ${result.file} (${result.size})`);
        sendJSON(res, 200, result);
      } catch (err) {
        log(`[backup] Failed: ${err.message}`);
        sendJSON(res, 500, { error: err.message, output: err.stdout || "" });
      }
      return true;
    }

    // GET /api/backups/:filename/download — Download a backup file
    const dlMatch = pathname.match(/^\/api\/backups\/([^/]+)\/download$/);
    if (req.method === "GET" && dlMatch) {
      if (!requireAuth(req, res)) return true;
      const filename = decodeURIComponent(dlMatch[1]);

      // Sanitize — prevent path traversal
      if (filename.includes("..") || filename.includes("/")) {
        sendJSON(res, 400, { error: "Invalid filename" });
        return true;
      }

      const filePath = path.join(BACKUP_DIR, filename);
      if (!fs.existsSync(filePath)) {
        sendJSON(res, 404, { error: "Backup not found" });
        return true;
      }

      try {
        const stat = fs.statSync(filePath);
        log(`[backup] Download: ${filename} (${formatBytes(stat.size)})`);

        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": stat.size,
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
        });
        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        log(`[backup] Download error: ${err.message}`);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /api/backups/:filename — Delete a backup
    const delMatch = pathname.match(/^\/api\/backups\/([^/]+)$/);
    if (req.method === "DELETE" && delMatch) {
      if (!requireAuth(req, res)) return true;
      const filename = decodeURIComponent(delMatch[1]);

      if (filename.includes("..") || filename.includes("/")) {
        sendJSON(res, 400, { error: "Invalid filename" });
        return true;
      }

      const filePath = path.join(BACKUP_DIR, filename);
      if (!fs.existsSync(filePath)) {
        sendJSON(res, 404, { error: "Backup not found" });
        return true;
      }

      try {
        fs.unlinkSync(filePath);
        log(`[backup] Deleted: ${filename}`);
        sendJSON(res, 200, { ok: true, deleted: filename });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /api/backups/status — Backup system health check
    if (req.method === "GET" && pathname === "/api/backups/status") {
      try {
        const files = fs.readdirSync(BACKUP_DIR)
          .filter(f => f.startsWith("ozzu-backup-"))
          .sort()
          .reverse();

        const latest = files[0];
        let lastBackupAge = null;
        let healthy = false;

        if (latest) {
          const stat = fs.statSync(path.join(BACKUP_DIR, latest));
          lastBackupAge = Math.round((Date.now() - stat.mtime.getTime()) / 3600000); // hours
          healthy = lastBackupAge < 25; // less than 25 hours = healthy
        }

        const { execSync } = require("child_process");
        let cronEnabled = false;
        try {
          const crontab = execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
          cronEnabled = crontab.includes("backup.sh");
        } catch {}

        sendJSON(res, 200, {
          healthy,
          cronEnabled,
          lastBackup: latest || null,
          lastBackupAgeHours: lastBackupAge,
          totalBackups: files.length,
        });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    return false;
  };
};

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
