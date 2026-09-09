// test/draft-chips-logic.test.mjs — what a gallery card's draft chip says, decided by the
// pure module the chrome bundle inlines (src/draft-chips-logic.mjs). A chip names WHO has
// a draft here and whether they are at it now; it never shows a count alone and never the
// session label (the CLI's default is `session-<pid>`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chipsFor, ago, unitName } from "../src/draft-chips-logic.mjs";

const NOW = Date.parse("2026-09-09T12:00:00Z");
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

const ada = { owner: "p-ada", name: "Ada", initials: "AD", color: "#123456" };
const ana = { owner: "p-ana", name: "Ana", initials: "AN", color: "#654321" };
const draft = (id, who, { active = true, saved = 2, opened = 30, session = "session-48213" } = {}) => ({
  id, session, active, ...who,
  openedAt: minsAgo(opened),
  lastSaveAt: saved == null ? null : minsAgo(saved),
});

test("ago: just now, minutes, hours, days, and nothing for a bad date", () => {
  assert.equal(ago(minsAgo(0), NOW, "saved"), "saved just now");
  assert.equal(ago(minsAgo(4), NOW, "saved"), "saved 4 min ago");
  assert.equal(ago(minsAgo(3 * 60), NOW, "saved"), "saved 3 h ago");
  assert.equal(ago(minsAgo(3 * 24 * 60), NOW, "opened"), "opened 3 d ago");
  assert.equal(ago(null, NOW, "saved"), "");
  assert.equal(ago("nope", NOW, "saved"), "");
});

test("unitName: the last path segment, dashes as spaces", () => {
  assert.equal(unitName("/projects/home-page/"), "home page");
  assert.equal(unitName("/playground/widget/"), "widget");
  assert.equal(unitName(""), "");
});

test("a prototype card with one live draft: face with the dot, 'working', a link to the draft", () => {
  const units = { "/p/home/": [draft("abc123", ada)] };
  const chips = chipsFor(units, "/p/home/", NOW);
  assert.equal(chips.length, 1);
  const c = chips[0];
  assert.equal(c.href, "/p/home@abc123/");
  assert.equal(c.live, true);
  assert.equal(c.text, "working");
  assert.deepEqual(c.faces, [{ owner: "p-ada", name: "Ada", initials: "AD", color: "#123456", live: true }]);
  assert.equal(c.title, "Careful: Ada's agent is working on this right now · saved 2 min ago");
});

test("a prototype card with an idle draft that was never saved says when it was opened, and is not live", () => {
  const units = { "/p/home/": [draft("abc123", ada, { active: false, saved: null, opened: 180 })] };
  const [c] = chipsFor(units, "/p/home/", NOW);
  assert.equal(c.live, false);
  assert.equal(c.text, "opened 3 h ago");
  assert.equal(c.faces[0].live, false);
  assert.equal(c.title, "Careful: Ada's agent has a draft open on this · opened 3 h ago");
});

test("a prototype card with two drafts wears one chip per draft, each linking to its own", () => {
  const units = { "/p/home/": [draft("aaa111", ada), draft("bbb222", ana, { active: false, saved: 90 })] };
  const chips = chipsFor(units, "/p/home/", NOW);
  assert.deepEqual(chips.map((c) => c.href), ["/p/home@aaa111/", "/p/home@bbb222/"]);
  assert.deepEqual(chips.map((c) => c.text), ["working", "saved 1 h ago"]);
});

test("a folder card with one draft beneath links straight to that draft", () => {
  const units = { "/p/home/": [draft("abc123", ada)] };
  const [c] = chipsFor(units, "/p/", NOW);
  assert.equal(c.href, "/p/home@abc123/");
  assert.equal(c.text, "working");
  assert.equal(c.title, "Ada's agent is working on home right now · saved 2 min ago");
});

