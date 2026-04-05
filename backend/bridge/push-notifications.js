// push-notifications.js — Expo Push Notification service
// Uses Expo's push API directly (no SDK needed)

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/**
 * Send a push notification to one or more Expo push tokens
 * @param {string|string[]} tokens - Expo push token(s)
 * @param {object} opts - { title, body, data, sound, badge }
 */
async function sendPush(tokens, opts = {}) {
  const tokenList = Array.isArray(tokens) ? tokens : [tokens];
  const valid = tokenList.filter(t => t && t.startsWith("ExponentPushToken["));
  if (valid.length === 0) return { sent: 0, errors: ["No valid tokens"] };

  const messages = valid.map(to => ({
    to,
    title: opts.title || "Ozzu",
    body: opts.body || "",
    data: opts.data || {},
    sound: opts.sound !== false ? "default" : null,
    badge: opts.badge,
    priority: opts.priority || "high",
  }));

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify(messages),
    });

    const result = await res.json();
    const errors = (result.data || [])
      .filter(r => r.status === "error")
      .map(r => r.message);

    return { sent: valid.length - errors.length, errors, result: result.data };
  } catch (err) {
    return { sent: 0, errors: [err.message] };
  }
}

module.exports = { sendPush };
