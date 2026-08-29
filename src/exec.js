import { spawn } from "node:child_process";

/**
 * Simple promise-based command runner (execa-like) using Node's child_process.
 * Resolves { stdout, stderr, exitCode }, never rejects on non-zero exit.
 */
export function execa(cmd, args = [], { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
    child.on("error", (err) =>
      resolve({ stdout, stderr: stderr + err.message, exitCode: 1 }),
    );
  });
}
