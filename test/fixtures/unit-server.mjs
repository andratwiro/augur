// test/fixtures/unit-server.mjs — the real worker, over a socket, on the drafts env.
import http from "node:http";
import worker, { __testables as W } from "../../src/_worker.js";
import { makeEnv, ctxFor } from "./unit-env.mjs";

export async function startUnitServer({ live, tenantId }) {
  const env = await makeEnv({ live });
  const ctx = ctxFor(tenantId);
  W.__setTenantTestState({ memo: { at: Date.now(), tenantId } });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "https://x.test");
    const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    let out;
    if (url.pathname.startsWith("/__unit/")) out = await W.unitApi(ctx, request, url, env);
    else if (url.pathname.startsWith("/__publish/")) out = await W.publishApi(ctx, request, url, env);
    else out = await W.assetFetch(tenantId, env, request);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { env, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
