import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { nodeHttpTransport } from "../src/http.js";
import { RequestEngine } from "../src/engine.js";
import { AutobahnNetworkError } from "../src/errors.js";

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

test("userinfo in the URL is sent as HTTP Basic auth to that host, as documented", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null }));
    },
    async (baseUrl) => {
      const withUser = baseUrl.replace("http://", "http://user:s3cret@");
      const resp = await nodeHttpTransport({ method: "GET", url: `${withUser}/o/autobahn/` });
      const expected = `Basic ${Buffer.from("user:s3cret").toString("base64")}`;
      assert.deepEqual(JSON.parse(resp.body.toString("utf8")), { authorization: expected });
      const plain = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/o/autobahn/` });
      assert.deepEqual(JSON.parse(plain.body.toString("utf8")), { authorization: null });
    },
  );
});

test("a reset connection is retried by the engine; a refused one is not", async () => {
  let requests = 0;
  await withServer(
    (req, res) => {
      requests += 1;
      if (requests === 1) {
        req.socket.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ roads: ["A1"] }));
    },
    async (baseUrl) => {
      const engine = new RequestEngine({ baseUrl, maxRetries: 2, sleep: async () => {} });
      assert.deepEqual(await engine.getJson("/o/autobahn/"), { roads: ["A1"] });
      assert.equal(requests, 2);
    },
  );
  let calls = 0;
  const refused = new RequestEngine({
    baseUrl: "http://127.0.0.1:1",
    maxRetries: 2,
    sleep: async () => {},
    transport: (req) => { calls += 1; return nodeHttpTransport(req); },
  });
  await assert.rejects(() => refused.getJson("/o/autobahn/"), AutobahnNetworkError);
  assert.equal(calls, 1);
});

test("a malformed HTTP response is named as such, with the parser's text", async () => {
  // Answer after the request arrives; answering at connect races the request write.
  const server = net.createServer((socket) => socket.once("data", () => socket.end("garbage\r\n\r\n")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  try {
    await assert.rejects(
      () => nodeHttpTransport({ method: "GET", url: `http://127.0.0.1:${addr.port}/` }),
      (err: unknown) =>
        err instanceof AutobahnNetworkError && /^the server sent a malformed HTTP response \(.+\)$/.test(err.message),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

test("a header value Node cannot send rejects with AutobahnNetworkError, not a raw TypeError", async () => {
  const CRLF = String.fromCharCode(0x0d, 0x0a);
  await assert.rejects(
    () =>
      nodeHttpTransport({
        method: "GET",
        url: "http://127.0.0.1:9/x",
        headers: { "User-Agent": `a${CRLF}X-Evil: 1` },
      }),
    (err: unknown) => err instanceof AutobahnNetworkError && /^Invalid request: /.test(err.message),
  );
});

/** Serve one raw HTTP answer from a TCP server for one test and return its base URL. */
async function withRawServer(answer: Buffer, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(answer));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a body in many tiny chunks arrives whole and in order, and the byte cap still holds", async () => {
  // 300 001 chunks of 1 to 3 bytes: whatever the transport joins on the way, every byte is kept
  // once, in order (the memory side is conformance test P27, the bin in a small heap).
  const pieces = Array.from({ length: 300_001 }, (_, i) => "abc".slice(0, (i % 3) + 1));
  const head = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";
  const wire = Buffer.from(head + pieces.map((p) => `${p.length}\r\n${p}\r\n`).join("") + "0\r\n\r\n", "latin1");
  const expected = pieces.join("");
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, expected.length);
    assert.ok(res.body.equals(Buffer.from(expected, "latin1")));
  });
  await withRawServer(wire, async (baseUrl) => {
    await assert.rejects(
      () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: expected.length - 1 }),
      (err: unknown) => err instanceof AutobahnNetworkError && /exceeded the size limit/.test(err.message),
    );
  });
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: expected.length });
    assert.equal(res.body.length, expected.length);
  });
});

test("a URL typed without its scheme is refused without its user name, token or password (F5 class)", async () => {
  // `my_user:pw@h` doesn't parse ("_" is no scheme character) and was quoted with its password;
  // `T0kenS3cret:@h` parses with the token as its scheme, which the message named, lower-cased.
  for (const url of ["my_user:s3cret-pw@h.example/x", "T0kenS3cret:@h.example/x", "alice:s3cret-pw@h.example/x"]) {
    const err = await nodeHttpTransport({ method: "GET", url, headers: {} }).then(
      () => assert.fail(`${url}: accepted`),
      (caught: unknown) => caught,
    );
    assert.ok(err instanceof AutobahnNetworkError, String(err));
    assert.ok(!/s3cret|t0kens3cret|T0kenS3cret|my_user|alice/.test(err.message), err.message);
    assert.match(err.message, /\*\*\*@h\.example\/x/);
  }
  // A scheme spelled as one (`scheme://`) is still named.
  const ftp = await nodeHttpTransport({ method: "GET", url: "ftp://alice:s3cret-pw@h.example/x", headers: {} }).catch((e: unknown) => e);
  assert.ok(ftp instanceof AutobahnNetworkError && ftp.message === 'Unsupported protocol "ftp:" in URL: ftp://***@h.example/x', String(ftp));
});
