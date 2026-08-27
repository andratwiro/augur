/* Measurement harness for what a canvas room costs in Durable Object ACTIVE DURATION.
 * Not shipped, not part of `npm test` (that glob is test/*.test.mjs, one level up).
 *
 * WHY IT EXISTS. Durable Objects bill on active duration — wall-clock time the object is
 * resident and not hibernated — and no line of this repo knew what one board session
 * costs. An account-level bill cannot be divided back into a per-board number, so the
 * measurement has to happen INSIDE the room.
 *
 * WHAT IT MEASURES, AND THE ONE INFERENCE IT RESTS ON. A Durable Object cannot observe
 * its own eviction: there is no destructor. But it can observe its own BIRTH, and that is
 * enough, because the runtime constructs the class exactly once per residency. So:
 *
 *   two events with no `ctor` between them  ⇒  the object was resident for the whole gap
 *   two events WITH a `ctor` between them   ⇒  the object was evicted and woken
 *
 * Every wake therefore shows up as a `ctor` line, and the eviction grace (the idle window
 * the runtime waits before evicting) is measured, not assumed: measure.mjs walks a probe
 * gap upward until a `ctor` appears.
 *
 * The room under test is the REAL one — this subclasses BoardRoom and delegates every
 * handler — and the front door is the REAL one too: the default export is the realtime
 * worker's own fetch, with the shared-secret header the site worker's rtProxy adds in
 * production supplied here instead, so an ordinary browser WebSocket (which cannot set
 * request headers) reaches it unchanged.
 *
 * Instrumentation is console.log ONLY. A storage write per event would be I/O the object
 * has to stay awake for, i.e. the harness would inflate the very number it is measuring.
 */
import { BoardRoom } from "../../src/board-room.mjs";
import rtWorker from "../../realtime/src/index.js";

let SEQ = 0;
// One line per lifecycle event. `t` is the object's own Date.now(): inside a Worker that
// clock is pinned to the last I/O and does not advance mid-turn, which is fine here
// because every event is its own turn — but it is why nothing below tries to time a
// synchronous span with it.
function rec(o) {
  console.log("RTCOST " + JSON.stringify({ seq: ++SEQ, t: Date.now(), ...o }));
}

// ⚠️ THE LOG PIPE IS NOT AVAILABLE EVERYWHERE, AND ITS SILENCE LOOKS LIKE AN ANSWER.
// Locally the ledger comes off the runtime's stdout and is complete. Against a DEPLOYED
// worker it has to come through `wrangler tail`, which delivered nothing at all for a
// Durable Object's console output — and "no ctor line" is exactly what this measurement
// is looking for, so an empty pipe produces a confident wrong answer. So the one event
// that carries the result — a wake — is ALSO written where a pipe cannot lose it: the
// object's own storage, read back over a route at the end of the run. Off by default,
// because the local runs were recorded without it and an instrument that changes between
// runs is not one instrument.
const WAKE_KEY = "instr:wake:";
const wakeLog = (env) => !!(env && env.INSTR_STORAGE);

export class MeasuredRoom extends BoardRoom {
  constructor(ctx, env) {
    super(ctx, env);
    this.inst = Math.random().toString(36).slice(2, 8);
    let n = -1;
    try { n = ctx.getWebSockets().length; } catch (e) {}
    rec({ ev: "ctor", inst: this.inst, sockets: n });
    // One small write per RESIDENCY — not per event — so it costs a wake the object was
    // already paying for and adds nothing to the gaps this is trying to measure.
    if (wakeLog(env)) {
      const at = Date.now();
      try { ctx.storage.put(WAKE_KEY + String(at).padStart(16, "0"), { at, inst: this.inst, sockets: n }); } catch (e) {}
    }
  }

