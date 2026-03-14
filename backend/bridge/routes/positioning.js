// routes/positioning.js — Indoor positioning endpoints
// Receives updates from Rock Pi hub, serves live location to Ozzu app

"use strict";

module.exports = function positioningRoutes(ctx) {
  const { sendJSON, parseBody, db, broadcastToAll } = ctx;

  // In-memory current state
  let _currentLocation = null;
  let _roomStates = [];
  let _hubStats = null;
  let _lastUpdate = null;

  // Position history (ring buffer for recent positions)
  const _history = [];
  const MAX_HISTORY = 500;

  return async function handlePositioningRoutes(req, res, pathname, url) {

    // POST /positioning/update — Receives position updates from Rock Pi hub
    if (req.method === "POST" && pathname === "/positioning/update") {
      const body = await parseBody(req);
      if (!body) {
        sendJSON(res, 400, { error: "Invalid body" });
        return true;
      }

      const { location, rooms, stats } = body;
      const now = new Date().toISOString();

      _currentLocation = location || null;
      _roomStates = rooms || [];
      _hubStats = stats || null;
      _lastUpdate = now;

      // Store in history
      if (location) {
        _history.push({ ...location, receivedAt: now });
        if (_history.length > MAX_HISTORY) _history.shift();

        // Persist to DB
        if (db) {
          try {
            await db.query(
              `INSERT INTO position_log (room, presence, confidence, method, ble_device, recorded_at)
               VALUES ($1, $2, $3, $4, $5, NOW())`,
              [location.room, location.presence, location.confidence,
               location.method, location.ble_device]
            );
          } catch {} // best-effort
        }
      }

      // Broadcast to all connected clients (Ozzu app + June)
      if (typeof broadcastToAll === "function") {
        broadcastToAll({
          type: "positionUpdate",
          location: _currentLocation,
          rooms: _roomStates,
          ts: now,
        });
      }

      sendJSON(res, 200, { ok: true });
      return true;
    }

    // GET /positioning/state — Current location + room states
    if (req.method === "GET" && pathname === "/positioning/state") {
      sendJSON(res, 200, {
        ok: true,
        location: _currentLocation,
        rooms: _roomStates,
        hubStats: _hubStats,
        lastUpdate: _lastUpdate,
      });
      return true;
    }

    // GET /positioning/history — Recent position history
    if (req.method === "GET" && pathname === "/positioning/history") {
      const limitParam = url.searchParams.get("limit");
      let limit = limitParam ? parseInt(limitParam, 10) : 50;
      if (isNaN(limit) || limit < 1) limit = 50;
      if (limit > 500) limit = 500;

      // Try DB first for richer history
      const since = url.searchParams.get("since");
      if (db && since) {
        try {
          const m = since.match(/^(\d+)(h|d|m)$/);
          if (m) {
            const interval = `${m[1]} ${m[2] === "h" ? "hours" : m[2] === "d" ? "days" : "minutes"}`;
            const result = await db.query(
              `SELECT room, presence, confidence, method, ble_device, recorded_at
               FROM position_log
               WHERE recorded_at > NOW() - $1::interval
               ORDER BY recorded_at DESC LIMIT $2`,
              [interval, limit]
            );
            sendJSON(res, 200, { ok: true, history: result.rows, source: "db" });
            return true;
          }
        } catch {}
      }

      // In-memory history
      sendJSON(res, 200, {
        ok: true,
        history: _history.slice(-limit),
        source: "memory",
      });
      return true;
    }

    // POST /positioning/pair — Trigger BLE pairing mode on an ESP32 node
    if (req.method === "POST" && pathname === "/positioning/pair") {
      const body = await parseBody(req);
      if (!body || !body.nodeIp) {
        sendJSON(res, 400, { error: "nodeIp required" });
        return true;
      }
      const timeout = body.timeoutSec || 90;
      try {
        // Send PAIR command via Rock Pi (bridge is on GCP, can't reach sensor subnet directly)
        const { execSync } = require("child_process");
        const cmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no root@172.168.0.55 "python3 -c \\"import socket,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.sendto(struct.pack('<IH',0x50414952,${timeout}),('${body.nodeIp.replace(/[^0-9.]/g, '')}',5502));s.close();print('PAIR sent')\\""`;
        const result = execSync(cmd, { timeout: 10000, encoding: "utf8" });
        sendJSON(res, 200, { ok: true, nodeIp: body.nodeIp, timeoutSec: timeout, result: result.trim() });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /positioning/nodes — List known ESP32 nodes for pairing UI
    if (req.method === "GET" && pathname === "/positioning/nodes") {
      const nodes = [
        { id: 1, room: "living", ip: "10.0.50.21" },
        { id: 2, room: "master", ip: "10.0.50.23" },
        { id: 3, room: "office", ip: "10.0.50.22" },
        { id: 4, room: "rooftop", ip: "10.0.50.24" },
      ];
      // Check which have IRKs by looking at room states
      const nodesWithStatus = nodes.map(n => ({
        ...n,
        online: _roomStates.some(r => r.node_id === n.id && !r.stale),
        irks: _roomStates.find(r => r.node_id === n.id)?.irk_count || 0,
      }));
      sendJSON(res, 200, { ok: true, nodes: nodesWithStatus });
      return true;
    }

    // GET /positioning/rooms — Room-level summary (for app dashboard)
    if (req.method === "GET" && pathname === "/positioning/rooms") {
      const rooms = _roomStates.map(r => ({
        name: r.room,
        nodeId: r.node_id,
        presence: r.presence,
        confidence: r.confidence,
        motionLevel: r.motion_level,
        stale: r.stale,
      }));

      sendJSON(res, 200, { ok: true, rooms, lastUpdate: _lastUpdate });
      return true;
    }

    return false;
  };
};
