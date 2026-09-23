/* The criteria page (an "oracle"), served by the engine at /__oracle/ the way the canvas
   is at /__canvas/: a prototype's `oracle/index.html` is a loader, and this file draws it.

   One document per prototype: the sentences the prototype must keep true,
   written by a person, each one a `criterion` block that shows, beside the sentence, what
   the last check found. The page never runs a check. Checks run on a machine (`oracle
   check`) and post what they found to a second document, which this page only reads.

   Two documents, two writers, so neither overwrites the other:
     /__board?path=<this page>          the criteria and the sign-offs. Written here.
     /__board?path=<this page>results   what the checks found. Written by the runner.

   Every criteria page on every workspace loads this one file, so a change here changes all
   of them with the next engine deploy. */
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs, filterSuggestionItems } from '@blocknote/core';
import { createReactBlockSpec, SuggestionMenuController, getDefaultReactSlashMenuItems } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/mantine/style.css';
import './oracle.css';

const CFG = window.ORACLE || {};
const PAGE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
const CRITERIA_PATH = PAGE;
const RESULTS_PATH = PAGE + 'results';

/* ── the text a check is bound to ────────────────────────────────────────────
   The runner hashes the same string the same way, so a sentence edited after its check
   was written reads as reworded on both sides. */
export const norm = s => String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
export function textHash(s){
  let h = 0x811c9dc5;
  const t = norm(s);
  for(let i = 0; i < t.length; i++){ h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const plain = content => Array.isArray(content)
  ? content.map(c => c.type === 'text' ? c.text : c.type === 'link' ? plain(c.content) : '').join('') : '';

/* ── store ─────────────────────────────────────────────────────────────────── */
const state = { doc: null, results: null, me: null, loaded: false, saving: false, saved: null, error: null };
const subs = new Set();
const emit = () => { state.v = (state.v || 0) + 1; subs.forEach(f => f()); };
const useStore = () => useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => state.v);

async function getBoard(path){
  const r = await fetch('/__board?path=' + encodeURIComponent(path), { cache: 'no-store', credentials: 'same-origin' });
  if(!r.ok) throw new Error('read ' + r.status);
  return (await r.json()).doc || null;
}
async function putBoard(path, doc){
  const r = await fetch('/__board?path=' + encodeURIComponent(path), {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }),
  });
  if(!r.ok) throw new Error('save ' + r.status);
}

/* ── statuses ──────────────────────────────────────────────────────────────── */
const PASSING = new Set(['pass', 'signed']);
const LABEL = {
  pass: 'Passing', fail: 'Failing', unbound: 'Needs a check', rebind: 'Reworded, needs a new check',
  unproven: 'Check not proven', flag: 'Flagged', unsigned: 'Awaiting your sign-off', signed: 'Signed off',
  unchecked: 'Not checked yet', error: 'Check broke', proposed: 'Proposed by an agent',
};
const TONE = {
  pass: 'good', signed: 'good', fail: 'bad', error: 'bad', unbound: 'open', rebind: 'open', unproven: 'open',
  flag: 'warn', unsigned: 'warn', unchecked: 'open', proposed: 'warn',
};
const KIND = { rule: 'Rule', flow: 'Flow', taste: 'Taste', diff: 'Render' };

function criteria(blocks){
  const out = [];
  const walk = bs => (bs || []).forEach(b => {
    if(b.type === 'criterion' && !b.props.proposed) out.push({ cid: b.props.cid, kind: b.props.kind, text: norm(plain(b.content)) });
    if(b.children) walk(b.children);
  });
  walk(blocks);
  return out.filter(c => c.cid && c.text);
}

function statusOf(c){
  if(c.proposed) return { status: 'proposed' };
  const signoffs = (state.doc && state.doc.signoffs) || {};
  const r = state.results && state.results.results && state.results.results[c.cid];
  if(c.kind === 'taste') return { status: signoffs[c.cid] ? 'signed' : 'unsigned', kind: 'taste', r };
  if(!r) return { status: 'unchecked', r };
  return { status: r.status, kind: r.kind, r, edited: r.text && r.text !== textHash(c.text) };
}

