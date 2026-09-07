import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { projectRoot, prepareRunDir, writeFileSync } from "./store.js";
import { waitForReady, sleep } from "./wait.js";
import { captureSession } from "./capture.js";
import { execa } from "./exec.js";
import { resolvePorts, describeShifts, formatPortMap } from "./ports.js";

// ---------------------------------------------------------------------------
// Browser runtime (Selenium Standalone Chrome + XFCE desktop).
//
// Self-contained: the build context lives inside this repo (`./browser`), so
// `ebk` does not depend on any external project. The base image
// `selenium/standalone-chrome` already provides Chrome + WebDriver + Xvfb +
// VNC + noVNC; the vendored Dockerfile layers a real desktop on top.
// ---------------------------------------------------------------------------

export const BROWSER_IMAGE = "selenium/standalone-chrome:latest";

const DEFAULT_ENV = {
  SE_SCREEN_WIDTH: "1920",
  SE_SCREEN_HEIGHT: "1080",
  SE_SCREEN_DEPTH: "24",
  SE_SCREEN_DPI: "96",
  SE_START_XVFB: "true",
  SE_START_VNC: "true",
  SE_START_NO_VNC: "true",
  SE_NO_VNC_PORT: "7900",
  SE_VNC_PORT: "5900",
  DISPLAY: ":99.0",
  DISPLAY_NUM: "99",
};

function browserRunId() {
  return crypto.randomBytes(4).toString("hex");
}

export function browserBuildDir(extra = {}) {
  return extra.buildDir || path.join(projectRoot(), "browser");
}

/**
 * Build the docker-compose service for a disposable browser container.
 *
 * @param {object} opts
 * @param {string} [opts.runId]          unique id used for names/paths
 * @param {object} [opts.ports]          { selenium, vnc, noVnc } host mappings
 * @param {object} [opts.extra]          { buildDir, browserImage, vncPassword, shmSize }
 */
export function buildBrowserService(opts = {}) {
  const { runId, ports = {}, extra = {} } = opts;
  const seleniumPort = ports.selenium || 4444;
  const vncPort = ports.vnc || 5900;
  const noVncPort = ports.noVnc || 7900;
  const image = extra.browserImage;

  const svc = {
    container_name: `browser-${runId}`,
    environment: {
      ...DEFAULT_ENV,
      ...(extra.vncPassword ? { VNC_PASSWORD: extra.vncPassword } : {}),
    },
    volumes: ["/dev/shm:/dev/shm"],
    shm_size: extra.shmSize || "2gb",
    restart: "unless-stopped",
    ports: [`${seleniumPort}:4444`, `${vncPort}:5900`, `${noVncPort}:7900`],
  };

  // Either pull/build a named image, or build from a local context dir.
  if (image) {
    svc.image = image;
  } else {
    svc.build = { context: browserBuildDir(extra) };
  }

  return svc;
}

export function buildBrowserCompose(opts = {}) {
  const svc = buildBrowserService(opts);
  const doc = { services: { [opts.runId]: svc } };
  return yaml.dump(doc, { lineWidth: 200, noRefs: true });
}

/**
 * Probe the Selenium WebDriver and resolve { exitCode } (0 = ready).
 * Mirror of the executable probe contract used by `waitForReady`.
 */
export function seleniumReady(host = "127.0.0.1", seleniumPort = 4444, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const statusPaths = ["/wd/hub/status", "/status"];
    let idx = 0;

    const attempt = () => {
      if (idx >= statusPaths.length) return resolve({ exitCode: 1 });
      const p = statusPaths[idx++];
      const req = http.get(`http://${host}:${seleniumPort}${p}`, { timeout: timeoutMs }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          let ready = false;
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(body);
              ready = !!(json && json.value && json.value.ready);
            } catch {
              ready = false;
            }
          }
          resolve({ exitCode: ready ? 0 : 1 });
        });
        res.on("error", () => resolve({ exitCode: 1 }));
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({ exitCode: 1 });
      });
      req.on("error", () => resolve({ exitCode: 1 }));
    };

    attempt();
  });
}

// --- state ---------------------------------------------------------------

const STATE_REL = path.join("storage", "browser-state.json");

