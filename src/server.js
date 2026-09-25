import express from 'express';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb', strict: true }));

const startedAt = Date.now();
const port = Number(process.env.PORT || 10000);
const mongoUri = process.env.MONGODB_URI?.trim();
const dbName = process.env.DB_NAME?.trim() || 'traffic_agent';
const collectionName = process.env.COLLECTION_NAME?.trim() || 'events';
const deviceToken = process.env.DEVICE_TOKEN?.trim();
const ttlDays = Number(process.env.TTL_DAYS || 30);
const logEventDetails = String(process.env.LOG_EVENT_DETAILS || 'false').toLowerCase() === 'true';
const heartbeatMs = Math.max(15000, Number(process.env.TELEMETRY_HEARTBEAT_MS || 60000));
const maxBatch = Math.min(100, Math.max(1, Number(process.env.MAX_BATCH || 50)));

if (!mongoUri) throw new Error('MONGODB_URI is required');
if (!deviceToken || deviceToken.length < 32) throw new Error('DEVICE_TOKEN must be at least 32 characters');
if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > 3650) throw new Error('TTL_DAYS must be between 1 and 3650');
if (!Number.isFinite(heartbeatMs)) throw new Error('TELEMETRY_HEARTBEAT_MS must be a number');

const mongo = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  appName: 'traffic-agent-api'
});

const metrics = {
  requests: 0,
  responses2xx: 0,
  responses4xx: 0,
  responses5xx: 0,
  authAccepted: 0,
  authRejected: 0,
  malformedBatches: 0,
  eventBatches: 0,
  eventsReceived: 0,
  eventsInserted: 0,
  eventInsertErrors: 0,
  notFound: 0,
  lastEventAt: null,
  lastInsertAt: null,
  lastErrorAt: null,
  lastError: null,
  heartbeatFailures: 0,
};

function nowIso() {
  return new Date().toISOString();
}

function requestId() {
  return crypto.randomUUID();
}

function log(level, message, fields = {}) {
  const entry = {
    ts: nowIso(),
    level,
    message,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    ...fields,
  };
  console.log(JSON.stringify(entry));
}

function logError(message, error, fields = {}) {
  const err = error instanceof Error ? error : new Error(String(error));
  metrics.lastErrorAt = nowIso();
  metrics.lastError = err.message.slice(0, 1000);
  log('error', message, {
    ...fields,
    errorName: err.name,
    errorMessage: err.message,
    errorStack: err.stack,
  });
}

function safeEqual(a, b) {
  const aa = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function cleanString(value, max) {
  return typeof value === 'string' && value.length ? value.slice(0, max) : undefined;
}

function eventSummary(e, index) {
  return {
    index,
    host: cleanString(e?.host, 255),
    method: cleanString(e?.method, 16),
    status: Number.isInteger(e?.status) ? e.status : undefined,
    contentType: cleanString(e?.contentType, 255),
    hasUrl: typeof e?.url === 'string' && e.url.length > 0,
    urlLength: typeof e?.url === 'string' ? e.url.length : 0,
    hasQuery: typeof e?.query === 'string' && e.query.length > 0,
    queryLength: typeof e?.query === 'string' ? e.query.length : 0,
  };
}

// Request/response telemetry. Never logs the device token.
app.use((req, res, next) => {
  const id = requestId();
  const started = process.hrtime.bigint();
  metrics.requests += 1;
  req.requestId = id;
  res.setHeader('X-Request-Id', id);

  log('info', 'request_received', {
    requestId: id,
    method: req.method,
    path: req.path,
    queryKeys: Object.keys(req.query || {}),
    userAgent: cleanString(req.get('user-agent'), 300),
    contentLength: Number(req.get('content-length') || 0) || 0,
    forwardedFor: cleanString(req.get('x-forwarded-for'), 200),
  });

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (res.statusCode >= 500) metrics.responses5xx += 1;
    else if (res.statusCode >= 400) metrics.responses4xx += 1;
    else if (res.statusCode >= 200 && res.statusCode < 300) metrics.responses2xx += 1;

    log('info', 'response_sent', {
      requestId: id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      responseContentLength: Number(res.getHeader('content-length') || 0) || 0,
    });
  });

  next();
});

