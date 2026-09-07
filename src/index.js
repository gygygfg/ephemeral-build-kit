#!/usr/bin/env node
import fs from "node:fs";
import { Command } from "commander";
import { logger } from "./logger.js";
import { findOs, listOs } from "./catalog.js";
import { buildCompose } from "./compose.js";
import { prepareRunDir, projectRoot, writeFileSync } from "./store.js";
import { run, makeRunId } from "./orchestrator.js";
import { execa } from "./exec.js";
import { startBrowser, stopBrowser, browserStatus, browserRun } from "./browser.js";
import { resolvePorts, describeShifts, formatPortMap } from "./ports.js";

const VERSION = "0.1.0";

function addCommonOptions(cmd) {
  return cmd
    .option("--ram <size>", "RAM size, e.g. 4G (default 4G)")
    .option("--cpu <n>", "CPU cores (default 2)")
    .option("--disk <size>", "Disk size, e.g. 64G (default 64G)")
    .option("--test-dir <dir>", "Host dir mounted as the shared/test folder (/shared or Z:)")
    .option("--package-dir <dir>", "Host dir mounted as the package/oem folder (/package or /oem)")
    .option("--oem-dir <dir>", "Host dir mounted to /oem (Windows install.bat)")
    .option("--debug", "Enable verbose DEBUG/TRACE in the guest")
    .option("--username <name>", "Windows username (default Docker)")
    .option("--password <pass>", "Windows password (default admin)")
    .option("--language <lang>", "Windows display language")
    .option("--version-url <url>", "Custom Windows ISO/version URL")
    .option("--boot-url <url>", "Custom Linux image URL")
    .option("--web-port <port>", "Host port for the 8006 web viewer", (v) => Number(v), 8006)
    .option("--vnc-port <port>", "Host port for the native 5900 VNC server", (v) => Number(v), 5900)
    .option("--ssh-port <port>", "Host port for guest SSH (Linux only)", (v) => Number(v))
    .option("--rdp-port <port>", "Host port for guest RDP (Windows only)", (v) => Number(v));
}

function buildOptions(opts) {
  const os = requireOs(opts.os);
  return {
    os,
    resources: { ram: opts.ram, cpu: opts.cpu, disk: opts.disk },
    ports: { web: opts.webPort, vnc: opts.vncPort, rdp: opts.rdpPort, ssh: opts.sshPort },
    extra: {
      debug: opts.debug,
      username: opts.username,
      password: opts.password,
      language: opts.language,
      versionUrl: opts.versionUrl,
      bootUrl: opts.bootUrl,
    },
    testDir: opts.testDir,
    packageDir: opts.packageDir,
    oemDir: opts.oemDir,
  };
}

const program = new Command();
program
  .name("ebk")
  .description("Ephemeral Build Kit: CI-style disposable VM testing for Windows/Linux.")
  .version(VERSION);

program
  .command("list")
  .description("List all supported operating systems.")
  .action(() => {
    const rows = listOs();
    const pad = Math.max(...rows.map((r) => r.id.length)) + 2;
    console.log("Type     Image            OS id" + " ".repeat(Math.max(pad - 5, 0)) + "Selector        Label");
    for (const r of rows) {
      const selector = `${r.type === "windows" ? "VERSION" : "BOOT"}=${r.selector}`;
      console.log(
        `${r.type.padEnd(8)} ${r.image.padEnd(16)} ${r.id.padEnd(pad)} ${selector.padEnd(16)} ${r.label}`,
      );
    }
    console.log(`\nTotal supported OSes: ${rows.length}`);
  });

program
  .command("probe")
  .description("Check Docker, KVM and network TUN availability.")
  .action(async () => {
    let allOk = true;
    const check = async (name, fn) => {
      let ok = false;
      try {
        ok = await fn();
      } catch {
        ok = false;
      }
      console.log(`${ok ? "OK " : "FAIL"}  ${name}`);
      if (!ok) allOk = false;
    };

    await check("docker daemon", async () => (await execa("docker", ["info"])).exitCode === 0);
    await check("device /dev/kvm", () => Promise.resolve(fsExists("/dev/kvm")));
    await check("device /dev/net/tun", () => Promise.resolve(fsExists("/dev/net/tun")));

    console.log(allOk ? "\nAll checks passed." : "\nSome checks failed. See above.");
    process.exit(allOk ? 0 : 1);
  });