export function browserStatePath(root = projectRoot()) {
  return path.join(root, STATE_REL);
}

export function writeBrowserState(state) {
  const p = browserStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

export function readBrowserState(root = projectRoot()) {
  const p = browserStatePath(root);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// --- lifecycle -----------------------------------------------------------

/**
 * Start a browser container and wait until WebDriver + noVNC are ready.
 * Keeps running (no cleanup) so the caller can use WebDriver / noVNC.
 */
export async function startBrowser(opts = {}) {
  const {
    runId = browserRunId(),
    ports = {},
    extra = {},
    resources = {},
    wait = {},
    log,
  } = opts;

  // One browser at a time: refuse to start a second instance. Otherwise the
  // host ports collide and the persisted state gets overwritten, orphaning the
  // first container.
  const existing = await browserStatus();
  if (existing.running) {
    throw new Error(
      `A browser container is already running (${existing.state.containerName}). Use \`ebk browser down\` first.`,
    );
  }

  // Resolve host ports, shifting to the next free port when one is occupied.
  const requestedPorts = {
    selenium: ports.selenium || 4444,
    vnc: ports.vnc || 5900,
    noVnc: ports.noVnc || 7900,
  };
  const resolvedPorts = await resolvePorts(requestedPorts, { host: ports.host });
  const seleniumPort = resolvedPorts.selenium;
  const vncPort = resolvedPorts.vnc;
  const noVncPort = resolvedPorts.noVnc;
  const shifts = describeShifts(requestedPorts, resolvedPorts);
  if (shifts.length) log.info(`[browser] ports shifted: ${shifts.join(", ")}`);
  log.info(`[browser] ports: ${formatPortMap(resolvedPorts)}`);

  const paths = prepareRunDir({ osId: "browser", runId, root: projectRoot() });
  const compose = buildBrowserCompose({ runId, ports: resolvedPorts, extra, resources });
  const composeFile = writeFileSync(paths.composeFile, compose);

  log.info(`[browser] runId=${runId}`);
  log.info(`[browser] compose=${composeFile}`);

  const upArgs = ["compose", "-f", composeFile, "up", "-d"];
  if (!extra.browserImage) upArgs.push("--build");
  const up = await execa("docker", upArgs, { cwd: paths.runDir });
  process.stdout.write(up.stdout || "");
  process.stderr.write(up.stderr || "");
  if (up.exitCode !== 0) {
    throw new Error(`docker compose up failed (${up.exitCode}): ${up.stderr?.slice(-1000) || ""}`);
  }

  const containerName = `browser-${runId}`;
  await waitForReady({
    containerName,
    webPort: noVncPort,
    markers: [],
    hasProbe: true,
    probe: () => seleniumReady("127.0.0.1", seleniumPort),
    bootSettleMs: wait.bootSettleMs || 0,
    timeoutMs: wait.timeoutMs || 600000,
    log,
  });

  const state = {
    runId,
    containerName,
    composeFile,
    runDir: paths.runDir,
    storageDir: paths.storageDir,
    seleniumPort,
    vncPort,
    noVncPort,
    vncPassword: extra.vncPassword || "secret",
    image: extra.browserImage || null,
    buildDir: browserBuildDir(extra),
  };
  writeBrowserState(state);

  return { ...state, paths };
}

/** Report whether a browser container is running (reads persisted state). */
export async function browserStatus() {
  const state = readBrowserState();
  if (!state) return { running: false, state: null, status: "none" };
  const inspect = await execa("docker", [
    "inspect",
    "-f",
    "{{.State.Status}} running={{.State.Running}}",
    state.containerName,
  ]);
  const status = inspect.stdout?.trim() || "missing";
  const running = status.includes("running=true");
  return { running, status, state };
}

/**
 * Stop and remove the browser container started by `startBrowser`, plus its
 * compose dir, storage dir and the persisted state file. Honors `keep`.
 */
export async function stopBrowser({ keep = false } = {}) {
  const state = readBrowserState();
  const log = console;
  if (!state) {
    log.warn("[browser] no persisted state; nothing to stop.");
    return { stopped: false, state: null };
  }

  if (fs.existsSync(state.composeFile)) {
    const down = await execa("docker", [
      "compose",
      "-f",
      state.composeFile,
      "down",
      "-v",
      "--remove-orphans",
    ], { cwd: state.runDir });
    process.stdout.write(down.stdout || "");
    process.stderr.write(down.stderr || "");
  } else {
    log.warn("[browser] compose file missing; removing container by name.");
    await execa("docker", ["rm", "-f", state.containerName]);
  }

  if (keep) return { stopped: true, state };

  for (const dir of [state.runDir, state.storageDir]) {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  const sp = browserStatePath();
  if (fs.existsSync(sp)) fs.rmSync(sp, { force: true });

  return { stopped: true, state };
}

// --- full pipeline -------------------------------------------------------

const RESULT_RE = /^RESULT[\w.-]*\.(log|json|txt)$/i;

/**
 * Full pipeline: up -> wait ready -> capture (video/screenshots) + optionally
 * wait for a guest result marker -> collect logs -> cleanup (unless keep).
 */
export async function browserRun(opts = {}) {
  const {
    runId = browserRunId(),
    ports = {},
    extra = {},
    resources = {},
    testDir,
    camera = {},
    wait = {},
    keep = false,
    log,
  } = opts;

  const state = await startBrowser({ runId, ports, extra, resources, wait, log });

  const controller = new AbortController();
  const sessionUrl = `http://127.0.0.1:${state.noVncPort}/`;
  const capturePromise =
    camera.record || camera.screenshotEveryMs
      ? captureSession({
          url: sessionUrl,
          screenshotsDir: state.paths.screenshotsDir,
          videoDir: state.paths.artifactsDir,
          screenshotEveryMs: camera.screenshotEveryMs,
          signal: controller.signal,
          log,
        })
      : Promise.resolve({ screenshots: null, video: null, connected: false });

  let result = { success: false, reason: "timeout" };
  if (testDir) {
    result = await waitForTestResult({ testDir, runId, testTimeoutMs: opts.testTimeoutMs, log });
    controller.abort();
  } else if (camera.durationMs > 0) {
    await sleep(camera.durationMs);
    controller.abort();
    result = { success: true, reason: "duration", marker: null };
  }

  const capture = await capturePromise.catch((e) => {
    log.error(`[browser] capture error: ${e.message}`);
    return { screenshots: null, video: null, connected: false };
  });

  await collectLogs({ state, log });

  if (!keep) {
    await stopBrowser({ keep });
  }

  return {
    runId,
    success: result.success,
    reason: result.reason,
    capture,
    state,
  };
}

async function waitForTestResult({ testDir, runId, testTimeoutMs = 20 * 60 * 1000, log }) {
  if (!testDir || !fs.existsSync(testDir)) {
    log.warn("[browser] No test dir mounted; nothing to wait for.");
    return { success: false, reason: "no-test-dir" };
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < testTimeoutMs) {
    for (const name of fs.readdirSync(testDir)) {
      if (RESULT_RE.test(name)) {
        const full = path.join(testDir, name);
        const content = fs.readFileSync(full, "utf8");
        const matchesExpected = name.startsWith(`RESULT_${runId}`);
        if (matchesExpected) {
          const success = /(^|\W)(pass|success|ok|0)(\W|$)/i.test(content);
          log.info(`[browser] test marker: ${name} -> ${content.trim().slice(0, 120)}`);
          return { success, reason: "marker", marker: full };
        }
      }
    }
    await sleep(3000);
  }
  log.error("[browser] timed out waiting for a RESULT_* marker in the test dir.");
  return { success: false, reason: "timeout" };
}

async function collectLogs({ state, log }) {
  const logsPath = path.join(state.paths.logsDir, "container.log");
  try {
    const { stdout, stderr } = await execa("docker", ["logs", state.containerName]);
    const payload = (stdout || "") + (stderr ? `\n--- STDERR ---\n${stderr}` : "");
    writeFileSync(logsPath, payload);
    log.info(`[browser] container logs -> ${logsPath}`);
  } catch (e) {
    log.warn(`[browser] could not dump container logs: ${e.message}`);
  }
}