app.get('/healthz', async (req, res) => {
  let mongoOk = false;
  const checkStarted = Date.now();
  try {
    await mongo.db('admin').command({ ping: 1 });
    mongoOk = true;
  } catch (error) {
    logError('healthcheck_mongo_ping_failed', error, { requestId: req.requestId });
  }

  const payload = {
    ok: mongoOk,
    service: 'traffic-agent-api',
    uptimeSec: Math.round(process.uptime()),
    mongo: mongoOk ? 'ok' : 'error',
    mongoPingMs: Date.now() - checkStarted,
    timestamp: nowIso(),
  };

  log(mongoOk ? 'info' : 'error', 'healthcheck', {
    requestId: req.requestId,
    mongoOk,
    mongoPingMs: payload.mongoPingMs,
  });

  res.status(mongoOk ? 200 : 503).json(payload);
});

app.post('/v1/events', async (req, res) => {
  const id = req.requestId;
  const authHeaderPresent = Boolean(req.get('X-Device-Token'));
  const authenticated = safeEqual(req.get('X-Device-Token'), deviceToken);

  log('info', 'event_endpoint_entered', {
    requestId: id,
    authHeaderPresent,
    authenticated,
    bodyType: Array.isArray(req.body) ? 'array' : typeof req.body,
    bodyCount: Array.isArray(req.body) ? req.body.length : null,
  });

  if (!authenticated) {
    metrics.authRejected += 1;
    log('warn', 'event_auth_rejected', { requestId: id, authHeaderPresent });
    return res.status(401).json({ error: 'unauthorized', requestId: id });
  }
  metrics.authAccepted += 1;

  if (!Array.isArray(req.body) || req.body.length > maxBatch) {
    metrics.malformedBatches += 1;
    log('warn', 'event_batch_rejected', {
      requestId: id,
      reason: 'expected_array_or_batch_too_large',
      receivedCount: Array.isArray(req.body) ? req.body.length : null,
      maxBatch,
    });
    return res.status(400).json({ error: `expected a JSON array of at most ${maxBatch} events`, requestId: id });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 86400000);
  const docs = req.body.map((e) => ({
    timestamp: cleanString(e?.timestamp, 64) || now.toISOString(),
    host: cleanString(e?.host, 255),
    url: cleanString(e?.url, 4096),
    method: cleanString(e?.method, 16),
    query: cleanString(e?.query, 2048),
    status: Number.isInteger(e?.status) ? e.status : undefined,
    contentType: cleanString(e?.contentType, 255),
    receivedAt: now,
    expiresAt,
  }));

  metrics.eventBatches += 1;
  metrics.eventsReceived += docs.length;
  if (docs.length > 0) metrics.lastEventAt = nowIso();

  log('info', 'event_batch_validated', {
    requestId: id,
    eventCount: docs.length,
    expiresAt: expiresAt.toISOString(),
    hosts: [...new Set(docs.map((d) => d.host).filter(Boolean))].slice(0, 25),
    methods: [...new Set(docs.map((d) => d.method).filter(Boolean))].slice(0, 25),
    statuses: [...new Set(docs.map((d) => d.status).filter((v) => v !== undefined))].slice(0, 25),
    contentTypes: [...new Set(docs.map((d) => d.contentType).filter(Boolean))].slice(0, 25),
  });

  if (logEventDetails && docs.length) {
    docs.forEach((doc, index) => {
      log('info', 'event_detail', {
        requestId: id,
        ...eventSummary(req.body[index], index),
        host: doc.host,
        method: doc.method,
        status: doc.status,
        url: cleanString(doc.url, 500),
        query: cleanString(doc.query, 500),
      });
    });
  }

  if (!docs.length) {
    log('info', 'empty_event_batch_accepted', { requestId: id });
    return res.status(202).json({ accepted: 0, requestId: id });
  }

  const insertStarted = Date.now();
  try {
    const result = await collection.insertMany(docs, { ordered: false });
    metrics.eventsInserted += result.insertedCount;
    metrics.lastInsertAt = nowIso();

    log('info', 'mongo_insert_succeeded', {
      requestId: id,
      eventCount: docs.length,
      insertedCount: result.insertedCount,
      insertMs: Date.now() - insertStarted,
      mongoCollection: `${dbName}.${collectionName}`,
    });

    return res.status(202).json({
      accepted: result.insertedCount,
      requestId: id,
    });
  } catch (error) {
    metrics.eventInsertErrors += 1;
    logError('mongo_insert_failed', error, {
      requestId: id,
      eventCount: docs.length,
      insertMs: Date.now() - insertStarted,
      mongoCollection: `${dbName}.${collectionName}`,
      errorCode: error?.code,
      insertedCount: error?.result?.insertedCount,
    });

    const partial = Number(error?.result?.insertedCount || 0);
    if (partial > 0) metrics.eventsInserted += partial;

    return res.status(500).json({ error: 'event_storage_failed', requestId: id });
  }
});

