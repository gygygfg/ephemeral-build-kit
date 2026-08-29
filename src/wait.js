import net from "node:net";
import { execa } from "./exec.js";

const DEFAULT_MARKERS = [
  /installation finished/i,
  /installation (complete|completed|succeeded)/i,
  /windows is ready/i,
  /desktop is ready/i,
  /install succeeded/i,
  /welcome to (windows|ubuntu|arch|fedora|debian)/i,
  /booted in .*seconds/i,
];

/**
 * Check whether a TCP port is accepting connections.
 * Resolves true when the connection succeeds (or already-open socket).
 */
export function isPortOpen(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/** Fetch the current logs of a container by name. */
async function containerLogs(name, { tail = 400 } = {}) {
  const { stdout } = await execa("docker", ["logs", "--tail", String(tail), name]);
  return stdout || "";
}

/** Check that a container is in the running state. */
async function isContainerRunning(name) {
  const { stdout } = await execa("docker", ["inspect", "-f", "{{.State.Running}}", name]);
  return stdout.trim() === "true";
}

/**
 * Wait until the VM is considered ready.
 *
 * Conditions to become ready:
 *   1. container is running, and
 *   2. the web viewer port accepts connections, and
 *   3a. a configured marker matches the container logs, OR
 *   3b. an optional shell probe exits 0, OR
 *   3c. `bootSettleMs` elapses after the port opened (fallback).
 *
 * @param {object} o
 * @param {string} o.containerName
 * @param {number} o.webPort
 * @param {string} [o.host="127.0.0.1"]
 * @param {RegExp[]} [o.markers]
 * @param {boolean} o.hasProbe
 * @param {() => Promise<boolean>} [o.probe]
 * @param {number} [o.bootSettleMs=0]
 * @param {number} [o.timeoutMs=1800000]
 * @param {number} [o.pollInterval=8000]
 * @param {number} [o.viewerTimeoutMs=600000]
 * @param {import("./logger.js").logger} o.log
 */
export async function waitForReady(opts) {
  const {
    containerName,
    webPort,
    host = "127.0.0.1",
    markers = DEFAULT_MARKERS,
    hasProbe = false,
    probe = null,
    bootSettleMs = 0,
    timeoutMs = 1800000,
    pollInterval = 8000,
    viewerTimeoutMs = 600000,
    log,
  } = opts;

  const startedAt = Date.now();
  let portOpenAt = null;
  let lastSlug = "";

  while (Date.now() - startedAt < timeoutMs) {
    const running = await isContainerRunning(containerName);
    const logs = running ? await containerLogs(containerName) : "";
    const portOpen = await isPortOpen(host, webPort);

    let markerHit = false;
    if (running && logs) {
      for (const m of markers) {
        if (m.test(logs)) {
          markerHit = true;
          break;
        }
      }
    }

    if (portOpen && portOpenAt === null) portOpenAt = Date.now();

    // Compose a human-friendly status line.
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    let slug = `container:${running ? "up" : "down"} viewer:${portOpen ? "up" : "down"}`;
    if (hasProbe) slug += " probe:not-tried";
    if (markerHit) slug = "READY (marker)";
    if (slug !== lastSlug) {
      log.info(`[wait] ${elapsed}s ${slug}`);
      lastSlug = slug;
    }

    const probePassed = hasProbe ? await probeRuns(probe) : false;

    if (running && portOpen && (markerHit || probePassed)) {
      log.info("[wait] Ready signal received.");
      return { containerName, webPort, reason: markerHit ? "marker" : "probe" };
    }

    // Fallback: allow a settle period once the viewer is up.
    if (running && portOpen && bootSettleMs > 0 && portOpenAt !== null) {
      if (Date.now() - portOpenAt >= bootSettleMs) {
        log.info(`[wait] Settled after ${bootSettleMs}ms window.`);
        return { containerName, webPort, reason: "settle" };
      }
    }

    // For Windows installs the viewer comes up before install finishes; only
    // start counting the viewer timeout once the port first opens.
    if (portOpenAt !== null && Date.now() - portOpenAt > viewerTimeoutMs) {
      log.error("[wait] Viewer was up but no ready signal within the viewer timeout.");
      throw new Error("Timed out waiting for a ready signal from the viewer.");
    }

    if (running && portOpen && !markerHit && !probePassed && Date.now() - startedAt > viewerTimeoutMs) {
      log.warn("[wait] No ready marker or probe; continuing after viewer is reachable.");
      return { containerName, webPort, reason: "viewer" };
    }

    await sleep(pollInterval);
  }

  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${containerName}`);
}

async function probeRuns(probe) {
  if (!probe) return false;
  try {
    const { exitCode } = await probe();
    return exitCode === 0;
  } catch {
    return false;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
