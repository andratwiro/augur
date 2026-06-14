import sys
from playwright.sync_api import sync_playwright

URL = "https://wietsedemo.govocal.com/en/projects/master-survey-redesigning-coffman-park-1/surveys/new?phase_id=3a3fd1e1-c17f-4a68-ad48-0eb5c17d6596"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    schema_hits = []
    def on_resp(r):
        u = r.url
        if any(k in u for k in ["custom_fields", "/surveys", "form", "phases", "graphql"]):
            schema_hits.append(f"{r.status}  {u}")
    page.on("response", on_resp)
    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2500)
    print("FINAL URL:", page.url)
    print("TITLE:", page.title())
    # is there a login wall?
    body_text = page.locator("body").inner_text()[:600]
    print("--- BODY TEXT (first 600) ---")
    print(body_text)
    print("--- NETWORK (form-ish responses) ---")
    for h in schema_hits[:40]:
        print(h)
    page.screenshot(path="/tmp/recon-form.png", full_page=True)
    print("--- screenshot: /tmp/recon-form.png ---")
    browser.close()