app.get('/v1/diagnostics', async (req, res) => {
  const authenticated = safeEqual(req.get('X-Device-Token'), deviceToken);
  if (!authenticated) {
    metrics.authRejected += 1;
    log('warn', 'diagnostics_auth_rejected', {
      requestId: req.requestId,
      authHeaderPresent: Boolean(req.get('X-Device-Token')),
    });
    return res.status(401).json({ error: 'unauthorized', requestId: req.requestId });
  }

  const mongoStarted = Date.now();
  let mongoOk = false;
  let mongoPingMs = null;
  try {
    await mongo.db('admin').command({ ping: 1 });
    mongoOk = true;
    mongoPingMs = Date.now() - mongoStarted;
  } catch (error) {
    mongoPingMs = Date.now() - mongoStarted;
    logError('diagnostics_mongo_ping_failed', error, { requestId: req.requestId });
  }

  log('info', 'diagnostics_requested', {
    requestId: req.requestId,
    mongoOk,
    mongoPingMs,
    metrics,
  });

  res.json({
    ok: mongoOk,
    service: 'traffic-agent-api',
    startedAt: new Date(startedAt).toISOString(),
    now: nowIso(),
    node: process.version,
    env: process.env.NODE_ENV || 'unknown',
    config: {
      dbName,
      collectionName,
      ttlDays,
      maxBatch,
      logEventDetails,
      heartbeatMs,
    },
    mongo: { ok: mongoOk, pingMs: mongoPingMs },
    metrics,
    memory: process.memoryUsage(),
  });
});

app.use((_req, res) => {
  metrics.notFound += 1;
  log('warn', 'route_not_found', { requestId: _req.requestId, method: _req.method, path: _req.path });
  res.status(404).json({ error: 'not_found', requestId: _req.requestId });
});

await mongo.connect();
log('info', 'mongo_connected', {
  mongo: 'connected',
  dbName,
  collectionName,
  ttlDays,
});

const db = mongo.db(dbName);
const collection = db.collection(collectionName);

log('info', 'creating_indexes', { dbName, collectionName });
await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
await collection.createIndex({ receivedAt: -1 });
await collection.createIndex({ host: 1, receivedAt: -1 });
log('info', 'indexes_ready', { dbName, collectionName });

const heartbeat = setInterval(async () => {
  const checkStarted = Date.now();
  try {
    await mongo.db('admin').command({ ping: 1 });
    log('info', 'telemetry_heartbeat', {
      mongoOk: true,
      mongoPingMs: Date.now() - checkStarted,
      metrics,
      memory: process.memoryUsage(),
    });
  } catch (error) {
    metrics.heartbeatFailures += 1;
    logError('telemetry_heartbeat_failed', error, {
      mongoPingMs: Date.now() - checkStarted,
      metrics,
    });
  }
}, heartbeatMs);
heartbeat.unref?.();

const server = app.listen(port, '0.0.0.0', () => {
  log('info', 'server_listening', {
    port,
    host: '0.0.0.0',
    node: process.version,
    environment: process.env.NODE_ENV || 'unknown',
    dbName,
    collectionName,
    ttlDays,
    maxBatch,
    logEventDetails,
    heartbeatMs,
  });
});

async function shutdown(signal) {
  log('info', 'shutdown_started', { signal, metrics });
  clearInterval(heartbeat);
  server.close(async (serverError) => {
    if (serverError) logError('http_server_close_failed', serverError, { signal });
    try {
      await mongo.close();
      log('info', 'mongo_closed', { signal });
    } catch (error) {
      logError('mongo_close_failed', error, { signal });
    }
    process.exit(serverError ? 1 : 0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logError('uncaught_exception', error);
});
process.on('unhandledRejection', (reason) => {
  logError('unhandled_rejection', reason);
});
