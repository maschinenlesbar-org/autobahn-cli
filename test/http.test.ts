import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeHttpTransport } from "../src/client/http.js";
import { AutobahnNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/o/autobahn/` });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(resp.body.toString("utf8")), { path: "/o/autobahn/" });
    },
  );
});

test("rejects an unsupported protocol with AutobahnNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    AutobahnNetworkError,
  );
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        AutobahnNetworkError,
      );
    },
  );
});

test("a timeoutMs beyond Node's timer range is capped, not fired after 1 ms", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => void warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    await withServer(
      (_req, res) => void setTimeout(() => res.end("{}"), 50),
      async (baseUrl) => {
        const resp = await nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 3_000_000_000 });
        assert.equal(resp.body.toString("utf8"), "{}");
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), []);
  } finally {
    process.off("warning", onWarning);
  }
});

test("an overall deadline bounds a slow-drip response (AUT-02)", async () => {
  // A server that keeps the connection open and drips one byte at a time slower
  // than any single idle-timeout window would reset the socket-inactivity timer
  // forever. The wall-clock deadline must still abort the exchange.
  const timers: NodeJS.Timeout[] = [];
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Drip a byte periodically; never call res.end(). Interval > 0 so each write
      // resets the idle timer, but the total duration exceeds the deadline.
      const iv = setInterval(() => res.write("x"), 20);
      timers.push(iv);
      res.on("close", () => clearInterval(iv));
    },
    async (baseUrl) => {
      const start = Date.now();
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 100 }),
        (err: unknown) =>
          err instanceof AutobahnNetworkError && /deadline|timed out/.test(err.message),
      );
      // It aborted promptly (well under a second), not hung indefinitely.
      assert.ok(Date.now() - start < 2000);
    },
  );
  for (const iv of timers) clearInterval(iv);
});
