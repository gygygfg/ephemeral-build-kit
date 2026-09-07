import yaml from "js-yaml";
import { WINDOWS_IMAGE, LINUX_IMAGE } from "./catalog.js";

/**
 * Build a docker-compose service dict for a given OS.
 *
 * @param {object} opts
 * @param {object} opts.os        catalog entry ({ type, image, version|boot })
 * @param {string} opts.runId     unique id used for names and paths
 * @param {object} opts.resources { ram, cpu, disk }
 * @param {object} opts.ports     { web, rdp?, ssh? } host-side mappings
 * @param {object} opts.paths     { storage, test, package, oem } host dirs
 * @param {object} opts.extra     misc ({ debug, username, password, language, versionUrl, bootUrl })
 */
export function buildService(opts) {
  const { os, runId, resources = {}, ports = {}, paths = {}, extra = {} } = opts;
  const ram = resources.ram || "4G";
  const cpu = resources.cpu || "2";
  const disk = resources.disk || "64G";

  const isWindows = os.type === "windows";
  const image = extra.image || os.image;

  const svc = {
    image,
    container_name: `${os.id}-${runId}`,
    environment: {
      RAM_SIZE: ram,
      CPU_CORES: String(cpu),
      DISK_SIZE: disk,
    },
    devices: ["/dev/kvm", "/dev/net/tun"],
    cap_add: ["NET_ADMIN"],
    restart: "no",
    stop_grace_period: "2m",
  };

  // Operating-system selector: VERSION (Windows) or BOOT (Linux).
  if (isWindows) {
    svc.environment.VERSION = extra.versionUrl || os.version;
  } else {
    svc.environment.BOOT = extra.bootUrl || os.boot;
  }

  // Windows guest tuning.
  if (isWindows) {
    if (extra.username) svc.environment.USERNAME = extra.username;
    if (extra.password) svc.environment.PASSWORD = extra.password;
    if (extra.language) svc.environment.LANGUAGE = extra.language;
    svc.environment.ALLOCATE = "N";
    svc.environment.REMOVE = "Y";
  }

  if (extra.debug) {
    svc.environment.DEBUG = "Y";
    svc.environment.TRACE = "Y";
  }

  // Port mappings. dockur/windows serves its web UI inside the container on
  // 8006, RDP on 3389; qemus/qemu serves web on 8006 and SSH on 22. Both
  // families also run a native VNC server on 5900 (VNC_PORT). Format is
  // HOST:CONTAINER, so we publish the container port to the chosen host port.
  svc.ports = [];
  if (ports.web) svc.ports.push(`${ports.web}:8006`);
  if (ports.vnc) svc.ports.push(`${ports.vnc}:5900`);
  if (isWindows && ports.rdp) {
    svc.ports.push(`${ports.rdp}:3389/tcp`, `${ports.rdp}:3389/udp`);
  }
  if (!isWindows && ports.ssh) svc.ports.push(`${ports.ssh}:22`);

  // Volume bindings.
  const volumeList = [];
  if (paths.storage) volumeList.push(`${paths.storage}:${isWindows ? "/storage" : "/storage"}`);
  if (paths.test) volumeList.push(`${paths.test}:/shared`);
  if (paths.package) volumeList.push(`${paths.package}:${isWindows ? "/oem" : "/package"}`);
  if (paths.oem) volumeList.push(`${paths.oem}:/oem`);
  if (volumeList.length) svc.volumes = volumeList;

  return svc;
}

export function buildCompose(opts) {
  const svc = buildService(opts);

  const doc = {
    services: {
      [opts.runId]: svc,
    },
  };

  const versionLine = yaml.dump(doc, { lineWidth: 200, noRefs: true });
  return versionLine;
}

export function serviceImage(type) {
  return type === "windows" ? WINDOWS_IMAGE : LINUX_IMAGE;
}
