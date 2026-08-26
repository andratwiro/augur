// A bundle store, in a separate process, serving a real build.
//
// Only the two read verbs a graduation needs: the manifest, and a blob by hash. It is a
// separate PROCESS rather than a server inside the test on purpose — the thing under test
// is the CLI, and a CLI that talks to the store over a socket it did not open is the only
// arrangement in which "it fetched, verified the hash, and peeled" means anything.
//
//   node test/fixtures/fake-store.mjs <dist-dir> <space-id>
//
// Prints `ready <port>` on stdout once listening; serves until killed.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const [dist, spaceId] = process.argv.slice(2);
if (!dist || !spaceId) { console.error("usage: fake-store.mjs <dist-dir> <space-id>"); process.exit(1); }

const manifest = JSON.parse(fs.readFileSync(path.join(dist, "__manifests", `${spaceId}.json`), "utf8"));
const byHash = new Map();
for (const [url, meta] of Object.entries(manifest.files || {})) {
  byHash.set(meta.h, path.join(dist, url.replace(/^\//, "")));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === `/__publish/${spaceId}/manifest`) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(manifest));
  }
  const m = new RegExp(`^/__publish/${spaceId}/blob/([0-9a-f]+)$`).exec(url.pathname);
  if (m && byHash.has(m[1])) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(fs.readFileSync(byHash.get(m[1])));
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not in this store");
});
server.listen(0, "127.0.0.1", () => console.log(`ready ${server.address().port}`));
