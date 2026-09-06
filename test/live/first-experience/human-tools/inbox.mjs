#!/usr/bin/env node
// inbox.mjs — "your email", as the human session sees it: the last few messages.
import { imapConfig, folderOf } from "../../env.mjs";
import { waitForMail, parseCredentialMail } from "../../inbox.mjs";

const who = process.env.LIVE_HUMAN || "owner";
const since = new Date(Date.now() - 6 * 3600 * 1000);
const m = await waitForMail({ folder: folderOf(who), since, timeoutMs: 1, pollMs: 1, cfg: imapConfig() });
if (!m) { console.log("No new mail in the last few hours."); process.exit(0); }
console.log(`From: the workspace\nSubject: ${m.subject}\nReceived: ${m.at.toISOString()}\n\n${m.text.slice(0, 1500)}`);
// The link is already visible in the text above; called out on its own line too, the way
// a real mail client renders one as a clickable hyperlink rather than plain body text.
const { link } = parseCredentialMail(m.text);
if (link) console.log(`\nLink: ${link}`);