/* ── the criterion block ───────────────────────────────────────────────────── */
function when(iso){
  if(!iso) return '';
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if(s < 90) return 'just now';
  if(s < 3600) return Math.round(s / 60) + ' min ago';
  if(s < 86400) return Math.round(s / 3600) + ' h ago';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function Meta({ block, editor }){
  useStore();
  const c = { cid: block.props.cid, kind: block.props.kind, proposed: block.props.proposed, text: norm(plain(block.content)) };
  if(c.proposed){
    const accept = () => editor.updateBlock(block.id, { props: { ...block.props, proposed: '' } });
    const dismiss = () => editor.removeBlocks([block.id]);
    return (
      <div className="or-meta" contentEditable={false}>
        <span className="or-status" data-tone="warn">{LABEL.proposed}</span>
        <span className="or-line">{c.proposed}</span>
        <button className="or-btn" onClick={accept}>Accept</button>
        <button className="or-btn" onClick={dismiss}>Dismiss</button>
      </div>
    );
  }
  const { status, kind, r, edited } = statusOf(c);
  const signoff = ((state.doc && state.doc.signoffs) || {})[c.cid];
  const sign = on => {
    const doc = state.doc || (state.doc = {});
    doc.signoffs = { ...(doc.signoffs || {}) };
    if(on) doc.signoffs[c.cid] = { by: state.me || 'you', at: new Date().toISOString() };
    else delete doc.signoffs[c.cid];
    emit(); scheduleSave();
  };
  const accept = () => {
    const doc = state.doc || (state.doc = {});
    doc.accepted = { ...(doc.accepted || {}), [c.cid]: { by: state.me || 'you', at: new Date().toISOString(),
      run: state.results && state.results.at } };
    emit(); scheduleSave();
  };
  const reject = () => {
    const doc = state.doc || (state.doc = {});
    doc.rejected = { ...(doc.rejected || {}), [c.cid]: { by: state.me || 'you', at: new Date().toISOString(),
      run: state.results && state.results.at } };
    emit(); scheduleSave();
  };
  const accepted = ((state.doc && state.doc.accepted) || {})[c.cid];
  const rejected = ((state.doc && state.doc.rejected) || {})[c.cid];
  const acceptPending = accepted && state.results && accepted.run === state.results.at;
  const rejectPending = rejected && state.results && rejected.run === state.results.at;
  const shots = kind === 'diff' && status === 'fail' && r && Array.isArray(r.shots) ? r.shots : [];
  let line = r && r.line ? r.line : '';
  if(status === 'unbound') line = line || 'No check is written for this yet.';
  if(status === 'rebind') line = line || 'The sentence changed after its check was written.';
  if(status === 'unchecked') line = 'Runs on the next check.';
  if(status === 'signed' && signoff) line = 'Signed off by ' + signoff.by + ', ' + when(signoff.at) + '. Holds until you withdraw it.';
  return (
    <div className="or-meta" contentEditable={false}>
      <span className="or-status" data-tone={TONE[status] || 'open'}>{LABEL[status] || status}</span>
      {kind && KIND[kind] ? <span className="or-kind">{KIND[kind]}</span> : null}
      {line ? <span className="or-line">{line}</span> : null}
      {edited ? <span className="or-edited">Edited since the last check</span> : null}
      {kind === 'taste' || c.kind === 'taste'
        ? <button className="or-btn" onClick={() => sign(!signoff)}>{signoff ? 'Withdraw' : 'Sign off'}</button> : null}
      {kind === 'diff' && status === 'fail' && !rejectPending
        ? <button className="or-btn" onClick={accept} disabled={acceptPending}>
            {acceptPending ? 'Accepted, applies on the next check' : 'Accept what it shows now'}</button> : null}
      {kind === 'diff' && status === 'fail' && !acceptPending
        ? <button className="or-btn" onClick={reject} disabled={rejectPending}>
            {rejectPending ? 'Rejected: agents must undo it' : 'Reject'}</button> : null}
      {shots.length ? (
        <div className="or-shots">
          {shots.map((sh, i) => (
            <figure className="or-shot" key={i}>
              <figcaption>{sh.label || sh.state}</figcaption>
              <div className="or-shot__pair">
                <div><span>Accepted</span>{sh.before ? <img src={sh.before} alt="What was accepted" /> : <em>No picture kept</em>}</div>
                <div><span>Now</span>{sh.after ? <img src={sh.after} alt="What it shows now" /> : <em>No picture</em>}</div>
              </div>
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Crit({ block, contentRef, editor }){
  useStore();
  const c = { cid: block.props.cid, kind: block.props.kind, proposed: block.props.proposed, text: norm(plain(block.content)) };
  const { status } = statusOf(c);
  return (
    <div className="or-crit" data-tone={TONE[status] || 'open'}>
      <span className="or-dot" contentEditable={false} aria-hidden="true" />
      <span className="or-id" contentEditable={false}>{block.props.cid || '·'}</span>
      <div className="or-body">
        <p className="or-text" ref={contentRef} />
        <Meta block={block} editor={editor} />
      </div>
    </div>
  );
}

const Criterion = createReactBlockSpec(
  { type: 'criterion', propSchema: { cid: { default: '' }, kind: { default: '' }, proposed: { default: '' } }, content: 'inline' },
  { render: props => <Crit {...props} /> }
);

const { audio, image, video, file, codeBlock, pageBreak, ...prose } = defaultBlockSpecs;
const schema = BlockNoteSchema.create({ blockSpecs: { ...prose, criterion: Criterion() } });

/* ── verdict ───────────────────────────────────────────────────────────────── */
function Verdict({ editor }){
  useStore();
  const cs = criteria(editor.document);
  const counts = {};
  cs.forEach(c => { const s = statusOf(c).status; counts[s] = (counts[s] || 0) + 1; });
  const passing = cs.filter(c => PASSING.has(statusOf(c).status)).length;
  const holding = cs.length > 0 && passing === cs.length;
  const parts = [
    ['fail', 'failing'], ['error', 'broken'], ['unbound', 'need a check'], ['rebind', 'reworded'],
    ['unproven', 'not proven'], ['flag', 'flagged'], ['unsigned', 'await your sign-off'], ['unchecked', 'not checked yet'],
  ].filter(([k]) => counts[k]).map(([k, w]) => counts[k] + ' ' + w);
  const r = state.results;
  let proposed = 0;
  const walkP = bs => (bs || []).forEach(b => { if(b.type === 'criterion' && b.props.proposed) proposed++; if(b.children) walkP(b.children); });
  walkP(editor.document);
  if(proposed) parts.push(proposed + ' proposed, waiting for you');
  return (
    <div className="or-verdict" data-holding={holding ? 'yes' : 'no'}>
      <div className="or-verdict__head">
        <span className="or-verdict__dot" aria-hidden="true" />
        <strong>{!cs.length ? 'No criteria yet' : holding ? 'Holding' : 'Not holding'}</strong>
        {cs.length ? <span className="or-verdict__n">{passing} of {cs.length} pass</span> : null}
      </div>
      {parts.length ? <p className="or-verdict__parts">{parts.join(' · ')}</p> : null}
      <p className="or-verdict__run">
        {r && r.at ? 'Last checked ' + when(r.at) + (r.tier === 'full' ? ', every check' : ', quick checks only') : 'Never checked'}
        {state.saving ? ' · Saving' : state.error ? ' · ' + state.error : ''}
      </p>
    </div>
  );
}

/* How this works: a button beside the title opens it in a dialog, so the page itself is
   only the criteria. Escape, the close button or a click outside closes it. */
function About(){
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if(!open) return;
    const key = e => { if(e.key === 'Escape') setOpen(false); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [open]);
  return (
    <>
      <button className="or-btn or-about__btn" onClick={() => setOpen(true)}>How this works</button>
      {open ? (
        <div className="or-modal" onClick={e => { if(e.target === e.currentTarget) setOpen(false); }}>
          <div className="or-modal__box" role="dialog" aria-modal="true" aria-labelledby="or-about-title">
            <h2 id="or-about-title">How this works</h2>
            <p>Each criterion is something this prototype must keep true. You write the sentence. An agent writes
        the check behind it, and proves the check can fail before it counts.</p>
      <p>The prototype holds when every criterion passes. An agent working on it cannot finish, or land,
        while it has turned a passing criterion red. Taste criteria pass when you sign them off, and stay
        signed until you withdraw them.</p>
      <p>Reword a criterion and its check has to be written again. Type <kbd>/</kbd> to add one. When you correct
        an agent, it may propose the rule behind the correction here; it counts once you accept it.</p>
            <div className="or-modal__acts"><button className="or-btn" autoFocus onClick={() => setOpen(false)}>Close</button></div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ── ids ───────────────────────────────────────────────────────────────────── */
function nextId(blocks){
  let n = 0;
  const walk = bs => (bs || []).forEach(b => {
    if(b.type === 'criterion'){ const m = /^C(\d+)$/.exec(b.props.cid || ''); if(m) n = Math.max(n, +m[1]); }
    if(b.children) walk(b.children);
  });
  walk(blocks);
  return 'C' + (n + 1);
}
/* A criterion with no id, or the id of one above it (a duplicated block), gets a new one. */
function fixIds(editor){
  const seen = new Set();
  const fix = [];
  const walk = bs => (bs || []).forEach(b => {
    if(b.type === 'criterion'){
      if(!b.props.cid || seen.has(b.props.cid)) fix.push(b);
      else seen.add(b.props.cid);
    }
    if(b.children) walk(b.children);
  });
  walk(editor.document);
  fix.forEach(b => editor.updateBlock(b.id, { props: { ...b.props, cid: nextId(editor.document) } }));
  return fix.length;
}

/* ── save ──────────────────────────────────────────────────────────────────── */
let editorRef = null, saveTimer = 0, applying = false;
function scheduleSave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 900);
}
async function save(){
  saveTimer = 0;
  if(!editorRef) return;
  const doc = {
    ...(state.doc || {}),
    kind: 'oracle', v: 1, name: CFG.name || document.title,
    nodes: editorRef.document,
    savedAt: new Date().toISOString(), savedBy: state.me || null,
  };
  state.saving = true; emit();
  try{ await putBoard(CRITERIA_PATH, doc); state.doc = doc; state.error = null; }
  catch(e){ state.error = 'Not saved, retrying'; saveTimer = setTimeout(save, 5000); }
  state.saving = false; emit();
}

/* ── mount ─────────────────────────────────────────────────────────────────── */
function App({ editor }){
  const getItems = async query => {
    const defaults = getDefaultReactSlashMenuItems(editor).filter(i => !/Emoji|Toggle|Image|Video|Audio|File|Code/.test(i.title));
    const add = kind => () => {
      const cur = editor.getTextCursorPosition().block;
      const block = { type: 'criterion', props: { cid: nextId(editor.document), kind }, content: [] };
      const empty = cur && !plain(cur.content);
      const placed = empty ? editor.replaceBlocks([cur.id], [block])[0] : editor.insertBlocks([block], cur.id, 'after')[0];
      const last = placed && placed[placed.length - 1];
      if(last) editor.setTextCursorPosition(last.id, 'end');
    };
    const ours = [
      { title: 'Criterion', group: 'Oracle', subtext: 'Something this prototype must keep true', aliases: ['check', 'test', 'rule', 'criteria'],
        icon: <span className="or-slash-ic">✓</span>, onItemClick: add('') },
      { title: 'Taste criterion', group: 'Oracle', subtext: 'Judged by eye, passes when you sign it off', aliases: ['taste', 'look', 'feel', 'judgement'],
        icon: <span className="or-slash-ic">◐</span>, onItemClick: add('taste') },
    ];
    return filterSuggestionItems([...ours, ...defaults], query);
  };
  return (
    <div className="or-page">
      <nav className="or-crumb"><a href="../">{CFG.prototype || 'Prototype'}</a><span>/</span><span>Oracle</span></nav>
      <div className="or-head"><h1 className="or-title">{CFG.title || 'Oracle'}</h1><About /></div>
      <Verdict editor={editor} />
      <div className="or-doc">
        <BlockNoteView editor={editor} theme="light" slashMenu={false} filePanel={false} emojiPicker={false}>
          <SuggestionMenuController triggerCharacter="/" getItems={getItems} />
        </BlockNoteView>
      </div>
    </div>
  );
}

async function start(){
  const host = document.getElementById('oracle') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'oracle' }));
  const editor = BlockNoteEditor.create({ schema, initialContent: [{ type: 'paragraph', content: [] }] });
  editorRef = editor;
  editor.onChange(() => {
    if(applying) return;
    if(fixIds(editor)) return;
    emit();
    scheduleSave();
  });
  createRoot(host).render(<App editor={editor} />);

  const load = async (first) => {
    try{
      const doc = await getBoard(CRITERIA_PATH);
      const focused = host.contains(document.activeElement);
      // Reads come through an edge cache that can hand back a copy up to a minute old, so
      // only a document saved AFTER the one on screen may replace it.
      const newer = doc && (!state.doc || String(doc.savedAt || '') > String(state.doc.savedAt || ''));
      if(doc && newer && (first || (!focused && !saveTimer))){
        state.doc = doc;
        if(Array.isArray(doc.nodes) && doc.nodes.length){
          applying = true;
          try{ editor.replaceBlocks(editor.document, doc.nodes); } finally { applying = false; }
        }
      }
      state.error = null;
    }catch(e){ state.error = 'Could not read the criteria'; }
    emit();
  };
  const results = async () => {
    try{ state.results = await getBoard(RESULTS_PATH); }catch(e){}
    emit();
  };
  fetch('/__me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(j => {
    const u = j && j.user; state.me = u ? (u.name || u.email || null) : null; emit();
  }).catch(() => {});
  await load(true);
  await results();
  const tick = () => { if(document.visibilityState === 'visible'){ results(); if(!saveTimer && !state.saving) load(false); } };
  setInterval(tick, 15000);
  addEventListener('focus', tick);
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
