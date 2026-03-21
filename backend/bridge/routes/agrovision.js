// routes/agrovision.js — Proxy to AgroVisión crop disease detection service (port 5556)
// Directive: dir_1774099821063

module.exports = function createAgrovisionRoutes(ctx) {
  const { sendJSON } = ctx;
  const http = require("http");

  const AGROVISION_PORT = 5556;
  const AGROVISION_HOST = "127.0.0.1";

  function proxy(req, res, targetPath) {
    // Collect request body
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);

      const proxyReq = http.request(
        {
          hostname: AGROVISION_HOST,
          port: AGROVISION_PORT,
          path: targetPath,
          method: req.method,
          headers: {
            ...req.headers,
            host: `${AGROVISION_HOST}:${AGROVISION_PORT}`,
          },
          timeout: 30000,
        },
        (proxyRes) => {
          // Forward response headers
          const headers = {
            ...proxyRes.headers,
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          };
          res.writeHead(proxyRes.statusCode, headers);
          proxyRes.pipe(res);
        }
      );

      proxyReq.on("error", (err) => {
        sendJSON(res, { error: `AgroVisión service unavailable: ${err.message}` }, 502);
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        sendJSON(res, { error: "AgroVisión service timeout" }, 504);
      });

      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
  }

  return async function handleAgrovisionRoutes(req, res, pathname, url) {
    // Proxy all /plant/* routes to agrovision service
    if (pathname.startsWith("/plant/")) {
      proxy(req, res, pathname);
      return true;
    }

    return false;
  };
};
