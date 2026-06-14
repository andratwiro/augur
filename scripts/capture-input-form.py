"""Walk the GoVocal kitchen-sink survey page-by-page. At each page: capture EMPTY
state + rendered DOM, best-effort fill every control (to reveal selected/filled
states), capture FILLED state, then advance via Next. Stops at the Submit page
WITHOUT submitting (no fake response on the tenant). Internal capture — never ships."""
import os, re, json
from playwright.sync_api import sync_playwright

URL = "https://wietsedemo.govocal.com/en/projects/master-survey-redesigning-coffman-park-1/surveys/new?phase_id=3a3fd1e1-c17f-4a68-ad48-0eb5c17d6596"
OUT = "references/pages/input-form/walk"
VIEWPORTS = {"mobile": (390, 844), "desktop": (1280, 900)}
MAX_STEPS = 14

def accept_cookies(pg):
    try:
        b = pg.get_by_role("button", name=re.compile(r"^\s*Accept", re.I))
        if b.count(): b.first.click(timeout=2500); pg.wait_for_timeout(400)
    except Exception: pass

def heading(pg):
    for sel in ["main h1", "main h2", "form h1", "form h2"]:
        try:
            el = pg.locator(sel).first
            if el.count() and el.is_visible():
                t = el.inner_text().strip()
                if t: return t
        except Exception: pass
    return ""

def adv_button(pg):
    """The page-advance submit button (Next / Submit)."""
    b = pg.locator("button[type=submit]").filter(has_text=re.compile(r"Next|Submit|Send|Finish", re.I)).last
    return b if b.count() else None

def best_effort_fill(pg):
    form = pg.locator("form").first
    # radio cards / scales / matrix: force-click the first container of each radiogroup
    # (name-group). force=True bypasses the styled overlay divs that intercept clicks.
    # This satisfies the gate fields (rating-like): linear_scale, sentiment, matrix rows.
    try:
        radios = form.locator("input[type=radio]").all()
        seen = set()
        for r in radios:
            nm = r.get_attribute("name") or ""
            if nm in seen: continue
            seen.add(nm)
            try:
                card = r.locator("xpath=ancestor::*[@data-testid='radio-container'][1]")
                tgt = card.first if card.count() else r
                tgt.scroll_into_view_if_needed(timeout=500)
                tgt.click(timeout=700, force=True)
            except Exception:
                try: r.check(timeout=500, force=True)
                except Exception: pass
    except Exception: pass
    # checkboxes (multiselect): first one
    try:
        cb = form.locator("input[type=checkbox]").first
        if cb.count():
            card = cb.locator("xpath=ancestor::*[@data-testid][1]")
            (card if card.count() else cb).click(timeout=800, force=True)
    except Exception: pass
    # text / number / textarea
    try:
        for t in form.locator("input[type=text], input:not([type])").all():
            try: t.fill("Sample answer", timeout=700)
            except Exception: pass
        for ta in form.locator("textarea").all():
            try: ta.fill("This is sample feedback captured for the component library.", timeout=700)
            except Exception: pass
        for n in form.locator("input[type=number]").all():
            try: n.fill("2", timeout=700)
            except Exception: pass
    except Exception: pass
    # rating: click an option (this is the gate on rating pages)
    try:
        ro = form.locator("[data-testid='ratingControl'] [id*='rating-input-option']").all()
        if ro: ro[len(ro)-1].click(timeout=800, force=True)
    except Exception: pass
    # linear_scale / sentiment_linear_scale / matrix: click visible role=radio targets
    try:
        rad = form.locator("[role='radio']").all()
        seen = set()
        for e in rad:
            try:
                key = e.get_attribute("name") or e.get_attribute("aria-labelledby") or ""
                if key in seen: continue
                seen.add(key)
                if e.is_visible(): e.click(timeout=500, force=True)
            except Exception: pass
    except Exception: pass
    # multiselect_image: click first image option card
    try:
        img = form.locator("img").first
        if img.count():
            card = img.locator("xpath=ancestor::button[1] | ancestor::*[@role='checkbox'][1] | ancestor::label[1]")
            if card.count(): card.first.click(timeout=700, force=True)
    except Exception: pass
    pg.wait_for_timeout(700)

def force_next(pg):
    pg.evaluate("""() => {
      const b=[...document.querySelectorAll('button[type=submit]')].filter(x=>/Next/i.test(x.textContent)).pop();
      if(b){ b.removeAttribute('disabled'); b.setAttribute('aria-disabled','false'); b.classList.remove('disabled'); b.click(); }
    }""")

def advance(pg, prev_title):
    """Force Next, retrying a few times until the heading changes."""
    for _ in range(4):
        force_next(pg)
        pg.wait_for_timeout(1500)
        if heading(pg) != prev_title:
            return True
    return False

def walk(vp, w, h, save_dom):
    with sync_playwright() as p:
        br = p.chromium.launch(headless=True)
        ctx = br.new_context(viewport={"width": w, "height": h}, device_scale_factor=2)
        pg = ctx.new_page()
        pg.goto(URL, wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(2000); accept_cookies(pg); pg.wait_for_timeout(800)
        steps = []; last = None
        for i in range(MAX_STEPS):
            pg.wait_for_timeout(1700)
            title = heading(pg)
            if title and title == last:
                print(f"[{vp}] heading didn't change ('{title[:30]}') — stop"); break
            last = title
            d = f"{OUT}/page-{i:02d}"; os.makedirs(d, exist_ok=True)
            pg.screenshot(path=f"{d}/{vp}-empty.png", full_page=True)
            if save_dom:
                open(f"{d}/dom.html","w").write(pg.content())
                try:
                    f = pg.locator("form").first
                    if f.count(): open(f"{d}/form.html","w").write(f.inner_html())
                except Exception: pass
            btn = adv_button(pg)
            label = (btn.inner_text().strip().lower() if btn else "")
            steps.append({"i": i, "title": title, "button": label})
            print(f"[{vp}] {i:02d}  «{title[:50]}»  btn={label or '—'}")
            if (not btn) or ("submit" in label) or ("send" in label) or ("finish" in label):
                # final page — capture, DO NOT submit
                best_effort_fill(pg)
                pg.screenshot(path=f"{d}/{vp}-filled.png", full_page=True)
                print(f"[{vp}] final page reached — not submitting. end"); break
            best_effort_fill(pg)
            pg.screenshot(path=f"{d}/{vp}-filled.png", full_page=True)
            if not advance(pg, title):
                print(f"[{vp}] could not advance past «{title[:30]}» — stop"); break
        if save_dom: json.dump(steps, open(f"{OUT}/steps.json","w"), indent=2)
        br.close()
        return steps

import sys
os.makedirs(OUT, exist_ok=True)
target = sys.argv[1] if len(sys.argv) > 1 else "both"
if target in ("both", "desktop"):
    walk("desktop", *VIEWPORTS["desktop"], save_dom=True)
if target in ("both", "mobile"):
    walk("mobile", *VIEWPORTS["mobile"], save_dom=False)
print("done ->", OUT)
