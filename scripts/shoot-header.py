from playwright.sync_api import sync_playwright
import os, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = pathlib.Path("/tmp/hdr")
OUT.mkdir(exist_ok=True)

shots = [
    ("project-page", "pages/project-page/index.html", None, False),
    ("project-page-dd", "pages/project-page/index.html", None, True),
    ("homepage-wien", "pages/homepage/index.html", "2", False),
    ("header-comp", "components/header-nav/index.html", None, False),
]

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    for name, rel, theme, open_dd in shots:
        url = (ROOT / rel).as_uri()
        if theme:
            url += f"?theme={theme}"
        pg = b.new_page(viewport={"width": 1280, "height": 820}, device_scale_factor=2)
        pg.goto(url)
        pg.wait_for_load_state("networkidle")
        if open_dd:
            # open the first nav dropdown ("All projects")
            try:
                pg.locator("details.gv-nav__dd > summary").first.click()
                pg.wait_for_timeout(250)
            except Exception as e:
                print("dd open failed", e)
        pg.wait_for_timeout(200)
        # crop to the top chrome region
        pg.screenshot(path=str(OUT / f"{name}.png"), clip={"x": 0, "y": 0, "width": 1280, "height": 360})
        print("shot", name)
        pg.close()
    b.close()
print("done ->", OUT)