addCommonOptions(
  program
    .command("generate")
    .description("Generate a docker-compose.yml for an OS without running it.")
    .option("--run-id <id>", "Optional run id used in names/paths")
    .requiredOption("--os <id>", "Operating system id")
    .action(async (opts) => {
      const o = buildOptions(opts);
      const runId = opts.runId || makeRunId();

      // Resolve host ports, shifting to the next free port when one is occupied.
      const requestedPorts = {
        web: o.ports.web || 8006,
        vnc: o.ports.vnc || 5900,
      };
      if (o.os.type === "windows" && o.ports.rdp) requestedPorts.rdp = o.ports.rdp;
      if (o.os.type !== "windows" && o.ports.ssh) requestedPorts.ssh = o.ports.ssh;
      const resolvedPorts = await resolvePorts(requestedPorts, { host: o.ports.host });
      o.ports = resolvedPorts;
      const shifts = describeShifts(requestedPorts, resolvedPorts);
      if (shifts.length) console.log(`Ports shifted (occupied): ${shifts.join(", ")}`);
      console.log(`Ports: ${formatPortMap(resolvedPorts)}`);

      const runDirs = prepareRunDir({ osId: o.os.id, runId, root: projectRoot() });
      const mountPaths = {
        storage: runDirs.storageDir,
        test: o.testDir,
        package: o.packageDir,
        oem: o.oemDir,
      };
      const yaml = buildCompose({ ...o, runId, paths: mountPaths });
      const file = writeFileSync(runDirs.composeFile, yaml);
      console.log(`Generated: ${file}`);
      if (opts.debug) {
        console.log("\n----- docker-compose.yml -----");
        process.stdout.write(yaml);
      }
    }),
);

addCommonOptions(
  program
    .command("run")
    .description("Full pipeline: generate, up, wait, test, capture, cleanup.")
    .option("--run-id <id>", "Optional run id used in names/paths")
    .requiredOption("--os <id>", "Operating system id")
    .option("--screenshot-every <sec>", "Screenshot interval in seconds", (v) => Number(v) * 1000, 30 * 1000)
    .option("--no-video", "Disable full-session screen recording")
    .option("--test-timeout <min>", "Max minutes to wait for a test result marker", (v) => Number(v) * 60 * 1000, 20 * 60 * 1000)
    .option("--wait-timeout <min>", "Max minutes to wait for install readiness", (v) => Number(v) * 60 * 1000, 30 * 60 * 1000)
    .option("--boot-settle <sec>", "Fallback settle time after the viewer is up", (v) => Number(v) * 1000, 0)
    .option("--keep", "Keep the container, compose file and storage after the run")
    .action(async (opts) => {
      const o = buildOptions(opts);
      const runId = opts.runId || makeRunId();
      const result = await run({
        ...o,
        runId,
        testTimeoutMs: opts.testTimeout,
        camera: { screenshotEveryMs: opts.screenshotEvery, record: opts.video !== false },
        wait: { timeoutMs: opts.waitTimeout, bootSettleMs: opts.bootSettle },
        keep: opts.keep,
        log: logger,
      });

      console.log(`\nrunId:      ${result.runId}`);
      console.log(`success:    ${result.success}`);
      console.log(`reason:     ${result.reason}`);
      console.log(`artifacts:  ${result.paths.artifactsDir}`);
      if (result.capture && result.capture.video) console.log(`video:      ${result.capture.video}`);
      process.exit(result.success ? 0 : 1);
    }),
);

function addBrowserOptions(cmd) {
  return cmd
    .option("--build-dir <dir>", "Build context dir (default <repo>/browser)")
    .option("--browser-image <tag>", "Use a prebuilt image instead of building")
    .option("--selenium-port <port>", "Host port for Selenium WebDriver (default 4444)", (v) => Number(v), 4444)
    .option("--vnc-port <port>", "Host port for VNC (default 5900)", (v) => Number(v), 5900)
    .option("--no-vnc-port <port>", "Host port for noVNC (default 7900)", (v) => Number(v), 7900)
    .option("--shm-size <size>", "Shared memory size for the container (default 2gb)")
    .option("--vnc-password <pass>", "VNC password (default secret)")
    .option("--keep", "Keep the container, compose file and state after stopping");
}

