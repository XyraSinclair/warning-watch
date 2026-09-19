#!/usr/bin/env node

// Weekly synthetic delivery canary (ROADMAP D3). An alert system that almost
// never fires must prove its delivery path continuously, or it is dead code
// with a subscriber list. This script verifies, through the PUBLIC path
// (domain -> Cloudflare tunnel -> box), that:
//
//   1. the site answers (/api/health),
//   2. the RSS feed serves,
//   3. a message published to the ops ntfy topic is actually retrievable by a
//      subscriber (publish via public URL with the auth token, then poll it
//      back anonymously — the full end-to-end push path).
//
// Email/SMS join the canary when their providers are configured. Any failure
// exits 1, which leaves the oneshot unit in "failed" state; status.js watches
// the unit, so the hourly ops watchdog (which publishes via LOOPBACK ntfy —
// deliberately a different path than this script) pages about a broken canary
// even when the public path is what died.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '..');

function loadEnvFile(filePath) {
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // Optional file.
  }
}

loadEnvFile('/etc/warning-watch.env');
loadEnvFile(path.join(ROOT_DIR, '.env'));

const PUBLIC_URL = String(process.env.EWS_PUBLIC_URL || 'https://warning.watch').replace(/\/+$/, '');
const NTFY_PUBLIC = String(process.env.EWS_NTFY_PUBLIC_SERVER || 'https://ntfy.warning.watch').replace(/\/+$/, '');
const OPS_TOPIC = String(process.env.EWS_NTFY_OPS_TOPIC || '').trim();
const NTFY_TOKEN = String(process.env.EWS_NTFY_TOKEN || '').trim();

const checks = [];

// A check is verified, skipped, or failed. A channel nobody exercised is
// `skipped`; it is never reported as ok.
async function check(name, fn) {
  try {
    const outcome = await fn();
    if (outcome?.skipped) checks.push({ name, status: 'skipped', detail: outcome.skipped });
    else checks.push({ name, status: 'verified' });
  } catch (error) {
    checks.push({ name, status: 'failed', error: error.message });
  }
}

async function fetchOk(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response;
}

async function main() {
  const canaryId = `canary-${crypto.randomBytes(6).toString('hex')}`;

  await check('site_health', async () => {
    const payload = await (await fetchOk(`${PUBLIC_URL}/api/health`)).json();
    if (!payload.ok) throw new Error('health payload not ok');
  });

  await check('rss', async () => {
    const body = await (await fetchOk(`${PUBLIC_URL}/rss.xml`)).text();
    if (!body.includes('<rss')) throw new Error('response is not an RSS document');
  });

  await check('ntfy_roundtrip', async () => {
    if (!OPS_TOPIC || !NTFY_TOKEN) throw new Error('EWS_NTFY_OPS_TOPIC / EWS_NTFY_TOKEN not configured');
    const soFar = checks.every((entry) => entry.status === 'verified') ? 'site and RSS verified' : 'site or RSS FAILED — see status';
    await fetchOk(`${NTFY_PUBLIC}/${OPS_TOPIC}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NTFY_TOKEN}`,
        Title: 'Weekly delivery canary',
        Priority: 'min',
        Tags: 'hatching_chick',
      },
      body: `Synthetic end-to-end delivery proof (${canaryId}): ${soFar}. This message travelled the full public path subscribers use.`,
    });
    const poll = await (await fetchOk(`${NTFY_PUBLIC}/${OPS_TOPIC}/json?poll=1&since=5m`)).text();
    if (!poll.includes(canaryId)) throw new Error('published canary message not retrievable by subscriber poll');
  });

  await check('email_channel', async () => {
    if (!String(process.env.SENDGRID_API_KEY || '').trim()) return { skipped: 'provider not configured' };
    return { skipped: 'provider configured, but no live-send canary exists yet: delivery is unproven' };
  });

  await check('sms_channel', async () => {
    if (!String(process.env.TELNYX_API_KEY || '').trim()) return { skipped: 'provider not configured' };
    return { skipped: 'provider configured, but no live-send canary exists yet: delivery is unproven' };
  });

  const failed = checks.filter((entry) => entry.status === 'failed');
  const names = (status) => checks.filter((entry) => entry.status === status).map((entry) => entry.name);
  console.log(JSON.stringify({ ok: failed.length === 0, canaryId, verified: names('verified'), skipped: names('skipped'), failed: names('failed'), checks }));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, fatal: error.message, checks }));
  process.exit(1);
});
