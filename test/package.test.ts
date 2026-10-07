// The published package: what `npm pack` would put in the tarball. Runs npm itself
// (without lifecycle scripts, so no rebuild) and reads its file list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Runs npm as a process, the one slow kind of test here, so it gets 30 s instead of the 5 s
// default the `test` script sets.
test("the npm package contains the library, the bin, version.ts and the licence documents — and nothing else", { timeout: 30_000 }, () => {
  const json = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [pack] = JSON.parse(json) as [{ files: { path: string }[] }];
  const files = pack.files.map((f) => f.path);
  const pkg = JSON.parse(readFileSync(new URL("package.json", `file://${root}`), "utf8")) as {
    bin: Record<string, string>;
    main: string;
  };
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "LICENSING.md",
    "DATA_LICENSE.md",
    pkg.main,
    pkg.bin["autobahn"]!,
    "dist/src/index.d.ts",
    "dist/src/client/version.js",
  ]) {
    assert.ok(files.includes(required), `missing from the package: ${required}`);
  }
  for (const path of files) {
    assert.doesNotMatch(path, /\.map$|^dist\/test\/|^src\/|^test\/|^skills\/|^site\//, `should not be packaged: ${path}`);
  }
});
