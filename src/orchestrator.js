import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildCompose } from "./compose.js";
import { prepareRunDir, projectRoot, writeFileSync, cleanupRun } from "./store.js";
import { waitForReady, sleep } from "./wait.js";
import { captureSession } from "./capture.js";
import { execa } from "./exec.js";

export function makeRunId() {
  return crypto.randomBytes(4).toString("hex");
}

const RESULT_RE = /^RESULT[\w.-]*\.(log|json|txt)$/i;

/**
 * Full pipeline: generate compose -> up -> wait -> run tests (wait for
 * result marker) -> capture -> collect artifacts -> cleanup.
 */
export async function run(opts) {
  const {
    os,
    runId = makeRunId(),
    resources = {},
    ports = {},
    extra = {},
    testDir,
    packageDir,
    oemDir,
    testTimeoutMs = 20 * 60 * 1000,
    camera = {},
    wait = {},
    keep = false,
    log,
  } = opts;

  const webPort = ports.web || 8006;
  const paths = prepareRunDir({ osId: os.id, runId, root: projectRoot() });
  const composeFile = writeFileSync(
    paths.composeFile,
    buildCompose({
      os,
      runId,
      resources,
      ports,
      extra,
      paths: {
        storage: paths.storageDir,
        test: testDir,
        package: packageDir,
        oem: oemDir,
      },
    }),
  );

  log.info(`[run] os=${os.id} runId=${runId}`);
  log.info(`[run] compose=${composeFile}`);

  let upError;
  try {
    const up = await execa("docker", ["compose", "-f", composeFile, "up", "-d", "--pull", "missing"], {
      cwd: paths.runDir,
    });
    process.stdout.write(up.stdout || "");
    process.stderr.write(up.stderr || "");
    if (up.exitCode !== 0) throw new Error(`docker compose up failed (${up.exitCode})`);
  } catch (e) {
    upError = e;
  }

  if (upError) {
    log.error(`[run] ${upError.message}`);
    await cleanupRun({ runDir: paths.runDir, composeFile, storageDir: paths.storageDir, keep });
    throw upError;
  }

  const containerName = `${os.id}-${runId}`;

  // ---- Wait for the VM to become ready ----
  await waitForReady({
    containerName,
    webPort,
    markers: wait.markers,
    hasProbe: Boolean(wait.probe),
    probe: wait.probe,
    bootSettleMs: wait.bootSettleMs,
    timeoutMs: wait.timeoutMs,
    log,
  });

  // ---- Concurrently: capture session + wait for test result marker ----
  const controller = new AbortController();
  const sessionUrl = `http://127.0.0.1:${webPort}/`;
  const capturePromise =
    camera.record || camera.screenshotEveryMs
      ? captureSession({
          url: sessionUrl,
          screenshotsDir: paths.screenshotsDir,
          videoDir: paths.artifactsDir,
          screenshotEveryMs: camera.screenshotEveryMs,
          signal: controller.signal,
          log,
        })
      : Promise.resolve({ screenshots: null, video: null, connected: false });

  let result = { success: false, reason: "timeout" };
  const resultPromise = waitForTestResult({
    testDir,
    runId,
    testTimeoutMs,
    log,
  });

  const settled = await Promise.race([
    resultPromise.then((r) => ({ kind: "result", r })),
    capturePromise.then((c) => ({ kind: "capture-done", c })),
  ]);

  if (settled.kind === "result") {
    result = settled.r;
    controller.abort();
  } else {
    // capture ended first (e.g., video dir finished) -> keep waiting for result.
    result = await resultPromise;
    controller.abort();
  }

  // ---- Collect artifacts ----
  const collector = collectArtifacts({ paths, containerName, testDir, runId, log });
  await collector;

  const capture = await capturePromise.catch((e) => {
    log.error(`[run] capture error: ${e.message}`);
    return { screenshots: null, video: null, connected: false };
  });

  // ---- Cleanup (GitHub-Actions style teardown) ----
  log.info(`[run] cleaning up (keep=${keep})`);
  await cleanupRun({ runDir: paths.runDir, composeFile, storageDir: paths.storageDir, keep });

  return { runId, success: result.success, reason: result.reason, capture, paths };
}

/**
 * Poll the shared test directory for a RESULT_<runId>.* marker written by the
 * guest. Falls back to a generic RESULT_* marker, then times out.
 */
async function waitForTestResult({ testDir, runId, testTimeoutMs, log }) {
  if (!testDir || !fs.existsSync(testDir)) {
    log.warn("[run] No test dir mounted; waiting for the viewer-only settle period.");
    return { success: false, reason: "no-test-dir" };
  }

  const sawOther = new Set();
  const startedAt = Date.now();

  while (Date.now() - startedAt < testTimeoutMs) {
    for (const name of fs.readdirSync(testDir)) {
      if (RESULT_RE.test(name)) {
        const full = path.join(testDir, name);
        const content = fs.readFileSync(full, "utf8");
        const expected = `RESULT_${runId}`;
        const matchesExpected = name.startsWith(expected);
        if (!matchesExpected && !sawOther.has(name)) {
          sawOther.add(name);
          log.info(`[run] found result marker (other): ${name}`);
        }
        if (matchesExpected || sawOther.size > 0) {
          const success = /(^|\W)(pass|success|ok|0)(\W|$)/i.test(content);
          log.info(`[run] test marker: ${name} -> ${content.trim().slice(0, 120)}`);
          return { success, reason: "marker", marker: full };
        }
      }
    }
    await sleep(3000);
  }

  log.error("[run] timed out waiting for a RESULT_* marker in the test dir.");
  return { success: false, reason: "timeout" };
}

async function collectArtifacts({ paths, containerName, testDir, runId, log }) {
  // Dump container logs.
  const logsPath = path.join(paths.logsDir, "container.log");
  try {
    const { stdout, stderr } = await execa("docker", ["logs", containerName]);
    const payload = (stdout || "") + (stderr ? `\n--- STDERR ---\n${stderr}` : "");
    writeFileSync(logsPath, payload);
    log.info(`[run] container logs -> ${logsPath}`);
  } catch (e) {
    log.warn(`[run] could not dump container logs: ${e.message}`);
  }

  // Copy guest result marker + sibling files into artifacts.
  if (testDir && fs.existsSync(testDir)) {
    for (const name of fs.readdirSync(testDir)) {
      if (RESULT_RE.test(name) || /\.(log|json|txt)$/i.test(name)) {
        const src = path.join(testDir, name);
        if (fs.statSync(src).isFile()) {
          const dest = path.join(paths.artifactsDir, name);
          fs.copyFileSync(src, dest);
          log.info(`[run] artifact collected: ${name}`);
        }
      }
    }
  }
}