test("a folder card with one person on three prototypes: one face, 'working on 3', a link to the folder", () => {
  const units = {
    "/p/home/": [draft("a", ada)],
    "/p/detail/": [draft("b", ada, { active: false, saved: 60 })],
    "/p/list/": [draft("c", ada, { active: false, saved: 120 })],
  };
  const chips = chipsFor(units, "/p/", NOW);
  assert.equal(chips.length, 1);
  const c = chips[0];
  assert.equal(c.href, "/p/");
  assert.equal(c.live, true);
  assert.equal(c.text, "working on 3");
  assert.equal(c.faces.length, 1);
  assert.equal(c.title, ["Ada's agent is working on home right now · saved 2 min ago", "Ada's agent has a draft open on detail · saved 1 h ago", "Ada's agent has a draft open on list · saved 2 h ago"].join("\n"));
});

test("a folder card with two people puts the live face first and is live", () => {
  const units = {
    "/p/home/": [draft("a", ada, { active: false, saved: 30 })],
    "/p/detail/": [draft("b", ana)],
  };
  const [c] = chipsFor(units, "/p/", NOW);
  assert.deepEqual(c.faces.map((f) => [f.name, f.live]), [["Ana", true], ["Ada", false]]);
  assert.equal(c.live, true);
  assert.equal(c.text, "working on 2");
});

test("a folder card where nobody is live says when the most recent save was", () => {
  const units = {
    "/p/home/": [draft("a", ada, { active: false, saved: 180 })],
    "/p/detail/": [draft("b", ana, { active: false, saved: 45 })],
  };
  const [c] = chipsFor(units, "/p/", NOW);
  assert.equal(c.live, false);
  assert.equal(c.text, "saved 45 min ago");
  assert.deepEqual(c.faces.map((f) => f.name), ["Ana", "Ada"]);
});

test("two drafts by one person on the same prototype under a folder count as one prototype", () => {
  const units = { "/p/home/": [draft("a", ada), draft("b", ada, { session: "session-2" })] };
  const [c] = chipsFor(units, "/p/", NOW);
  assert.equal(c.text, "working");
  assert.equal(c.faces.length, 1);
  assert.equal(c.href, "/p/", "two drafts, so the folder, where each shows");
});

test("a card with nothing beneath gets no chip, and a folder prefix does not swallow a sibling", () => {
  const units = { "/foobar/x/": [draft("a", ada)] };
  assert.deepEqual(chipsFor(units, "/foo/", NOW), []);
  assert.deepEqual(chipsFor(units, "/zzz/", NOW), []);
  assert.deepEqual(chipsFor({}, "/p/", NOW), []);
  assert.deepEqual(chipsFor(null, "/p/", NOW), []);
});

test("faces are capped at three; the tooltip still names everyone", () => {
  const people = ["a", "b", "c", "d"].map((n) => ({ owner: "p-" + n, name: n.toUpperCase(), initials: n.toUpperCase(), color: null }));
  const units = {};
  people.forEach((p, i) => { units["/p/u" + i + "/"] = [draft("d" + i, p, { active: false, saved: 10 + i })]; });
  const [c] = chipsFor(units, "/p/", NOW);
  assert.equal(c.faces.length, 3);
  assert.equal(c.title.split("\n").length, 4);
});

test("the session label appears nowhere; a nameless owner is 'Someone' with '?' initials", () => {
  const units = { "/p/home/": [draft("a", { owner: "p-x", name: null, initials: null, color: null }, { session: "session-99" })] };
  const [c] = chipsFor(units, "/p/home/", NOW);
  assert.equal(c.text, "working");
  assert.equal(c.title, "Careful: Someone's agent is working on this right now · saved 2 min ago");
  assert.equal(c.faces[0].initials, "?");
  assert.ok(!JSON.stringify(c).includes("session-99"));
});

test("a draft opened from the browser is the person's own, not their agent's", () => {
  const units = { "/p/home/": [draft("a", ada, { session: "browser" })] };
  const [c] = chipsFor(units, "/p/home/", NOW);
  assert.equal(c.title, "Careful: Ada is working on this right now · saved 2 min ago");
  const [f] = chipsFor(units, "/p/", NOW);
  assert.equal(f.title, "Ada is working on home right now · saved 2 min ago");
});
