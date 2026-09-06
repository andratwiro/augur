#!/usr/bin/env node
// test/live/restore-all.mjs — leave every drill unit as it was found: discard every open
// draft on it and restore its first recorded landing (the live copy the object adopted).
// History keeps every row, by design; main's bytes go back to what they were.
import { UNITS, RUN } from "./env.mjs";
import { human } from "./persona.mjs";

const owner = await human("owner");
for (const unit of UNITS()) {
  const p = await owner.presence(unit);
  let discarded = 0;
  for (const d of p.drafts || []) { const r = await owner.discardFromBar(unit, d.id || d.draftId); if (r.status === 200) discarded++; }
  const h = await owner.history(unit);
  let restored = null;
  if (h.revision > 1 && !(h.landings[0] && h.landings[0].restoredFrom === 1)) {
    const r = await owner.restore(unit, 1, `${RUN} restore-all`);
    restored = r.status;
  }
  console.log(`${unit}  drafts discarded: ${discarded}  revision: ${h.revision}  restored: ${restored === null ? "already at the first landing" : restored}`);
}
