import net from "node:net";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_MAX = 65535;
const DEFAULT_SCAN_RANGE = 100;

/**
 * Check whether a TCP port on the host is available (i.e. can be bound).
 *
 * Implemented by attempting to bind; a successful bind means the port is free
 * while EADDRINUSE (or any bind error) means it is occupied. Node enables
 * SO_REUSEADDR by default so TIME_WAIT sockets are not reported as busy.
 *
 * A transient self-bound server is used only as a probe and released right
 * away, so other processes (Docker publishing on 0.0.0.0) are detected.
 *
 * @param {number} port
 * @param {string} [host="0.0.0.0"]
 * @param {number} [timeoutMs=1000]
 * @returns {Promise<boolean>}
 */
export function isPortAvailable(port, host = DEFAULT_HOST, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve(false);
      return;
    }
    const server = net.createServer();
    const timer = setTimeout(() => {
      try { server.close(); } catch { /* noop */ }
      resolve(false);
    }, timeoutMs);
    server.once("error", () => {
      clearTimeout(timer);
      try { server.close(); } catch { /* noop */ }
      resolve(false);
    });
    server.listen(port, host, () => {
      clearTimeout(timer);
      try { server.close(); } catch { /* noop */ }
      resolve(true);
    });
  });
}

/** Inverse of {@link isPortAvailable}. */
export function isPortOccupied(port, host = DEFAULT_HOST, timeoutMs = 1000) {
  return isPortAvailable(port, host, timeoutMs).then((available) => !available);
}

/**
 * Find the next free port starting at `desired`, scanning upward by +1.
 *
 * `reserved` holds ports already allocated within the same run so that
 * independent logical ports never collide with each other.
 *
 * @param {number} desired
 * @param {object} [opts]
 * @param {string} [opts.host="0.0.0.0"]
 * @param {number} [opts.max=65535]
 * @param {Set<number>} [opts.reserved]
 * @param {number} [opts.scanRange=100]
 * @param {number} [opts.timeoutMs=1000]
 * @returns {Promise<number>}
 */
export async function findFreePort(desired, opts = {}) {
  const {
    host = DEFAULT_HOST,
    max = DEFAULT_MAX,
    reserved = new Set(),
    scanRange = DEFAULT_SCAN_RANGE,
    timeoutMs = 1000,
  } = opts;

  if (!Number.isInteger(desired) || desired < 1 || desired > 65535) {
    throw new Error(`Invalid requested port: ${desired}`);
  }

  const limit = Math.min(max, desired + scanRange);
  for (let p = desired; p <= limit; p++) {
    if (reserved.has(p)) continue;
    if (await isPortAvailable(p, host, timeoutMs)) return p;
  }
  throw new Error(
    `No free port found in [${desired}, ${limit}]` +
      (reserved.size ? ` (reserved: ${[...reserved].join(",")})` : ""),
  );
}

/**
 * Resolve a batch of logical ports to concrete host ports.
 *
 * Each requested port is passed through {@link findFreePort} and the result is
 * added to a shared `reserved` set, guaranteeing the whole mapping is collision
 * free both against the host and against the other requested ports.
 *
 * @param {Record<string, number|undefined>} requested e.g. { web: 8006, vnc: 5900 }
 * @param {object} [opts] forwarded to {@link findFreePort}
 * @returns {Promise<Record<string, number>>}
 */
export async function resolvePorts(requested, opts = {}) {
  const resolved = {};
  const reserved = new Set(opts.reserved || []);
  for (const [name, desired] of Object.entries(requested)) {
    if (desired == null) continue;
    const p = await findFreePort(desired, { ...opts, reserved });
    reserved.add(p);
    resolved[name] = p;
  }
  return resolved;
}

/**
 * Describe which ports had to be shifted ("后延") from their requested value.
 *
 * @param {Record<string, number|undefined>} requested
 * @param {Record<string, number>} resolved
 * @returns {string[]} e.g. ["web 8006 -> 8007"]
 */
export function describeShifts(requested, resolved) {
  const shifts = [];
  for (const [name, actual] of Object.entries(resolved)) {
    const wanted = requested[name];
    if (wanted != null && wanted !== actual) shifts.push(`${name} ${wanted} -> ${actual}`);
  }
  return shifts;
}

/** Render a port map as a readable string, e.g. "web=8006 vnc=5900". */
export function formatPortMap(map) {
  return Object.entries(map)
    .map(([name, port]) => `${name}=${port}`)
    .join(" ");
}