function printBrowserInfo(state) {
  console.log(`\nbrowser: ${state.containerName}`);
  console.log(`selenium: http://127.0.0.1:${state.seleniumPort}/wd/hub`);
  console.log(`noVNC:    http://127.0.0.1:${state.noVncPort}`);
  console.log(`vnc:      127.0.0.1:${state.vncPort}  (password: ${state.vncPassword || "secret"})`);
  if (state.runDir) console.log(`runDir:   ${state.runDir}`);
}

const browserCmd = program
  .command("browser")
  .description("Start / stop a disposable Selenium Chrome browser container.");

addBrowserOptions(
  browserCmd
    .command("up")
    .description("Start a browser container and stay running.")
    .option("--run-id <id>", "Optional run id used in names/paths")
    .action(async (opts) => {
      const state = await startBrowser({
        runId: opts.runId,
        ports: { selenium: opts.seleniumPort, vnc: opts.vncPort, noVnc: opts.noVncPort },
        extra: {
          buildDir: opts.buildDir,
          browserImage: opts.browserImage,
          vncPassword: opts.vncPassword,
          shmSize: opts.shmSize,
        },
        wait: {},
        log: logger,
      });
      printBrowserInfo(state);
    }),
);

addBrowserOptions(
  browserCmd
    .command("status")
    .description("Show whether a browser container is running.")
    .action(async () => {
      const res = await browserStatus();
      if (res.running) {
        printBrowserInfo(res.state);
      } else {
        console.log("No browser container is currently running. Use `ebk browser up` to start one.");
      }
    }),
);

addBrowserOptions(
  browserCmd
    .command("down")
    .description("Stop and remove the browser container.")
    .action(async (opts) => {
      const res = await stopBrowser({ keep: opts.keep });
      if (res.stopped) console.log("Browser container stopped and removed.");
      else console.log("No browser container is running (state file missing).");
    }),
);

addBrowserOptions(
  browserCmd
    .command("run")
    .description("Full pipeline: up, wait for WebDriver/noVNC, capture, cleanup.")
    .option("--run-id <id>", "Optional run id used in names/paths")
    .option("--test-dir <dir>", "Host dir that receives a RESULT_<runId>.* marker")
    .option("--screenshot-every <sec>", "Screenshot interval in seconds", (v) => Number(v) * 1000, 30 * 1000)
    .option("--no-video", "Disable full-session screen recording")
    .option("--duration <sec>", "Capture duration in seconds when no --test-dir (default 60)", (v) => Number(v) * 1000, 60 * 1000)
    .option("--test-timeout <min>", "Max minutes to wait for a result marker (default 20)", (v) => Number(v) * 60 * 1000, 20 * 60 * 1000)
    .action(async (opts) => {
      const result = await browserRun({
        runId: opts.runId,
        ports: { selenium: opts.seleniumPort, vnc: opts.vncPort, noVnc: opts.noVncPort },
        extra: {
          buildDir: opts.buildDir,
          browserImage: opts.browserImage,
          vncPassword: opts.vncPassword,
          shmSize: opts.shmSize,
        },
        camera: { screenshotEveryMs: opts.screenshotEvery, record: opts.video !== false, durationMs: opts.duration },
        testDir: opts.testDir,
        testTimeoutMs: opts.testTimeout,
        keep: opts.keep,
        log: logger,
      });

      console.log(`\nrunId:      ${result.runId}`);
      console.log(`success:    ${result.success}`);
      console.log(`reason:     ${result.reason}`);
      console.log(`artifacts:  ${result.capture?.screenshots || ""}`);
      if (result.capture?.video) console.log(`video:      ${result.capture.video}`);
      process.exit(result.success ? 0 : 1);
    }),
);

function requireOs(id) {
  if (!id) {
    console.error('Error: --os <id> is required. Run `ebk list` to see options.');
    process.exit(1);
  }
  const os = findOs(id);
  if (!os) {
    console.error(`Error: unknown OS "${id}". Run \`ebk list\` to see supported IDs.`);
    process.exit(1);
  }
  return os;
}

function fsExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

program.parseAsync(process.argv).catch((e) => {
  logger.error(e.stack || e.message);
  process.exit(1);
});
