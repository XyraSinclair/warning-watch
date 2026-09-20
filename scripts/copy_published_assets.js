const fs = require("node:fs");
const path = require("node:path");
const REPO_ROOT = path.resolve(__dirname, "..");

const REQUIRED_PUBLISHED_ASSETS = [
  "dashboard.json",
  "military-dashboard.json",
  "untracked-dashboard.json",
  "event-signals.json",
];

function copyPublishedAssets(options = {}) {
  const sourceDir = options.sourceDir || path.join(REPO_ROOT, "data", "published");
  const targetDir = options.targetDir || path.join(REPO_ROOT, "dist");
  const requiredAssets = options.requiredAssets || REQUIRED_PUBLISHED_ASSETS;

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Published data directory does not exist: ${sourceDir}`);
  }

  const jsonFiles = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const jsonFileSet = new Set(jsonFiles);
  const missingAssets = requiredAssets.filter((fileName) => !jsonFileSet.has(fileName));
  if (missingAssets.length > 0) {
    throw new Error(`Published data directory is missing required asset(s): ${missingAssets.join(", ")}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  for (const fileName of jsonFiles) {
    fs.copyFileSync(path.join(sourceDir, fileName), path.join(targetDir, fileName));
  }

  return {
    sourceDir,
    targetDir,
    copied: jsonFiles,
  };
}

if (require.main === module) {
  const result = copyPublishedAssets();
  console.log(JSON.stringify({ ok: true, copied: result.copied.length, files: result.copied }));
}

module.exports = {
  REQUIRED_PUBLISHED_ASSETS,
  copyPublishedAssets,
};
