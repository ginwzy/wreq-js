import assert from "node:assert";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { createSession, createTransport, RequestError, fetch as wreqFetch } from "../../wreq-js.js";
import { httpUrl } from "../helpers/http.js";

type ProxyObservation = {
  url: string;
  headers: IncomingHttpHeaders;
};

async function startRecordingProxy(options?: { stripProxyHeaders?: boolean }): Promise<{
  proxyUrl: string;
  observations: ProxyObservation[];
  close: () => Promise<void>;
}> {
  const observations: ProxyObservation[] = [];
  const stripProxyHeaders = options?.stripProxyHeaders ?? false;

  const proxyServer = createServer((req, res) => {
    observations.push({
      url: req.url ?? "",
      headers: { ...req.headers },
    });

    let target: URL;
    try {
      if (req.url && /^https?:\/\//i.test(req.url)) {
        target = new URL(req.url);
      } else {
        const host = req.headers.host;
        if (!host) {
          res.statusCode = 400;
          res.end("Missing Host header");
          return;
        }
        target = new URL(req.url ?? "/", `http://${host}`);
      }
    } catch (error) {
      res.statusCode = 400;
      res.end(String(error));
      return;
    }

    const forwardHeaders = { ...req.headers };
    if (stripProxyHeaders) {
      for (const key of Object.keys(forwardHeaders)) {
        const lower = key.toLowerCase();
        if (lower === "proxy-authorization" || lower.startsWith("x-proxy-")) {
          delete forwardHeaders[key];
        }
      }
    }

    const upstream = httpRequest(target, { method: req.method, headers: forwardHeaders }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on("error", (error) => {
      if (!res.headersSent) res.statusCode = 502;
      res.end(String(error));
    });
    req.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    proxyServer.once("error", reject);
    proxyServer.listen(0, "127.0.0.1", () => {
      proxyServer.off("error", reject);
      resolve();
    });
  });

  const address = proxyServer.address() as AddressInfo | null;
  if (!address) {
    await new Promise<void>((resolve, reject) => proxyServer.close((error) => (error ? reject(error) : resolve())));
    throw new Error("Failed to determine proxy server address");
  }

  return {
    proxyUrl: `http://127.0.0.1:${address.port}`,
    observations,
    close: () =>
      new Promise<void>((resolve, reject) => proxyServer.close((error) => (error ? reject(error) : resolve()))),
  };
}

function findProxyRequest(observations: ProxyObservation[], pathFragment: string): ProxyObservation {
  const match = observations.find((obs) => obs.url.includes(pathFragment));
  assert.ok(match, `Proxy should have seen a request containing "${pathFragment}"`);
  return match;
}

describe("proxyHeaders option", () => {
  test("forwards a single proxyHeader on a standalone fetch", async () => {
    const proxy = await startRecordingProxy();

    try {
      const res = await wreqFetch(httpUrl("/get"), {
        browser: "chrome_142",
        proxy: proxy.proxyUrl,
        proxyHeaders: { "X-Proxy-Token": "alpha" },
        timeout: 10_000,
      });
      assert.strictEqual(res.status, 200);

      const observed = findProxyRequest(proxy.observations, "/get");
      assert.strictEqual(observed.headers["x-proxy-token"], "alpha");
    } finally {
      await proxy.close();
    }
  });

  test("forwards multiple proxyHeaders in one request", async () => {
    const proxy = await startRecordingProxy();

    try {
      const res = await wreqFetch(httpUrl("/get"), {
        browser: "chrome_142",
        proxy: proxy.proxyUrl,
        proxyHeaders: {
          "X-Proxy-Token": "multi",
          "X-Proxy-Region": "us-west-1",
          "Proxy-Authorization": "Basic dXNlcjpwYXNz",
        },
        timeout: 10_000,
      });
      assert.strictEqual(res.status, 200);

      const observed = findProxyRequest(proxy.observations, "/get");
      assert.strictEqual(observed.headers["x-proxy-token"], "multi");
      assert.strictEqual(observed.headers["x-proxy-region"], "us-west-1");
      assert.strictEqual(observed.headers["proxy-authorization"], "Basic dXNlcjpwYXNz");
    } finally {
      await proxy.close();
    }
  });

  test("omits proxyHeader when the option is not set", async () => {
    const proxy = await startRecordingProxy();

    try {
      const res = await wreqFetch(httpUrl("/get"), {
        browser: "chrome_142",
        proxy: proxy.proxyUrl,
        timeout: 10_000,
      });
      assert.strictEqual(res.status, 200);

      const observed = findProxyRequest(proxy.observations, "/get");
      assert.strictEqual(observed.headers["x-proxy-token"], undefined);
      assert.strictEqual(observed.headers["proxy-authorization"], undefined);
    } finally {
      await proxy.close();
    }
  });

  test("treats an empty proxyHeaders object as no-op", async () => {
    const proxy = await startRecordingProxy();

    try {
      const res = await wreqFetch(httpUrl("/get"), {
        browser: "chrome_142",
        proxy: proxy.proxyUrl,
        proxyHeaders: {},
        timeout: 10_000,
      });
      assert.strictEqual(res.status, 200);

      const observed = findProxyRequest(proxy.observations, "/get");
      assert.strictEqual(observed.headers["x-proxy-token"], undefined);
    } finally {
      await proxy.close();
    }
  });

  test("does not leak proxyHeaders to origin when proxy strips them", async () => {
    const proxy = await startRecordingProxy({ stripProxyHeaders: true });

    try {
      const res = await wreqFetch(httpUrl("/headers"), {
        browser: "chrome_142",
        proxy: proxy.proxyUrl,
        proxyHeaders: { "X-Proxy-Token": "secret-token" },
        timeout: 10_000,
      });
      assert.strictEqual(res.status, 200);

      const proxyObservation = findProxyRequest(proxy.observations, "/headers");
      assert.strictEqual(proxyObservation.headers["x-proxy-token"], "secret-token");

      const body = (await res.json()) as { headers: Record<string, string> };
      const originHeaderNames = Object.keys(body.headers).map((name) => name.toLowerCase());
      assert.ok(
        !originHeaderNames.includes("x-proxy-token"),
        `Origin should not receive proxyHeaders, got: ${originHeaderNames.join(", ")}`,
      );
    } finally {
      await proxy.close();
    }
  });

  test("accepts Headers and array forms as proxyHeaders input", async () => {
    const proxy = await startRecordingProxy();

    try {
      const res = await wreqFetch(httpUrl("/get"), {
        browser: "chrome_142",
        proxy: proxy.proxyUrl,
        proxyHeaders: [
          ["X-Proxy-Token", "from-array"],
          ["X-Proxy-Region", "eu"],
        ],
        timeout: 10_000,
      });
      assert.strictEqual(res.status, 200);

      const observed = findProxyRequest(proxy.observations, "/get");
      assert.strictEqual(observed.headers["x-proxy-token"], "from-array");
      assert.strictEqual(observed.headers["x-proxy-region"], "eu");
    } finally {
      await proxy.close();
    }
  });

  test("applies proxyHeaders set on a shared transport", async () => {
    const proxy = await startRecordingProxy();

    const transport = await createTransport({
      browser: "chrome_142",
      proxy: proxy.proxyUrl,
      proxyHeaders: { "X-Proxy-Token": "transport-scope" },
    });

    try {
      const first = await wreqFetch(httpUrl("/get"), { transport, timeout: 10_000 });
      const second = await wreqFetch(httpUrl("/json"), { transport, timeout: 10_000 });
      assert.strictEqual(first.status, 200);
      assert.strictEqual(second.status, 200);

      const hits = proxy.observations.filter((obs) => obs.headers["x-proxy-token"] === "transport-scope");
      assert.ok(hits.length >= 2, `Both requests should carry transport proxyHeaders, got ${hits.length}`);
    } finally {
      await transport.close();
      await proxy.close();
    }
  });

  test("applies proxyHeaders set on a session", async () => {
    const proxy = await startRecordingProxy();

    const session = await createSession({
      browser: "chrome_142",
      proxy: proxy.proxyUrl,
      proxyHeaders: { "X-Proxy-Token": "session-scope" },
    });

    try {
      const res = await session.fetch(httpUrl("/get"), { timeout: 10_000 });
      assert.strictEqual(res.status, 200);

      const observed = findProxyRequest(proxy.observations, "/get");
      assert.strictEqual(observed.headers["x-proxy-token"], "session-scope");
    } finally {
      await session.close();
      await proxy.close();
    }
  });

  test("rejects proxyHeaders when combined with an explicit transport", async () => {
    const transport = await createTransport({ browser: "chrome_142" });

    try {
      await assert.rejects(
        wreqFetch(httpUrl("/get"), {
          transport,
          proxyHeaders: { "X-Proxy-Token": "nope" },
        }),
        (error: unknown) =>
          error instanceof RequestError &&
          /cannot be combined with browser\/os\/emulation\/proxy\/proxyHeaders\/insecure\/trustStore/.test(
            error.message,
          ),
      );
    } finally {
      await transport.close();
    }
  });

  test("rejects session.websocket() proxyHeaders overrides", async () => {
    const session = await createSession({
      browser: "chrome_142",
      proxy: "http://proxy.example.com:8080",
      proxyHeaders: { "X-Proxy-Token": "locked" },
    });

    try {
      await assert.rejects(
        // biome-ignore lint/suspicious/noExplicitAny: exercising the guard which is type-forbidden on SessionWebSocketOptions
        session.websocket("wss://example.com/ws", { proxyHeaders: { "X-Proxy-Token": "override" } } as any),
        (error: unknown) =>
          error instanceof RequestError && /proxyHeaders.*is not supported in session.websocket/.test(error.message),
      );
    } finally {
      await session.close();
    }
  });

  test("rejects an invalid proxyHeader name from Rust", async () => {
    await assert.rejects(
      wreqFetch(httpUrl("/get"), {
        browser: "chrome_142",
        proxy: "http://127.0.0.1:1",
        proxyHeaders: { "Invalid Header Name\n": "x" },
        timeout: 5_000,
      }),
      (error: unknown) => error instanceof Error,
    );
  });
});
