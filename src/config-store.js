import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export class ConfigStore {
  constructor(path) {
    this.path = path;
  }

  async read() {
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }

    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error(`Configuration file ${this.path} must contain a JSON object`);
    }

    const values = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new Error(`Configuration value ${key} must be a string`);
      }
      values[key] = value;
    }
    return values;
  }

  async write(values) {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(directory, `.${basename(this.path)}.${process.pid}.tmp`);
    const payload = `${JSON.stringify(values, null, 2)}\n`;
    await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600);
  }
}
