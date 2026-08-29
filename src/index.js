#!/usr/bin/env node
import fs from "node:fs";
import { Command } from "commander";
import { logger } from "./logger.js";
import { findOs, listOs } from "./catalog.js";
import { buildCompose } from "./compose.js";
import { prepareRunDir, projectRoot, writeFileSync } from "./store.js";
import { run, makeRunId } from "./orchestrator.js";
import { execa } from "./exec.js";

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
    .option("--ssh-port <port>", "Host port for guest SSH (Linux only)", (v) => Number(v))
    .option("--rdp-port <port>", "Host port for guest RDP (Windows only)", (v) => Number(v));
}

function buildOptions(opts) {
  const os = requireOs(opts.os);
  return {
    os,
    resources: { ram: opts.ram, cpu: opts.cpu, disk: opts.disk },
    ports: { web: opts.webPort, rdp: opts.rdpPort, ssh: opts.sshPort },
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
    .action((opts) => {
      const o = buildOptions(opts);
      const runId = opts.runId || makeRunId();
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
