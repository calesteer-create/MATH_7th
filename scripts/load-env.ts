import fs from "node:fs";
import path from "node:path";

/** Loads `.env` for standalone scripts. Next.js does this itself at runtime. */
export function loadEnv(): void {
  const file = path.join(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    // Older runtimes: fall back to a minimal parser.
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
}
