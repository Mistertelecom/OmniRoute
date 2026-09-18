/**
 * #14092 — the provider-models and vscode catalog routes re-serialize a filtered
 * catalog body but used to forward the catalog's own `content-length` onto it.
 * A client then saw the full catalog's byte length (~833 KB) on a much smaller
 * body and the response never completed (the dashboard model picker stayed on
 * "loading" forever).
 *
 * These tests drive the real route handlers (temp DATA_DIR, loopback request,
 * no credentials — the same bootstrap shape the other route tests use) and
 * assert no stale length header survives re-serialization.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cat-len-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { GET } = await import("../../src/app/api/v1/providers/[provider]/models/route.ts");
const { getVscodeModelsCatalogResponse } = await import(
  "../../src/app/api/v1/vscode/[token]/models/route.ts"
);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function assertNoStaleLength(response: Response, body: string, label: string) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    assert.equal(
      Number(declared),
      Buffer.byteLength(body),
      `${label}: content-length must describe the re-serialized body`
    );
  }
  assert.equal(
    response.headers.get("transfer-encoding"),
    null,
    `${label}: transfer-encoding must not be forwarded onto a buffered body`
  );
}

test("provider models route re-serializes without the catalog's stale content-length", async () => {
  const request = new Request("http://127.0.0.1:20128/api/v1/providers/opencode/models");
  const response = await GET(request, { params: Promise.resolve({ provider: "opencode" }) });

  assert.equal(response.status, 200);
  const text = await response.text();
  assertNoStaleLength(response, text, "providers route");
  const payload = JSON.parse(text) as { object?: string; data?: unknown };
  assert.ok(Array.isArray(payload.data), "route must return a model list");
});

test("vscode catalog helper drops stale length headers and keeps the cache headers", async () => {
  const request = new Request("http://127.0.0.1:20128/api/v1/vscode/tok/api/models");
  const catalog = await getVscodeModelsCatalogResponse(request);

  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers["content-length"], undefined);
  assert.equal(catalog.headers["transfer-encoding"], undefined);
  assert.equal(catalog.headers.Pragma, "no-cache", "cache headers must survive the strip");

  const response = Response.json(catalog.body, {
    status: catalog.status,
    headers: catalog.headers,
  });
  assertNoStaleLength(response, await response.text(), "vscode helper");
});
