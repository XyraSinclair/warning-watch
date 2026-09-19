const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const express = require("express");
const cors = require("cors");
const { loadEnvFile } = require("./env");
const { CLIENT_DIST_DIR, DATA_DIR, DB_PATH, readWatchlist } = require("./config");
const { cleanPublicUrl } = require("./public-url");
const {
  initDb,
  getDb,
  getMetaValue,
  setMetaValue,
  upsertTrackedAircraft,
  getTrackingSummary,
} = require("./db");
const { createHeatmapCacheRefresher } = require("./heatmap-cache");
const { buildDashboardSnapshot } = require("./dashboard");
const { maybeSendEmergencyLevelTelegramAlert } = require("./telegram-alert");
const { buildEmergencyRssFeedXml, dedupeRssItems, getRssItems, maybeRecordEmergencyLevelRssItem, rssItemFromAlertEvent } = require("./rss-feed");
const {
  HttpError,
  confirmSubscriberChannel,
  countActiveSubscribers,
  getVapidPublicKey,
  isWebPushConfigured,
  getManagedSubscriber,
  listAlertEvents,
  listTakeoffEvents,
  sendPendingConfirmations,
  upsertSubscriber,
  unsubscribePushSubscriber,
  upsertPushSubscriber,
  updateManagedSubscriber,
} = require("./local-notifications");

loadEnvFile();

const { openWatchDb, syncSources } = require("./watch-store");
const { SOURCE_DEFINITIONS } = require("./watch-sources");
const { mountWatchRoutes } = require("./watch-api");
const { mountStatusRoutes } = require("./status-api");
const watchDb = openWatchDb();
syncSources(watchDb, SOURCE_DEFINITIONS);

const app = express();
const PORT = Number(process.env.PORT || 3030);
const HOST = process.env.HOST || "127.0.0.1";
const DASHBOARD_SNAPSHOT_META_KEY = "dashboard_snapshot_v1";
const DASHBOARD_DB_PATHS = [
  DB_PATH,
  path.join(DATA_DIR, "ews-military.sqlite"),
  path.join(DATA_DIR, "ews-untracked.sqlite"),
];
const PUBLISHED_DIR = process.env.EWS_PUBLISHED_DIR
  ? path.resolve(process.env.EWS_PUBLISHED_DIR)
  : path.join(DATA_DIR, "published");

function readAcrossDashboardDbs(reader, sortKey, limit) {
  const rows = [];
  for (const dbPath of DASHBOARD_DB_PATHS) {
    if (!fs.existsSync(dbPath)) {
      continue;
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      rows.push(...reader(db, { limit }));
    } finally {
      db.close();
    }
  }

  return rows
    .sort((left, right) => String(right[sortKey] || "").localeCompare(String(left[sortKey] || "")))
    .slice(0, limit);
}
const PUBLISHED_DASHBOARD_FILES = new Map([
  ["/dashboard.json", "dashboard.json"],
  ["/military-dashboard.json", "military-dashboard.json"],
  ["/untracked-dashboard.json", "untracked-dashboard.json"],
  ["/alerts.json", "alerts.json"],
  ["/takeoffs.json", "takeoffs.json"],
  ["/event-signals.json", "event-signals.json"],
]);

