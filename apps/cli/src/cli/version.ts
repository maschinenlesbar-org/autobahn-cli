// The CLI's version, for --version, the library entry's VERSION and the User-Agent the CLI
// sends. It lives in the app (apps/cli/package.json), not in the client: the client is a
// workspace package shared by the apps, with no release version of its own.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (apps/cli/dist/src/cli/version.js) the app's package.json
 * is three directories up; the same offset holds for the source under src/cli.
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

/**
 * The User-Agent the CLI sends unless --user-agent gives one: name, version and where to
 * find the project, so the API's operator can tell which client and release is calling.
 * (A library user who sets no `userAgent` sends the client's DEFAULT_USER_AGENT, which
 * names the project without a version.)
 */
export const USER_AGENT = `autobahn-cli/${VERSION} (+https://github.com/maschinenlesbar-org/autobahn-cli)`;
