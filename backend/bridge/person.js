// person.js — The core Identity object for Ozzu
// Mirrors OZ's "Account" concept: one object that connects face, channels, devices.
// An account's authority = what it's wired into. Person.reach() is that authority.

"use strict";

const { sendPush } = require("./push-notifications");

// ── DB Migration ──────────────────────────────────────────────────────────────

async function ensureTables(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS persons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      nickname TEXT,
      relationship TEXT NOT NULL DEFAULT 'unknown'
        CHECK (relationship IN ('owner', 'trusted', 'contact', 'recognized', 'unknown')),
      notes TEXT,
      avatar_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS person_channels (
      id SERIAL PRIMARY KEY,
      person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('whatsapp', 'email', 'push', 'phone')),
      address TEXT NOT NULL,
      is_primary BOOLEAN DEFAULT FALSE,
      verified BOOLEAN DEFAULT FALSE,
      last_used TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(type, address)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS person_faces (
      id SERIAL PRIMARY KEY,
      person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
      face_identity_id UUID REFERENCES face_identities(id),
      qdrant_point_id TEXT,
      source TEXT DEFAULT 'manual',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(person_id, face_identity_id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS person_devices (
      id SERIAL PRIMARY KEY,
      person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
      device_type TEXT,
      platform TEXT,
      push_token TEXT UNIQUE,
      device_name TEXT,
      last_seen TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed King Kazuma as owner if not exists
  const existing = await db.query(`SELECT id FROM persons WHERE relationship = 'owner' LIMIT 1`);
  if (existing.rows.length === 0) {
    const ownerResult = await db.query(`
      INSERT INTO persons (name, nickname, relationship, notes)
      VALUES ('Hebert Suarez', 'King Kazuma', 'owner', 'The architect. His word is law.')
      RETURNING id
    `);
    const ownerId = ownerResult.rows[0].id;

    // Migrate owner_profile channels
    const ownerProfile = await db.query(`SELECT phone, email FROM owner_profile LIMIT 1`).catch(() => ({ rows: [] }));
    if (ownerProfile.rows.length > 0) {
      const { phone, email } = ownerProfile.rows[0];
      if (phone) {
        const cleanPhone = phone.replace(/\D/g, "");
        await db.query(
          `INSERT INTO person_channels (person_id, type, address, is_primary, verified)
           VALUES ($1, 'whatsapp', $2, TRUE, TRUE) ON CONFLICT (type, address) DO NOTHING`,
          [ownerId, cleanPhone]
        ).catch(() => {});
      }
      if (email) {
        await db.query(
          `INSERT INTO person_channels (person_id, type, address, is_primary, verified)
           VALUES ($1, 'email', $2, FALSE, TRUE) ON CONFLICT (type, address) DO NOTHING`,
          [ownerId, email]
        ).catch(() => {});
      }
    }

    // Migrate device_push_tokens → person_devices
    const tokens = await db.query(`SELECT token, device_id, platform, device_name FROM device_push_tokens`).catch(() => ({ rows: [] }));
    for (const t of tokens.rows) {
      await db.query(
        `INSERT INTO person_devices (person_id, platform, push_token, device_name, device_type)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (push_token) DO NOTHING`,
        [ownerId, t.platform || "ios", t.token, t.device_name, "iphone"]
      ).catch(() => {});
    }

    console.log(`[person] Seeded owner: ${ownerId}`);
  }
}

// ── Person Class ──────────────────────────────────────────────────────────────

class Person {
  constructor({ id, name, nickname, relationship, notes, avatar_url, channels = [], devices = [], faces = [] }) {
    this.id = id;
    this.name = name;
    this.nickname = nickname;
    this.relationship = relationship;
    this.notes = notes;
    this.avatarUrl = avatar_url;
    this.channels = channels;
    this.devices = devices;
    this.faces = faces;
  }

  // THE OZ MOVE — reach this person through the right channel
  // via: 'whatsapp' | 'email' | 'push' | null (auto-pick primary)
  async reach(text, via = null) {
    const channel = via
      ? this.channels.find(c => c.type === via)
      : this.channels.find(c => c.is_primary) ?? this.channels[0];

    if (!channel) throw new Error(`No channel configured for ${this.name}`);

    switch (channel.type) {
      case "whatsapp": {
        const http = require("http");
        const payload = JSON.stringify({ to: channel.address, message: text });
        return new Promise((resolve, reject) => {
          const req = http.request(
            { hostname: "localhost", port: 3333, path: "/whatsapp/send", method: "POST",
              headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
            (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
          );
          req.on("error", reject);
          req.write(payload); req.end();
        });
      }
      case "email": {
        const http = require("http");
        const payload = JSON.stringify({ to: channel.address, subject: "Ozzu", body: text });
        return new Promise((resolve, reject) => {
          const req = http.request(
            { hostname: "localhost", port: 3333, path: "/email/send", method: "POST",
              headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
            (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
          );
          req.on("error", reject);
          req.write(payload); req.end();
        });
      }
      case "push": {
        return sendPush([channel.address], { body: text });
      }
      default:
        throw new Error(`Unknown channel type: ${channel.type}`);
    }
  }

  // Push notification to ALL devices — used by KAIROS
  async notify(title, body, data = {}) {
    const tokens = this.devices.map(d => d.push_token).filter(Boolean);
    if (tokens.length === 0) return { sent: 0, reason: "no_devices" };
    return sendPush(tokens, { title, body, data });
  }

  // Summary for MCP display
  toSummary() {
    return {
      id: this.id,
      name: this.name,
      nickname: this.nickname,
      relationship: this.relationship,
      channels: this.channels.map(c => `${c.type}:${c.address}${c.is_primary ? " (primary)" : ""}`),
      devices: this.devices.length,
      faces: this.faces.length,
    };
  }

  // ── Static finders ──────────────────────────────────────────────────────────

  static async _load(db, row) {
    if (!row) return null;
    const [channels, devices, faces] = await Promise.all([
      db.query(`SELECT type, address, is_primary, verified, last_used FROM person_channels WHERE person_id = $1 ORDER BY is_primary DESC`, [row.id]),
      db.query(`SELECT device_type, platform, push_token, device_name, last_seen FROM person_devices WHERE person_id = $1`, [row.id]),
      db.query(`SELECT face_identity_id, qdrant_point_id, source FROM person_faces WHERE person_id = $1`, [row.id]),
    ]);
    return new Person({ ...row, channels: channels.rows, devices: devices.rows, faces: faces.rows });
  }

  static async find(db, id) {
    const r = await db.query(`SELECT * FROM persons WHERE id = $1`, [id]);
    return Person._load(db, r.rows[0] ?? null);
  }

  // Always returns King Kazuma
  static async owner(db) {
    const r = await db.query(`SELECT * FROM persons WHERE relationship = 'owner' LIMIT 1`);
    return Person._load(db, r.rows[0] ?? null);
  }

  static async findByName(db, name) {
    const r = await db.query(
      `SELECT * FROM persons WHERE name ILIKE $1 OR nickname ILIKE $1 LIMIT 1`,
      [`%${name}%`]
    );
    return Person._load(db, r.rows[0] ?? null);
  }

  // Face recognized → who is this?
  static async findByFace(db, faceIdentityId) {
    const r = await db.query(
      `SELECT p.* FROM persons p
       JOIN person_faces pf ON pf.person_id = p.id
       WHERE pf.face_identity_id = $1 LIMIT 1`,
      [faceIdentityId]
    );
    return Person._load(db, r.rows[0] ?? null);
  }

  // WA message from unknown number → who is this?
  static async findByChannel(db, type, address) {
    const clean = address.replace(/\D/g, "");
    const r = await db.query(
      `SELECT p.* FROM persons p
       JOIN person_channels pc ON pc.person_id = p.id
       WHERE pc.type = $1 AND (pc.address = $2 OR pc.address = $3) LIMIT 1`,
      [type, address, clean]
    );
    return Person._load(db, r.rows[0] ?? null);
  }

  static async findByPushToken(db, token) {
    const r = await db.query(
      `SELECT p.* FROM persons p
       JOIN person_devices pd ON pd.person_id = p.id
       WHERE pd.push_token = $1 LIMIT 1`,
      [token]
    );
    return Person._load(db, r.rows[0] ?? null);
  }

  static async findAll(db) {
    const r = await db.query(`SELECT * FROM persons ORDER BY relationship, name`);
    return Promise.all(r.rows.map(row => Person._load(db, row)));
  }

  // Create a new person
  static async create(db, { name, nickname, relationship = "contact", notes, channels = [] }) {
    const r = await db.query(
      `INSERT INTO persons (name, nickname, relationship, notes) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, nickname, relationship, notes]
    );
    const person = r.rows[0];
    for (const ch of channels) {
      await db.query(
        `INSERT INTO person_channels (person_id, type, address, is_primary) VALUES ($1, $2, $3, $4) ON CONFLICT (type, address) DO NOTHING`,
        [person.id, ch.type, ch.address, ch.is_primary ?? false]
      ).catch(() => {});
    }
    return Person.find(db, person.id);
  }
}

module.exports = { Person, ensureTables };
