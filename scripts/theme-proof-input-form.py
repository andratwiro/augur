"""Render the input-form at two themes and capture the component-heavy pages, to prove
every field component re-skins from --gv-* variables (no hardcoded brand colour)."""
import os, pathlib
from playwright.sync_api import sync_playwright
BASE = pathlib.Path("pages/input-form/index.html").resolve().as_uri()
OUT="/tmp/svtheme"; os.makedirs(OUT, exist_ok=True)

def fill(page):
    for box in page.locator(".sv-rating").all():
        try: box.locator("label").nth(3).click(force=True, timeout=400)
        except Exception: pass
    for box in page.locator(".sv-scale").all():
        try: box.locator("label").nth(2).click(force=True, timeout=400)
        except Exception: pass
    for box in page.locator(".sv-sentiment").all():
        try: box.locator("label").nth(1).click(force=True, timeout=400)
        except Exception: pass
    for row in page.locator(".sv-matrix tbody tr").all():
        try:
            l=row.locator("td label").nth(3)
            if l.is_visible(): l.click(force=True, timeout=400)
        except Exception: pass
    for c in page.locator(".sv-optcard").all()[:2]:
        try:
            if c.is_visible(): c.click(force=True, timeout=400)
        except Exception: pass
    for c in page.locator(".sv-imgcard").all()[:1]:
        try: c.click(force=True, timeout=400)
        except Exception: pass
    page.wait_for_timeout(120)

def run(theme):
    with sync_playwright() as p:
        br=p.chromium.launch(headless=True)
        pg=br.new_context(viewport={"width":900,"height":900}, device_scale_factor=2).new_page()
        pg.goto(f"{BASE}?theme={theme}"); pg.wait_for_timeout(700)
        for i in range(9):
            fill(pg); pg.wait_for_timeout(120)
            if i in (2,3,4):
                pg.screenshot(path=f"{OUT}/t{theme}-p{i}.png", full_page=True)
            nb=pg.locator("#sv-next")
            if nb.get_attribute("aria-disabled")=="true": fill(pg)
            try: nb.click(timeout=1500)
            except Exception: break
        br.close()
    print("theme",theme,"done")

for t in (0,3):
    run(t)
print("->",OUT)
