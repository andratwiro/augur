// test/fixtures/unit-server.mjs — the real worker, over a socket, on the drafts env.
// Content goes through assetFetch and then the draft bar's injection, with whatever the
// cookie says about who is asking — the same two steps the request handler takes for a
// unit page, minus the chrome recomposition (RUNTIME_CHROME is off here) and the
// live-reload poll (HTMLRewriter does not exist in Node).
import http from "node:http";
import { __testables as W } from "../../src/_worker.js";
import { makeEnv, ctxFor } from "./unit-env.mjs";

export async function startUnitServer({ live, tenantId, users }) {
  const env = await makeEnv({ live });
  // `loadConfig` derives the unit list from the live manifests on a real deployment; the
  // fixture hands it over directly, because the bar's "is this a unit page" reads it.
  const ctx = { ...(users ? ctxFor(tenantId, users) : ctxFor(tenantId)), PUBLIC_PREFIXES: ((live || {}).routing || {}).publicPrefixes || [] };
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
    else {
      const asset = await W.assetFetch(tenantId, env, request);
      const me = req.headers.cookie && ctx.USERS.length
        ? await W.identify(request, env, ctx.USERS, { sessionKeys: ctx.SESSION_KEYS, tctx: ctx })
        : null;
      out = await W.withDraftUi(ctx, asset, url, me, env);
    }
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { env, ctx, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
