// probe-address.mjs — what does a draft address serve, in which spellings, how fast?
import { UNITS, ORIGIN } from "./env.mjs";
import { human } from "./persona.mjs";
import { open, writeFile, readFile, stamp, save, close, draftIdOf } from "./drills/lib.mjs";

const U = UNITS()[Number(process.argv[2] || 0)];
const d = await open("editor", "probe", U);
try {
  const s = stamp(d, "probe");
  writeFile(d, "index.html", readFile(d, "index.html") + "\n" + s);
  const t0 = Date.now();
  console.log("save:", JSON.stringify(await save(d)));
  console.log("server address:", d.r.address, "draftId:", draftIdOf(d));
  const owner = await human("owner");
  const forms = [
    d.r.address.replace(ORIGIN(), ""),
    d.r.address.replace(ORIGIN(), "") + "index.html",
    `${U}@${draftIdOf(d)}/`,
    `${U}@${draftIdOf(d)}/index.html`,
    `${U}index.html`,
    U,
  ];
  for (let round = 0; round < 3; round++) {
    for (const f of forms) {
      const r = await owner.get(f);
      const text = await r.text();
      console.log(`[${Date.now() - t0}ms] ${r.status} ${f} stamp=${text.includes(s)} len=${text.length} ct=${r.headers.get("content-type")} cache=${r.headers.get("cf-cache-status") || r.headers.get("x-cache") || "-"} ${r.headers.get("location") || ""}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
} finally { await close(d, true).catch(() => {}); }
