// Compile-time checks of the exported library types; the runtime assertions are trivial.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AutobahnClient, type ServiceResource } from "../src/index.js";
import { constantJson } from "./helpers.js";

test("ServiceResource names the type of any service resource", async () => {
  const count = async (resource: ServiceResource<string>, road: string): Promise<number> =>
    (await resource.list(road)).length;
  const client = new AutobahnClient({ transport: constantJson({ roadworks: [{ identifier: "a" }] }).transport });
  assert.equal(await count(client.roadworks, "A1"), 1);
});

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "autobahn-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { AutobahnClient, RequestEngine, type EngineOptions, type QueryParams } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const client = new AutobahnClient({ baseUrl: process.env.AUTOBAHN_BASE_URL, timeoutMs: 15_000 });",
        "export const raw = (e: RequestEngine, query: QueryParams | undefined, empty: boolean | undefined) =>",
        "  [e.request(\"GET\", \"/x\", { query, accept: \"application/json\" }), e.getJson(\"/x\", query, { emptyIsNotFound: empty })];",
        "export const ids = async (): Promise<string[]> => (await client.roadworks.list(\"A1\")).map((item) => item.identifier ?? \"\");",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = constantJson({ roads: ["A1"] });
  const client = new AutobahnClient({
    baseUrl: undefined,
    userAgent: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  assert.deepEqual(await client.roads(), ["A1"]);
  assert.equal(mt.last().url, "https://verkehr.autobahn.de/o/autobahn/");
  assert.match(mt.last().headers?.["User-Agent"] ?? "", /^autobahn-cli \(/);
  assert.equal(mt.last().timeoutMs, 30_000);
});