  async fetch(request) {
    if (wakeLog(this.env) && new URL(request.url).searchParams.get("instr") === "wakes") {
      const rows = await this.ctx.storage.list({ prefix: WAKE_KEY });
      return new Response(JSON.stringify({ wakes: [...rows.values()] }), { headers: { "content-type": "application/json" } });
    }
    rec({ ev: "fetch:in", inst: this.inst });
    const r = await super.fetch(request);
    rec({ ev: "fetch:out", inst: this.inst, sockets: this.ctx.getWebSockets().length });
    return r;
  }

  async webSocketMessage(ws, raw) {
    // A "ping" arriving HERE would mean the auto-responder is not intercepting it, i.e.
    // the keepalive wakes the room every 25s per tab. That is the hibernation claim, so
    // the kind is recorded rather than assumed.
    let k = "?";
    try { k = raw === "ping" ? "PING-REACHED-HANDLER" : (JSON.parse(raw).t || "?"); } catch (e) {}
    rec({ ev: "msg:in", inst: this.inst, k, n: typeof raw === "string" ? raw.length : 0 });
    const r = await super.webSocketMessage(ws, raw);
    rec({ ev: "msg:out", inst: this.inst, k });
    return r;
  }

  webSocketClose(ws, code, reason, clean) {
    rec({ ev: "close:in", inst: this.inst });
    const r = super.webSocketClose(ws, code, reason, clean);
    rec({ ev: "close:out", inst: this.inst, sockets: this.ctx.getWebSockets().length });
    return r;
  }

  webSocketError(ws, err) {
    rec({ ev: "error", inst: this.inst });
    return super.webSocketError(ws, err);
  }

  // ⚠️ THE ONE THAT CAUGHT A WRONG MEASUREMENT. A room whose doc is still null relays ops
  // without applying them — no storage write, no dirty flag, no alarm — and from the
  // outside that is indistinguishable from a room doing its job. Recording how many ops
  // were ACCEPTED is what turns "the messages arrived" into "the room did the work", and
  // it is why the driver's client completes the seed handshake instead of just sending.
  applyOps(ops, seedMode) {
    const r = super.applyOps(ops, seedMode);
    rec({ ev: "apply", inst: this.inst, n: ops.length, ok: r.accepted.length, corr: r.corrections.length });
    return r;
  }

  // The 45s KV-mirror alarm is the one thing that can wake a room nobody is touching, so
  // whether it is ARMED and whether it FIRES are two separate observations and both are
  // recorded. A run that shows the arming and never the firing is a runtime that does not
  // deliver alarms, not a room that does not need one.
  markDirty() {
    const was = this.alarmSet;
    const r = super.markDirty();
    if (!was) rec({ ev: "arm", inst: this.inst, alarmSet: this.alarmSet });
    return r;
  }

  async alarm() {
    rec({ ev: "alarm:in", inst: this.inst });
    const r = await super.alarm();
    rec({ ev: "alarm:out", inst: this.inst });
    return r;
  }

  // The tail after the last person leaves: reap() kicks off load→mirror WITHOUT awaiting
  // it, so close:out returns long before the room is done. This is the event that says
  // when the work actually finished.
  async mirror() {
    rec({ ev: "mirror:in", inst: this.inst });
    const r = await super.mirror();
    rec({ ev: "mirror:out", inst: this.inst });
    return r;
  }
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    // The read-back for the storage wake log. Deliberately NOT part of the realtime front
    // door: it is the harness asking the object a question, and it runs at the END of a
    // measurement, so the wake it causes is after everything being measured.
    if (wakeLog(env) && url.pathname === "/wakes") {
      const path = url.searchParams.get("path") || "";
      if (!path) return new Response('{"error":"bad-input"}', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(path)).fetch(new Request(request.url + "&instr=wakes", request));
    }
    // Same two lines the site worker's rtProxy runs in production: re-wrap so a header
    // can be added, then hand it to the realtime worker's own front door. Without this a
    // browser WebSocket could not authenticate, and the alternative — weakening the
    // secret check — would measure a front door nobody deploys.
    const req = new Request(request);
    req.headers.set("x-augur-rt", env.RT_SHARED_SECRET || "");
    return rtWorker.fetch(req, env, ctx);
  },
};
