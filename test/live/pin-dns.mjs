// A DNS pin for the suite's own processes — loaded with `node --import`, never by a drill.
//
// `LIVE_PIN=host=ip[,host=ip]` makes every `fetch` in this process connect to `ip` for
// `host` while still sending `host` as the SNI and Host header. It exists for one reason:
// a network that drops one of the edge ranges a hostname resolves to (an ISP's blanket
// block on a CDN range, measured on 6 Sep 2026: the workspace's two published addresses
// timed out while another edge served the same hostname fine). Nothing under test changes —
// the workspace still sees the hostname it always sees — only where the packets go.
import dns from "node:dns";

const pins = Object.fromEntries((process.env.LIVE_PIN || "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => p.split("=")));
if (Object.keys(pins).length) {
  const origLookup = dns.lookup;
  const family = (ip) => (ip.includes(":") ? 6 : 4);
  dns.lookup = function pinnedLookup(hostname, options, cb) {
    if (typeof options === "function") { cb = options; options = {}; }
    const ip = pins[hostname];
    if (!ip) return origLookup.call(dns, hostname, options, cb);
    if (options && options.all) return process.nextTick(cb, null, [{ address: ip, family: family(ip) }]);
    return process.nextTick(cb, null, ip, family(ip));
  };
  const origPromise = dns.promises.lookup.bind(dns.promises);
  dns.promises.lookup = async (hostname, options) => {
    const ip = pins[hostname];
    if (!ip) return origPromise(hostname, options);
    return options && options.all ? [{ address: ip, family: family(ip) }] : { address: ip, family: family(ip) };
  };
}
