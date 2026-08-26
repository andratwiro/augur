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
// what the last person meant. The one that is not a guess is `editorSeatLimit`: the free
// tier is one editor because the paywall is the SECOND editor, which is the whole business
// model and not a tuning knob.

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
    // Concurrent multiplayer rooms. A room is a Durable Object that stays awake while
    // somebody is in it, which is the realtime bill in one sentence.
    rtConcurrentRooms: 5,
    // Wall-clock minutes those rooms may stay awake in a month. The cap that actually
    // corresponds to money; the concurrency one above just stops a single burst.
    // ⚠️ 1000 IS A PLACEHOLDER STANDING IN FOR A MEASUREMENT, not a number anybody
    // chose. Nobody knows what a canvas session costs in Durable Object wall-clock, so
    // this one is a guess wearing a round number: read it as unknown rather than as
    // agreed. B-rt-do-minutes-measure instruments a real board and sets it from the
    // result.
    rtMonthlyDoMinutes: 1000,
  }),
  paid: Object.freeze({
    // The only difference that is a PRODUCT difference. The rest are raised because a
    // paying workspace's costs are covered, not because the free tier was mean.
    editorSeatLimit: 100,
    storageBytesCap: 20 * 1024 * 1024 * 1024,
    assetUploadDailyBytes: 2 * 1024 * 1024 * 1024,
    boardWritesPerMinute: 3000,
    rtConcurrentRooms: 100,
    rtMonthlyDoMinutes: 100000,
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
