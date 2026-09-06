// Drill J — the real CLI, one process per verb, as a session that dies and comes back.
//   `augur open` in one process; an edit; `augur save` in a second process; `augur status`
//   in a third finds the draft; `augur land` in a fourth prints the live URL last.
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { UNITS, RUN } from "../env.mjs";
import { cli, draftDir } from "../persona.mjs";
import { assert, served, until, resetUnit } from "./lib.mjs";
import { readState } from "../../../scripts/lib/draft.mjs";

const U = UNITS()[7];
const bare = U.replace(/^\/|\/$/g, "");

test("J: open, die, save, status, land — four processes, one draft", async () => {
  const dir = draftDir("editor", "J");
  const o = await cli("editor", "j-session", ["open", bare, "--dir", dir]);
  assert.equal(o.code, 0, `open: ${o.err}`);
  assert.match(o.err, /draft \w+ on/, "open names the draft");
  const st = readState(dir);
  assert.ok(st && st.draftId, "the folder carries .augur/draft.json");
  const stampText = `<!-- ${RUN} J resumed -->`;
  fs.appendFileSync(path.join(dir, "index.html"), "\n" + stampText);
  // "The session died": a new process, same folder, same identity.
  const s = await cli("editor", "j-session-2", ["save"], { cwd: dir });
  assert.equal(s.code, 0, `save: ${s.err}`);
  await until(async () => (await served(`${new URL(st.address, "https://x").pathname}index.html`)).text.includes(stampText), { what: "draft address serving the resumed save" });
  // `status` exits 1 on drift between live and any sibling clone it can see, which in
  // this checkout is two unrelated spaces — so the exit code is not the assertion here.
  const status = await cli("editor", "j-session-3", ["status"]);
  assert.ok((status.out + status.err).includes(st.draftId), `status lists the draft ${st.draftId}: ${(status.out + status.err).slice(0, 400)}`);
  const l = await cli("editor", "j-session-4", ["land", "-m", `${RUN} J`], { cwd: dir });
  assert.equal(l.code, 0, `land: ${l.err}`);
  assert.match(l.last, /^https:\/\/\S+/, `the LAST line of stdout is the live URL: ${JSON.stringify(l.last)}`);
  assert.ok(l.last.includes(U), "and it is the prototype's real URL");
  await until(async () => (await served(`${U}index.html`)).text.includes(stampText), { what: "main serving the landing" });
  const c = await cli("editor", "j-session-5", ["close"], { cwd: dir });
  assert.equal(c.code, 0, `close: ${c.err}`);
  assert.ok(!fs.existsSync(dir), "close removed the folder");
  await resetUnit(U);
});
