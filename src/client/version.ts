// The package version, for the CLI's --version and the client's default User-Agent.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/client/version.js) package.json is three
 * directories up; the same offset holds for the source under src/client.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** This package's version, e.g. "0.2.0" ("0.0.0" when package.json cannot be read). */
export const VERSION = readVersion();
