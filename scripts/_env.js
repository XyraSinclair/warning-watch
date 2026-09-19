// Shared env loading for scripts: repo root, dotenv-file layering
// (/etc/warning-watch.env then .env, process.env winning), and the
// dashboard-URL validation used by verify_dashboard_bundle.js.
//
// Deliberately no derivation of webhook URLs from display URLs — deriving
// EWS_ALERT_EVENTS_WEBHOOK_URL from EWS_PUBLIC_URL once pointed the alert
// bridge at the upstream reference site (see OPERATIONS.md).

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const SERVICE_ENV_PATH = "/etc/warning-watch.env";
const PROJECT_ENV_PATH = path.join(REPO_ROOT, ".env");
const DEFAULT_ENV_FILES = [SERVICE_ENV_PATH, PROJECT_ENV_PATH];

const REQUIRED_DASHBOARD_ENV_VARS = [
  "VITE_DASHBOARD_URL",
  "VITE_MILITARY_DASHBOARD_URL",
  "VITE_UNTRACKED_DASHBOARD_URL",
];

function parseDotEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function readDotEnvFile(filePath = PROJECT_ENV_PATH) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  const env = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1].startsWith("#")) {
      continue;
    }

    env[match[1]] = parseDotEnvValue(match[2]);
  }

  return env;
}

function readDotEnvFiles(filePaths = DEFAULT_ENV_FILES) {
  const env = {};
  for (const filePath of filePaths) {
    const fileEnv = readDotEnvFile(filePath);
    for (const [key, value] of Object.entries(fileEnv)) {
      if (env[key] === undefined) {
        env[key] = value;
      }
    }
  }
  return env;
}

function getEnvWithDotEnv(baseEnv = process.env, options = {}) {
  const envFiles = options.envFiles || [
    ...(options.extraEnvFiles || []).filter(Boolean),
    ...DEFAULT_ENV_FILES,
  ];
  return {
    ...readDotEnvFiles(envFiles),
    ...baseEnv,
  };
}

function validateDashboardUrl(name, value) {
  if (!value) {
    return `${name} is missing.`;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return `${name} must be an absolute URL.`;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `${name} must use http or https.`;
  }

  if (!url.pathname.endsWith(".json")) {
    return `${name} must point at a .json snapshot.`;
  }

  return null;
}

function validateDashboardEnv(env) {
  return REQUIRED_DASHBOARD_ENV_VARS
    .map((name) => validateDashboardUrl(name, env[name]))
    .filter(Boolean);
}

module.exports = {
  REPO_ROOT,
  SERVICE_ENV_PATH,
  PROJECT_ENV_PATH,
  DEFAULT_ENV_FILES,
  REQUIRED_DASHBOARD_ENV_VARS,
  readDotEnvFile,
  readDotEnvFiles,
  getEnvWithDotEnv,
  validateDashboardEnv,
};
