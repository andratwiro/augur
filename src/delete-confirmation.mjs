/**
 * What a person is shown BEFORE a workspace is deleted.
 *
 * `F-tenant-delete-ux`. A delete is the one act on a workspace that no rollback reaches, so
 * the screen in front of it has two jobs and this module is both of them: offer the export
 * first, and state the retention window truthfully.
 *
 * ⚠️ EVERY NUMBER HERE IS DERIVED, AND THAT IS THE WHOLE POINT OF THE MODULE. The window is
 * computed from the grace the tombstone actually uses (`DELETE_GRACE_MS` in `tenant-do.js`)
 * and from the backup rotation the deployment declares — never typed. A hand-typed "30 days"
 * in a confirmation screen is a promise that keeps being true only for as long as nobody
 * changes the constant, and the day somebody does, the screen is the last thing anyone
 * thinks to check. Derived copy cannot drift: change the constant and the sentence changes
 * with it, or the test that pins the sentence fails.
 *
 * ⚠️ IT NEVER INVENTS THE BACKUP NUMBER. The engine knows exactly how long a tombstone
 * survives, because it writes that date itself. It does NOT know how long a deployment's
 * off-site backup copies live — that is a rotation somebody configures outside this code —
 * so `backupRetentionMs` is an input with no default, and with none supplied the copy says
 * that a backup copy outlives the erasure WITHOUT naming a period. Two wrong answers were
 * available and both are worse: inventing a number promises a schedule nobody runs, and
 * saying nothing at all tells a customer their data is gone everywhere when a backup still
 * holds it. Absent is a fact, and the copy states it as one.
 *
 * ⚠️ IT RENDERS NOTHING. The confirmation is CONTENT — strings and numbers — because the two
 * surfaces that show it live in different repos and cannot import each other: a workspace's
 * own settings here, and an operator console in the control plane. A shape that crosses the
 * wire is the only kind both can read, which is why `GET /__control/delete` serves this and
 * nothing hand-copies the words.
 *
 * No product name, no deployment name, no address: a self-hosted instance and a hosted one
 * show the same words, and "whoever runs this service" is the honest way to name an operator
 * this code cannot identify.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The command that takes a copy of everything, including what `--full` adds. */
export const EXPORT_COMMAND = "augur export --full";

/** The route that command walks, for a surface that would rather link than instruct. */
export const EXPORT_PATH = "/__publish/_state/export";

/**
 * Whole days, rounded DOWN, and the rounding direction is deliberate.
 *
 * A window stated as longer than it is, is a promise the erasure breaks. Flooring can only
 * understate — somebody is told 30 days and gets 30 days and a few hours — and understating
 * a deadline is the safe side of this particular wrong answer.
 */
function wholeDays(ms) {
  return Math.floor(ms / DAY_MS);
}

/** "1 person" / "4 people" — a count that reads as English rather than as a field. */
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The retention window, as numbers.
 *
 * `serviceDays` is what the tombstone gives you: the data is all still there, and the
 * erasure refuses until the date passes. `backupDays` is the day the LAST copy anywhere
 * expires — the grace plus the rotation, not the rotation on its own, because a backup taken
 * the day before the erasure still holds the workspace and its own clock starts then.
 * `null` means the deployment has not declared a rotation.
 */
export function retentionWindow({ graceMs, backupRetentionMs = null } = {}) {
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error("delete-confirmation: graceMs is required and must be a finite duration");
  }
  const configured = Number.isFinite(backupRetentionMs) && backupRetentionMs >= 0;
  return {
    serviceDays: wholeDays(graceMs),
    backupDays: configured ? wholeDays(graceMs + backupRetentionMs) : null,
  };
}

/**
 * The sentence the published lifecycle policy owns, rebuilt from the live numbers.
 *
 * ⚠️ BYTE-IDENTICAL, ON PURPOSE, to the promise a customer already read before they got
 * here: "gone from the service in 30 days, gone from the backups within 70". A confirmation
 * screen that paraphrases the policy is a second policy, and the second one is the one
 * nobody updates. Lower case and no full stop, because it is a CLAUSE — the policy page
 * lands it mid-sentence and a confirmation screen wants a capital, so both grow their own
 * punctuation from the same words rather than each keeping a copy of the sentence.
 *
 * With no rotation declared the clause stops at the half this code can prove.
 */
export function retentionClause(window) {
  const service = `gone from the service in ${plural(window.serviceDays, "day", "days")}`;
  if (window.backupDays == null) return service;
  return `${service}, gone from the backups within ${window.backupDays}`;
}

