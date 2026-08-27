// What one workspace is allowed, as one row it carries with it.
//
// `B-quota-schema`. Four enforcement points are coming — asset uploads, board writes,
// realtime rooms, signup invites — and the failure mode if they each carry their own
// number is not that a limit is wrong. It is that nobody can say what the limit IS: raising
// a plan means finding four constants in three files, and the one that gets missed refuses
// a customer who has paid.
//
// So the quotas are SEEDED INTO THE WORKSPACE at provisioning and read from there. A
// workspace's limits then travel with its data, survive an engine deploy, and can be raised
// for one customer without a code change — which is what a support request actually looks
// like.
//
// ⚠️ THE NUMBERS BELOW ARE A STARTING POSITION, NOT A PRICE. The plan item defines the
// SHAPE and says the values are the operator's call. Each one has its reasoning written
// beside it so changing it is an argument with a stated position rather than a guess at
// what the last person meant. TWO of them are not guesses. `editorSeatLimit`: the free tier
// is one editor because the paywall is the SECOND editor, which is the whole business model
// and not a tuning knob. And `rtMonthlyDoMinutes` was MEASURED — a real room, instrumented
// from the inside, driven by two real browser tabs; the note beside it says what the
// measurement was and what it cost.

/**
 * R2's free tier is 10 GB for the WHOLE ACCOUNT, not per workspace. A per-workspace cap
 * that ignores that is a cap that never fires until the account bill does.
 */
const ACCOUNT_R2_FREE_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * How many free workspaces the account's free storage is meant to hold. THIS is the number
 * to turn: it is the one with a meaning ("free workspaces we can carry before storage
 * costs money"), and the byte cap falls out of it.
 */
const FREE_WORKSPACES_PER_ACCOUNT = 40;

/**
 * A working month in minutes — 22 days of 8 hours. The realtime cap below is written in
 * board time rather than in a bare number because "how long boards may be live" is a
 * sentence somebody can check against their own week, and 10560 is not.
 */
const WORKING_MINUTES_PER_MONTH = 22 * 8 * 60;

/**
 * The quota shape. Every field is a number, and every enforcement point reads its ceiling
 * from here rather than declaring one.
 *
 * `null` is not used and must not be: an absent ceiling written as null reads as "no limit"
 * at one call site and "not configured, refuse" at another. Unlimited is a very large
 * number, so every comparison has the same meaning everywhere.
 */
export const QUOTA_FIELDS = Object.freeze([
  "editorSeatLimit",
  "storageBytesCap",
  "assetUploadDailyBytes",
  "boardWritesPerMinute",
  "rtConcurrentRooms",
  "rtMonthlyDoMinutes",
]);

export const PLANS = Object.freeze({
  free: Object.freeze({
    // ONE editor. Not a tuning knob — the paywall is the second editor, and everything
    // else on this list is a cost ceiling rather than a product boundary. Viewers and
    // commenters are not seats: a workspace nobody can show anything to is not a workspace.
    editorSeatLimit: 1,
    // The account's free storage divided by how many free workspaces it is meant to carry.
    // A published design system with a few dozen prototypes is tens of megabytes, so this
    // is generous for what it is for and firm about what it is not (an image host).
    storageBytesCap: Math.floor(ACCOUNT_R2_FREE_BYTES / FREE_WORKSPACES_PER_ACCOUNT),
    // Per DAY, and it is deliberately a fraction of the total cap: the thing this stops is
    // a script filling a workspace overnight, which the total cap alone would allow right
    // up to the moment it is full.
    assetUploadDailyBytes: 50 * 1024 * 1024,
    // A canvas board writes on a debounce, not per keystroke, so a person costs a handful
    // a minute. This is loose enough that nobody drawing hits it and tight enough that a
    // loop does.
    boardWritesPerMinute: 300,
    // Concurrent multiplayer rooms. This used to say a room "stays awake while somebody is
    // in it, which is the realtime bill in one sentence", and the measurement below refutes
    // that: a room with people in it and nobody touching it is hibernated and costs nothing.
    // What this stops is a workspace holding hundreds of rooms open at once, which the
    // monthly cap alone would allow right up to the moment it is spent.
    rtConcurrentRooms: 5,
    // Minutes those rooms may stay awake in a month. ONE BOARD LIVE EVERY WORKING HOUR OF
    // THE MONTH — which one editor cannot reach, and that is the point: this is a runaway
    // stop, not a ration.
    //
    // It is set from a measurement, not chosen. test/rt-cost/ instruments a real room from
    // the inside and test/rt-cost/results/ is the recording; a room was driven both by a
    // replay of the client's own cadence and by two browser tabs running the real client.
    // An hour of editing keeps the room awake 32.7 minutes with one person in it and 54.7 with
    // two — the same object either way, so a second person is nearly free and a cap on room
    // minutes is a cap on how long boards are LIVE, never on head count. A heavy month for
    // one editor is therefore around 1300 awake minutes, and the 1000 that stood here would
    // have cut that person off.
    //
    // ⚠️ AWAKE IS NOT BILLED, AND THE GAP IS TWO ORDERS OF MAGNITUDE. Duration is charged
    // while the object is running or idle-but-unable-to-hibernate, and a room whose sockets
    // all went through the hibernation API is eligible in every gap between messages. The
    // same recording puts the object's actual handler occupancy under one per cent of its
    // awake time, so this cap corresponds to at most a couple of minutes of charged
    // duration — a fairness limit long before it is a cost one. On the deployed runtime the
    // object was never evicted at all across 150 seconds of silence, so residency there is
    // nearer "a socket is open" than "somebody is working", and it still costs nothing.
    //
    // Two cases are deliberately NOT averaged into the number above. An idle tab costs
    // NOTHING: five minutes, two tabs, 52 keepalives, zero events reached the object,
    // because the runtime answers them from the auto-response pair without waking it. And
    // the tail after the last person leaves is one flush of about 11ms, plus one already-
    // armed alarm that fires later into an empty room and returns.
    rtMonthlyDoMinutes: WORKING_MINUTES_PER_MONTH,
  }),
  paid: Object.freeze({
    // The only difference that is a PRODUCT difference. The rest are raised because a
    // paying workspace's costs are covered, not because the free tier was mean.
    editorSeatLimit: 100,
    storageBytesCap: 20 * 1024 * 1024 * 1024,
    assetUploadDailyBytes: 2 * 1024 * 1024 * 1024,
    boardWritesPerMinute: 3000,
    rtConcurrentRooms: 100,
    // Ten boards live every working hour of the month, at the measured cost of a room with
    // more than one person on it. Ten because that is what a hundred seats spread over
    // shared boards looks like when the whole team is working, and because the measurement
    // says the ceiling costs about a thousand minutes of charged duration a month — inside
    // the account's included allowance on its own.
    rtMonthlyDoMinutes: 10 * WORKING_MINUTES_PER_MONTH,
  }),
});

export const DEFAULT_PLAN = "free";

/**
 * The quota values a plan implies, as a flat name→number map including `plan` itself.
 * An unknown plan name resolves to the free tier rather than to no limits: a typo in a
 * billing webhook must not be how somebody gets an unlimited workspace.
 */
export function quotasForPlan(plan, plans = PLANS) {
  const name = plans[plan] ? plan : DEFAULT_PLAN;
  return Object.freeze({ plan: name, ...plans[name] });
}
