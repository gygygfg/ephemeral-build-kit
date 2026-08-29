const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = "info", stream = process.stdout } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(name, args) {
    if (LEVELS[name] < threshold) return;
    const ts = new Date().toISOString();
    stream.write(`[${ts}] [${name.toUpperCase()}] ${args.join(" ")}\n`);
  }

  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}

export const logger = createLogger();