function sentence(clause) {
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

/**
 * What this workspace holds, as counts.
 *
 * Straight off `status()`, so a confirmation cannot disagree with the workspace's own
 * account of itself, and counts ONLY — the same rule `status()` keeps. A confirmation screen
 * is read by an operator who administers somebody else's workspace, and a comment body has
 * no business being anywhere near one.
 *
 * Zeroes are dropped rather than listed: "0 boards" is noise on a screen whose job is to
 * make somebody hesitate over what is actually there.
 */
function holdings(status) {
  if (!status) return { items: [], line: null };
  const items = [
    ["members", plural(status.members || 0, "person", "people")],
    ["threads", plural(status.threads || 0, "comment thread", "comment threads")],
    ["boards", plural(status.boards || 0, "board", "boards")],
    ["images", plural(status.images || 0, "image", "images")],
  ]
    .filter(([k]) => Number(status[k] || 0) > 0)
    .map(([, text]) => text);
  if (!items.length) return { items: [], line: null };
  const line = items.length === 1
    ? items[0]
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return { items, line };
}

/**
 * The whole confirmation, for one workspace, at one instant.
 *
 * `at` is passed in rather than read from the clock so the erasure date on the screen and
 * the erasure date the delete writes are the same arithmetic on the same instant. A screen
 * that computed its own "now" would be off by the time somebody spent reading it, which is
 * harmless until the day it straddles midnight and the date shown is not the date written.
 *
 * `alreadyDeleted` is not an error case: somebody reaching this screen for a workspace that
 * is already tombstoned needs the date it is erased on, not a second chance to delete it.
 */
export function deleteConfirmation({
  workspaceId,
  graceMs,
  at = Date.now(),
  backupRetentionMs = null,
  status = null,
} = {}) {
  const id = String(workspaceId || "");
  const window = retentionWindow({ graceMs, backupRetentionMs });
  const clause = retentionClause(window);
  const startedAt = status && status.deletedAt ? Date.parse(status.deletedAt) : NaN;
  const already = !!(status && status.deleted);
  // An existing tombstone keeps its own date. Re-deleting does not restart the clock
  // (`deleteWorkspace` refuses to), so a screen offering a fresh window would be lying about
  // arithmetic that has already happened.
  const erasedAt = already && status.purgeAfter
    ? Date.parse(status.purgeAfter)
    : (Number.isFinite(startedAt) ? startedAt : Number(at)) + graceMs;
  const erasedOn = new Date(erasedAt).toISOString();
  const holds = holdings(status);

  const timeline = [
    {
      when: "Immediately",
      what: "The workspace stops being served. Its address goes dark, signing in to it "
        + "stops, and nothing it published is reachable by anyone.",
    },
    {
      when: `For ${plural(window.serviceDays, "day", "days")}`,
      what: "The data still exists, tombstoned. Nothing has been erased, and a delete "
        + "somebody regrets can still be undone by whoever runs this service.",
    },
    {
      when: `On ${erasedOn.slice(0, 10)}`,
      what: "Everything is erased from the live service: published content, uploads, "
        + "comments, boards, roster, history.",
    },
    window.backupDays == null
      ? {
        when: "After that",
        what: "A backup copy can outlive the erasure. Backups are kept on their own "
          + "rotation and are not thinned to remove one workspace — the last copy is "
          + "waited out rather than rewritten.",
      }
      : {
        when: `Within ${plural(window.backupDays - window.serviceDays, "further day", "further days")}`,
        what: "The last backup copy containing it expires. After that no copy exists "
          + "anywhere, and there is nothing left for anyone to restore.",
      },
  ];

  return {
    workspace: id,
    title: already ? `${id} is already deleted` : `Delete ${id}?`,
    alreadyDeleted: already,
    holds: holds.items,
    holdsLine: holds.line,
    // Two steps, in this order, and the order IS the feature. The export is offered BEFORE
    // the confirm rather than beside it, because the only copy that survives a delete is the
    // one somebody took first, and a nudge that shares a row with the button that deletes is
    // a nudge nobody reads.
    steps: [
      {
        id: "export",
        title: already ? "You can still take a copy" : "Take a copy first",
        body: already
          ? `A full export still runs on a deleted workspace until it is erased. `
            + `Run ‘${EXPORT_COMMAND}’ while the data is still here.`
          : `Run ‘${EXPORT_COMMAND}’ before you confirm. It is one command, it `
            + `takes minutes, and it is the only copy that is definitely yours.`,
        command: EXPORT_COMMAND,
        path: EXPORT_PATH,
      },
      {
        id: "confirm",
        title: already ? "Nothing further to confirm" : "Then confirm",
        body: already
          ? `This workspace is already tombstoned. Deleting it again changes nothing and `
            + `does not move the date below.`
          : `Type the workspace's name to confirm. There is no undo once the date below `
            + `passes.`,
        confirmWith: already ? null : id,
      },
    ],
    timeline,
    retention: {
      serviceDays: window.serviceDays,
      backupDays: window.backupDays,
      graceMs,
      erasedOn,
      // The clause the published policy owns, and the sentence a screen shows. Both from
      // the same words — see retentionClause.
      clause,
      summary: sentence(clause),
    },
  };
}

/**
 * A deployment's declared backup rotation, in milliseconds, or `null`.
 *
 * ⚠️ IT FAILS TO `null`, NEVER TO A NUMBER. Unset, blank, negative, non-numeric — every one
 * of them means "this deployment has not told me", and the copy then states the backup tail
 * without a period rather than guessing at one. A default here would be the invented number
 * this module exists to refuse: an operator who never configured a rotation would get a
 * confirmation screen promising a schedule that nothing runs.
 */
export function backupRetentionFromEnv(env) {
  const raw = env && env.BACKUP_RETENTION_DAYS;
  if (raw == null || raw === "") return null;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) return null;
  return days * DAY_MS;
}
