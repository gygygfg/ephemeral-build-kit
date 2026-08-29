import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "./exec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function projectRoot() {
  return path.resolve(__dirname, "..");
}

export function defaultPaths(root = projectRoot()) {
  return {
    root,
    composeDir: path.join(root, "compose"),
    storageDir: path.join(root, "storage"),
    artifactsDir: path.join(root, "artifacts"),
  };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create the directory layout for a run.
 * Returns absolute paths to the compose file, storage dir, and artifact dir.
 */
export function prepareRunDir({ osId, runId, root = projectRoot() }) {
  const paths = {
    runDir: path.join(ensureDir(defaultPaths(root).composeDir), `${osId}-${runId}`),
    storageDir: ensureDir(path.join(defaultPaths(root).storageDir, `${osId}-${runId}`)),
    artifactsDir: ensureDir(path.join(defaultPaths(root).artifactsDir, `${osId}-${runId}`)),
  };
  paths.composeFile = path.join(paths.runDir, "docker-compose.yml");
  paths.screenshotsDir = ensureDir(path.join(paths.artifactsDir, "screenshots"));
  paths.logsDir = ensureDir(path.join(paths.artifactsDir, "logs"));
  return paths;
}

/**
 * Write text to a file under the given run dir.
 */
export function writeFileSync(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content);
  return file;
}

/**
 * Tear down everything the run created: container + compose + storage.
 * Optionally keep when `opts.keep` set (container removal happens via
 * `docker compose down` which also removes the container).
 */
export async function cleanupRun({ runDir, composeFile, storageDir, keep = false }) {
  if (runDir && fs.existsSync(composeFile)) {
    const { stdout, stderr } = await execa("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], {
      cwd: runDir,
    });
    process.stdout.write(stdout || "");
    process.stderr.write(stderr || "");
  }

  if (keep) return;

  for (const dir of [runDir, storageDir]) {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function removeArtifactsDir(dir) {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
