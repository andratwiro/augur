"""Render my rebuilt pages/input-form/ and walk it page-by-page, screenshotting each
step at desktop + mobile, into /tmp/sv/ for side-by-side review vs the real capture."""
import os, pathlib
from playwright.sync_api import sync_playwright
URL = pathlib.Path("pages/input-form/index.html").resolve().as_uri()
OUT = "/tmp/sv"; os.makedirs(OUT, exist_ok=True)

def click_each(page, selector):
    for el in page.locator(selector).all():
        try:
            if el.is_visible(): el.click(force=True, timeout=500)
        except Exception: pass

def fill_gates(page):
    # Click VISIBLE labels (the hidden zero-size inputs aren't clickable).
    # rating: pick the 4th star; scale: pick a middle button; sentiment: pick a face.
    for box in page.locator(".sv-rating").all():
        try: box.locator("label").nth(3).click(force=True, timeout=500)
        except Exception: pass
    for box in page.locator(".sv-scale").all():  # also covers mobile matrix mini-scales
        try: box.locator("label").nth(2).click(force=True, timeout=500)
        except Exception: pass
    for box in page.locator(".sv-sentiment").all():
        try: box.locator("label").nth(3).click(force=True, timeout=500)
        except Exception: pass
    # matrix desktop: click the "Agree" cell (index 3) in each visible row
    for row in page.locator(".sv-matrix tbody tr").all():
        try:
            lbl = row.locator("td label").nth(3)
            if lbl.is_visible(): lbl.click(force=True, timeout=500)
        except Exception: pass
    # a couple of normal answers for realism
    try:
        c = page.locator(".sv-optcard").first
        if c.is_visible(): c.click(force=True, timeout=500)
    except Exception: pass
    page.wait_for_timeout(150)

def walk(vp,w,h):
    with sync_playwright() as p:
        br=p.chromium.launch(headless=True)
        pg=br.new_context(viewport={"width":w,"height":h}, device_scale_factor=2).new_page()
        pg.goto(URL); pg.wait_for_timeout(800)
        for i in range(11):
            pg.wait_for_timeout(250)
            pg.screenshot(path=f"{OUT}/{vp}-{i:02d}.png", full_page=True)
            nxt=pg.locator(".sv-next")
            if nxt.count()==0 or not nxt.is_visible(): break
            fill_gates(pg); pg.wait_for_timeout(150)
            if nxt.get_attribute("aria-disabled")=="true":
                print(f"[{vp}] {i:02d} Next still disabled");
            try: nxt.click(timeout=2000)
            except Exception as e: print(f"[{vp}] {i} click fail {e}"); break
        print(f"[{vp}] done")
        br.close()

walk("desktop",1280,900)
walk("mobile",390,844)
print("->",OUT)
