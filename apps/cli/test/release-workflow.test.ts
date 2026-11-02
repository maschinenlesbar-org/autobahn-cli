// The release workflow runs no code it hasn't locked, and no such code shares a job with the
// tarball or the write token (security audit 2026-10-27, class H). `npx --yes
// @cyclonedx/cyclonedx-npm@x` pinned the tool but resolved its dependencies when the job ran, in
// the contents: write job whose workspace `npm pack` then packed. Now the tool is locked in
// tools/sbom/ and runs in a job of its own; the release job checks the tarball's digest and runs
// only `gh`. Reads the workflow as text, no YAML parser. The shared conformance test P31 covers
// the same rules and more; this one is the repo's own check until P31 is rolled out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The compiled test runs from apps/cli/dist/test/: the repository root is four directories up.
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const workflow = readFileSync(`${repoRoot}.github/workflows/release.yml`, "utf8");

/** The jobs of the workflow by name, each as its text (two-space indented names under `jobs:`). */
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.search(/^jobs:\s*$/m));
  const found = new Map<string, string>();
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  heads.forEach((head, i) => found.set(head[1] ?? "", body.slice(head.index, heads[i + 1]?.index ?? body.length)));
  return found;
}

/** The text without its comments, so a comment that names a command doesn't count as running it. */
const code = (text: string): string => text.replace(/(^|\s)#.*$/gm, "$1");

test("the SBOM tool is locked in tools/sbom and installed without scripts, never run through npx", () => {
  assert.doesNotMatch(code(workflow), /\bnpx\b/);
  const pkg = JSON.parse(readFileSync(`${repoRoot}tools/sbom/package.json`, "utf8")) as { private?: boolean; devDependencies?: Record<string, string> };
  assert.equal(pkg.private, true);
  const version = pkg.devDependencies?.["@cyclonedx/cyclonedx-npm"] ?? "";
  assert.match(version, /^\d+\.\d+\.\d+$/, "an exact version");
  const lock = JSON.parse(readFileSync(`${repoRoot}tools/sbom/package-lock.json`, "utf8")) as {
    lockfileVersion: number;
    packages: Record<string, { version?: string; integrity?: string; link?: boolean }>;
  };
  assert.ok(lock.lockfileVersion >= 2);
  assert.equal(lock.packages["node_modules/@cyclonedx/cyclonedx-npm"]?.version, version);
  const unhashed = Object.entries(lock.packages).filter(([path, entry]) => path !== "" && entry.link !== true && !entry.integrity);
  assert.deepEqual(unhashed.map(([path]) => path), [], "every locked package has an integrity hash");
});

test("pack, SBOM and release are separate jobs; only the release job writes, and it runs only gh on a checked tarball", () => {
  const all = jobs(workflow);
  const writers = [...all].filter(([, job]) => /contents:\s*write/.test(code(job)));
  assert.equal(writers.length, 1, `jobs with contents: write: ${writers.map(([name]) => name).join(", ")}`);
  const [, release = ""] = writers[0] ?? [];
  assert.match(code(release), /gh release create/);
  assert.match(code(release), /sha256sum/, "the release job checks the tarball's digest");
  assert.doesNotMatch(code(release), /\bnpm\b|\bnode\b|actions\/checkout|cyclonedx/, "the release job runs only gh");
  const sbom = [...all.values()].filter((job) => /cyclonedx-npm/.test(code(job)));
  assert.equal(sbom.length, 1, "one job runs the SBOM tool");
  assert.match(code(sbom[0] ?? ""), /npm ci --ignore-scripts --prefix tools\/sbom/);
  assert.match(code(sbom[0] ?? ""), /tools\/sbom\/node_modules\/\.bin\/cyclonedx-npm/);
  assert.doesNotMatch(code(sbom[0] ?? ""), /npm pack/);
  const pack = [...all.values()].filter((job) => /npm pack/.test(code(job)));
  assert.equal(pack.length, 1, "one job packs");
  assert.match(code(pack[0] ?? ""), /sha256sum/, "the pack job records the tarball's digest");
});
