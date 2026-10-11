// The published package: what `npm pack` would put in the tarball. Runs npm itself
// (without lifecycle scripts, so no rebuild) and reads its file list.
//
// Without lifecycle scripts `prepack` doesn't run, so the dry run lists the app's own files
// only: the bundled client and commander, and the documents prepack copies in from the
// repository root, are not there yet. Running prepack here instead would put real copies
// into apps/cli/node_modules while other test files run, and they would resolve the client
// to the copy (the shadowing tools/pack/postpack.mjs exists to undo). So the documents are
// checked against prepack's rule, and CI packs and installs the real tarball.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The published package's folder (apps/cli), seen from the compiled test. */
const app = fileURLToPath(new URL("../../", import.meta.url));
/** The repository root, where the documents live. */
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const pkg = JSON.parse(readFileSync(app + "package.json", "utf8")) as {
  bin: Record<string, string>;
  main: string;
  files: string[];
  dependencies: Record<string, string>;
  bundleDependencies: string[];
};

// Runs npm as a process, the one slow kind of test here, so it gets 30 s instead of the 5 s
// default the `test` script sets.
test("the npm package contains the library, the bin and version.ts — and nothing else", { timeout: 30_000 }, () => {
  const json = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: app,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [pack] = JSON.parse(json) as [{ files: { path: string }[] }];
  const files = pack.files.map((f) => f.path);
  for (const required of ["package.json", pkg.main, pkg.bin["autobahn"]!, "dist/src/index.d.ts", "dist/src/cli/version.js"]) {
    assert.ok(files.includes(required), `missing from the package: ${required}`);
  }
  for (const path of files) {
    assert.doesNotMatch(path, /\.map$|^dist\/test\/|^src\/|^test\/|^skills\/|^site\/|\.tsbuildinfo$/, `should not be packaged: ${path}`);
  }
});

test("prepack copies README, LICENSE and the licence documents in, and bundles every dependency", () => {
  // prepack copies LICENSE, README.md and every plain file name in `files` from the
  // repository root; each has to exist there.
  for (const name of ["README.md", "LICENSE", "LICENSING.md", "DATA_LICENSE.md"]) {
    assert.ok(existsSync(repo + name), `missing at the repository root: ${name}`);
    assert.ok(["README.md", "LICENSE"].includes(name) || pkg.files.includes(name), `not in files: ${name}`);
  }
  // Every runtime dependency ships inside the tarball (a self-contained global install).
  assert.deepEqual([...pkg.bundleDependencies].sort(), Object.keys(pkg.dependencies).sort());
});
