import { existsSync, readFileSync } from "node:fs";

function unquote(value) {
  if (value.length < 2) return value;

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
    const inner = value.slice(1, -1);
    return quote === '"'
      ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
      : inner;
  }

  return value;
}

export function loadEnvFile(path = process.env.ENV_FILE ?? ".env") {
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) {
      throw new Error(`Invalid environment line in ${path}: ${rawLine}`);
    }

    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment key in ${path}: ${key}`);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}