function readPublishedJson(fileName) {
  const filePath = path.join(PUBLISHED_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    throw new HttpError(503, `Published feed is not available at ${filePath}.`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readOptionalPublishedJson(fileName) {
  const filePath = path.join(PUBLISHED_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return {
      available: false,
      path: filePath,
    };
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    available: true,
    path: filePath,
    payload,
  };
}

function summarizePublishedFeed(fileName, itemKey) {
  const file = readOptionalPublishedJson(fileName);
  if (!file.available) {
    return file;
  }

  if (!Array.isArray(file.payload[itemKey])) {
    return {
      available: false,
      path: file.path,
      error: `Published feed is missing the ${itemKey} array.`,
    };
  }

  return {
    available: true,
    generatedAt: file.payload.generatedAt || null,
    itemCount: file.payload[itemKey].length,
  };
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hasEnv(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function hasHttpsEnv(name) {
  return String(process.env[name] || "").trim().startsWith("https://");
}

function hasTelnyxDeliveryStatusPath() {
  return hasHttpsEnv("TELNYX_WEBHOOK_URL") || hasHttpsEnv("APP_BASE_URL") || hasHttpsEnv("EWS_PUBLIC_URL");
}

function hasSendGridDeliveryStatusPath() {
  return hasHttpsEnv("SENDGRID_WEBHOOK_URL") || hasHttpsEnv("APP_BASE_URL") || hasHttpsEnv("EWS_PUBLIC_URL");
}

function hasBase64EncodedBytes(value, byteLength) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  try {
    return Buffer.from(normalized, "base64").length === byteLength;
  } catch {
    return false;
  }
}

function hasNotificationCrypto() {
  return hasEnv("NOTIFICATION_HASH_SECRET") && hasBase64EncodedBytes(process.env.NOTIFICATION_ENCRYPTION_KEY, 32);
}




function requireInternalAuth(request) {
  const expectedToken = String(process.env.INTERNAL_ALERT_TOKEN || "").trim();
  if (!expectedToken) {
    throw new HttpError(503, "INTERNAL_ALERT_TOKEN is not configured.");
  }

  const header = String(request.get("authorization") || "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !timingSafeEqualString(match[1].trim(), expectedToken)) {
    throw new HttpError(401, "Unauthorized.");
  }
}

function getAlertEventStatusCounts(db) {
  return db
    .prepare(`
      SELECT status, COUNT(*) AS count
      FROM alert_events
      GROUP BY status
      ORDER BY status ASC
    `)
    .all()
    .reduce((counts, row) => {
      counts[row.status] = row.count;
      return counts;
    }, {});
}


app.use(cors());
app.use(express.json());

app.use((request, response, next) => {
  const legacyDashboardRoutes = ["/military", "/untracked"];
  if (
    legacyDashboardRoutes.some(
      (routePath) => request.path === routePath || request.path.startsWith(`${routePath}/`),
    )
  ) {
    response.redirect(301, "/");
    return;
  }

  next();
});

function loadPersistedDashboardSnapshot() {
  const savedValue = getMetaValue(DASHBOARD_SNAPSHOT_META_KEY);
  if (!savedValue) {
    return null;
  }

  try {
    return JSON.parse(savedValue);
  } catch {
    return null;
  }
}

function createDashboardSnapshotManager() {
  let snapshot = loadPersistedDashboardSnapshot();
  let refreshPromise = null;

  function hasSnapshot() {
    return Boolean(snapshot);
  }

  function getSnapshot() {
    if (process.env.EWS_EXTERNAL_REFRESH === "1") return readPublishedJson("dashboard.json");
    return snapshot;
  }

  async function refresh({ reason = "manual" } = {}) {
    if (process.env.EWS_EXTERNAL_REFRESH === "1") return getSnapshot();
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = Promise.resolve()
      .then(() => {
        const nextSnapshot = buildDashboardSnapshot({
          liveStatus: heatmapRefresher.getStatus(),
        });
        snapshot = nextSnapshot;
        setMetaValue(DASHBOARD_SNAPSHOT_META_KEY, JSON.stringify(nextSnapshot));
        return nextSnapshot;
      })
      .catch((error) => {
        console.error(`Dashboard snapshot refresh failed (${reason}):`, error);
        if (snapshot) {
          return snapshot;
        }
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });

    return refreshPromise;
  }

  async function ensureReady() {
    if (process.env.EWS_EXTERNAL_REFRESH === "1") return getSnapshot();
    if (snapshot) {
      return snapshot;
    }

    return refresh({ reason: "startup" });
  }

  return {
    hasSnapshot,
    getSnapshot,
    refresh,
    ensureReady,
  };
}

const dashboardSnapshotManager = createDashboardSnapshotManager();
const heatmapRefresher = createHeatmapCacheRefresher({
  onRefreshComplete({ success }) {
    if (!success) {
      return;
    }

    void dashboardSnapshotManager
      .refresh({ reason: "heatmap_refresh" })
      .then(async (snapshot) => {
        const status = heatmapRefresher.getStatus();
        const rssResult = maybeRecordEmergencyLevelRssItem({
          snapshot,
          status,
        });
        const telegramResult = await maybeSendEmergencyLevelTelegramAlert({
          snapshot,
          status,
        });

        return { rssResult, telegramResult };
      })
      .then(({ rssResult, telegramResult }) => {
        if (rssResult?.updated) {
          console.log(`RSS emergency alert recorded for ${rssResult.latestSlotKey || "latest heatmap"}.`);
        }

        if (telegramResult?.sent) {
          console.log(`Telegram emergency alert sent for ${telegramResult.latestSlotKey || "latest heatmap"}.`);
        }
      })
      .catch((error) => {
        console.error("Emergency alert handling failed:", error);
      });
  },
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    now: new Date().toISOString(),
  });
});

app.get("/api/admin/local-pipeline-status", (request, response) => {
  requireInternalAuth(request);
  const db = getDb();
  const bridgeStatus = readOptionalPublishedJson("alert-bridge-status.json");
  const notificationCryptoConfigured = hasNotificationCrypto();
  response.set("cache-control", "no-store").json({
    ok: true,
    now: new Date().toISOString(),
    publicUrlConfigured: Boolean(cleanPublicUrl(process.env.APP_BASE_URL) || cleanPublicUrl(process.env.EWS_PUBLIC_URL)),
    notificationCryptoConfigured,
    providerConfig: {
      sendgridConfigured: hasEnv("SENDGRID_API_KEY") && hasEnv("SENDGRID_FROM_EMAIL"),
      sendgridWebhookVerificationConfigured: hasEnv("SENDGRID_WEBHOOK_PUBLIC_KEY"),
      sendgridDeliveryStatusConfigured: hasEnv("SENDGRID_WEBHOOK_PUBLIC_KEY") && hasSendGridDeliveryStatusPath(),
      telnyxConfigured:
        hasEnv("TELNYX_API_KEY") &&
        (hasEnv("TELNYX_NUMBER") || hasEnv("TELNYX_FROM_PHONE") || hasEnv("TELNYX_MESSAGING_PROFILE_ID")),
      telnyxWebhookVerificationConfigured: hasEnv("TELNYX_PUBLIC_KEY"),
      telnyxDeliveryStatusConfigured: hasEnv("TELNYX_PUBLIC_KEY") && hasTelnyxDeliveryStatusPath(),
      stripeConfigured: hasEnv("STRIPE_SECRET_KEY") && hasEnv("STRIPE_PRICE_ID"),
      telegramEmergencyConfigured: hasEnv("TELEGRAM_BOT_TOKEN") && hasEnv("TELEGRAM_CHANNEL"),
      webPushConfigured: isWebPushConfigured(process.env),
    },
    bridge: bridgeStatus.available
      ? {
          available: true,
          ...bridgeStatus.payload,
        }
      : bridgeStatus,
    feeds: {
      alerts: summarizePublishedFeed("alerts.json", "events"),
      takeoffs: summarizePublishedFeed("takeoffs.json", "events"),
      eventSignals: summarizePublishedFeed("event-signals.json", "records"),
    },
    localDispatch: {
      activeSubscriberCount: countActiveSubscribers(db),
      alertStatusCounts: getAlertEventStatusCounts(db),
      recentAlertEvents: listAlertEvents(db, { limit: 10 }),
    },
  });
});

app.get("/api/watchlist", (_request, response) => {
  const watchlist = readWatchlist();
  response.json({
    configured: watchlist.configured,
    reason: watchlist.reason || null,
    entries: watchlist.entries,
  });
});

app.get("/api/cohort", (_request, response) => {
  response.json(getTrackingSummary());
});

app.get("/api/takeoffs", (request, response) => {
  const limit = Math.min(Math.max(Number(request.query.limit) || 100, 1), 500);
  response.json({
    events: readAcrossDashboardDbs(listTakeoffEvents, "observedAt", limit),
  });
});

app.get("/api/alerts", (request, response) => {
  const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
  response.json({
    events: listAlertEvents(getDb(), { limit }),
  });
});

app.get("/api/event-signals", (_request, response) => {
  response.set("cache-control", "no-store").json(readPublishedJson("event-signals.json"));
});

mountWatchRoutes(app, { getDb: () => watchDb, requireInternalAuth });
mountStatusRoutes(app, { getDbPath: () => DB_PATH });

// In-process fixed-window rate limiter for the public write endpoints. The
// server sits behind the Cloudflare tunnel, so the socket address is always
// loopback — CF-Connecting-IP is the real client (loopback fallback covers
// direct ssh-tunnel access).
const rateBuckets = new Map();
function rateLimit(name, limit, windowMs) {
  return (request, _response, next) => {
    const ip = String(request.get("cf-connecting-ip") || request.ip || "local").trim();
    const key = `${name}:${ip}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      rateBuckets.set(key, { windowStart: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      throw new HttpError(429, "Too many requests. Try again later.");
    }
    next();
  };
}
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.windowStart < cutoff) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

const signupLimiter = rateLimit("signup", 10, 60 * 60 * 1000);
const confirmLimiter = rateLimit("confirm", 30, 60 * 60 * 1000);
const pushLimiter = rateLimit("push", 30, 60 * 60 * 1000);

app.post("/api/notifications/signup", signupLimiter, async (request, response) => {
  const db = getDb();
  const subscriber = upsertSubscriber(db, request.body, process.env);
  const confirmations = await sendPendingConfirmations(db, process.env, subscriber.id);
  response.json({
    ok: true,
    ...subscriber,
    subscriber,
    confirmations,
  });
});

app.get("/api/notifications/confirm", confirmLimiter, (request, response) => {
  const result = confirmSubscriberChannel(getDb(), process.env, {
    subscriberId: request.query.subscriber,
    channel: String(request.query.channel || ""),
    token: String(request.query.token || ""),
  });
  response.set("cache-control", "no-store").json({ ok: true, ...result });
});

app.get("/confirm", confirmLimiter, (request, response) => {
  const result = confirmSubscriberChannel(getDb(), process.env, {
    subscriberId: request.query.subscriber,
    channel: String(request.query.channel || ""),
    token: String(request.query.token || ""),
  });
  const channelLabel = result.channel === "sms" ? "phone number" : "email address";
  response
    .set("cache-control", "no-store")
    .type("html")
    .send([
      "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
      "<title>Subscription confirmed</title>",
      "<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.5rem;color:#1a1a1a}a{color:#0a5}</style>",
      "</head><body>",
      "<h1>Confirmed</h1>",
      `<p>Your ${channelLabel} is confirmed. You will now receive airborne-anomaly alerts from this instrument.</p>`,
      `<p><a href="${result.managementPath}">Manage or unsubscribe</a> &middot; <a href="/">Dashboard</a></p>`,
      "</body></html>",
    ].join(""));
});

app.get("/api/push/vapid-public-key", (_request, response) => {
  if (!isWebPushConfigured(process.env)) {
    response.status(503).json({ error: "Browser push is not configured." });
    return;
  }
  response.set("cache-control", "no-store").json({
    ok: true,
    configured: isWebPushConfigured(process.env),
    publicKey: getVapidPublicKey(process.env),
  });
});

app.post("/api/push/subscribe", pushLimiter, (request, response) => {
  if (!isWebPushConfigured(process.env)) {
    response.status(503).json({ error: "Browser push is not configured." });
    return;
  }
  const subscriber = upsertPushSubscriber(getDb(), request.body, process.env, {
    userAgent: request.get("user-agent"),
  });
  response.json({
    ok: true,
    pushEnabled: true,
    subscriber,
  });
});

app.delete("/api/push/subscribe", (request, response) => {
  if (!isWebPushConfigured(process.env)) {
    response.status(503).json({ error: "Browser push is not configured." });
    return;
  }
  const result = unsubscribePushSubscriber(getDb(), request.body, process.env);
  response.json({
    ok: true,
    ...result,
  });
});

app.get("/api/manage/subscriber", (request, response) => {
  const subscriber = getManagedSubscriber(getDb(), process.env, request.query.subscriber, request.query.token);
  response.set("cache-control", "no-store").json({
    ok: true,
    subscriber,
  });
});

app.post("/api/manage/subscriber", (request, response) => {
  const subscriber = updateManagedSubscriber(getDb(), process.env, request.body);
  response.set("cache-control", "no-store").json({
    ok: true,
    subscriber,
  });
});
app.get("/api/dashboard", (_request, response) => {
  const snapshot = dashboardSnapshotManager.getSnapshot();
  if (!snapshot) {
    response.status(503).json({
      error: "Dashboard snapshot is not ready yet.",
    });
    return;
  }

  response.set("Cache-Control", "no-store").json(snapshot);
});

for (const [routePath, fileName] of PUBLISHED_DASHBOARD_FILES) {
  app.get(routePath, (_request, response) => {
    const snapshotPath = path.join(PUBLISHED_DIR, fileName);
    if (!fs.existsSync(snapshotPath)) {
      response.status(503).json({
        error: `Published dashboard snapshot  is not available.`,
      });
      return;
    }

    response
      .type("application/json")
      .set("Cache-Control", "no-store")
      .sendFile(snapshotPath);
  });
}

app.get(["/rss.xml", "/feed.xml"], (_request, response) => {
  const items = dedupeRssItems([
    ...listAlertEvents(getDb(), { limit: 100 }).map((event) => rssItemFromAlertEvent(event)),
    ...getRssItems(),
  ]);
  response
    .type("application/rss+xml")
    .set("Cache-Control", "public, max-age=60")
    .send(buildEmergencyRssFeedXml({ items }));
});

app.use((error, _request, response, _next) => {
  const status = error instanceof HttpError ? error.status : 500;
  response.status(status).json({
    error: error.message || "Unexpected server error.",
  });
});

if (fs.existsSync(CLIENT_DIST_DIR)) {
  app.use(express.static(CLIENT_DIST_DIR));
  app.get("/{*asset}", (_request, response) => {
    response.sendFile(path.join(CLIENT_DIST_DIR, "index.html"));
  });
}

async function start() {
  initDb();
  const watchlist = readWatchlist();
  if (watchlist.entries.length) {
    upsertTrackedAircraft(watchlist.entries);
  }

  const hadPersistedSnapshot = dashboardSnapshotManager.hasSnapshot();
  const embeddedRefresh = process.env.EWS_EXTERNAL_REFRESH !== "1";
  if (embeddedRefresh) await dashboardSnapshotManager.ensureReady();

  app.listen(PORT, HOST, () => {
    console.log(`EWS server listening on http://${HOST}:${PORT}`);
  });

  heatmapRefresher.start();
  if (embeddedRefresh && hadPersistedSnapshot) {
    void dashboardSnapshotManager.refresh({ reason: "startup_rebuild" });
  }
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
