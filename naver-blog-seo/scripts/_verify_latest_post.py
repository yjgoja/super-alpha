from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output"
QA = OUT / "_qa_verify"
QA.mkdir(exist_ok=True)

files = sorted(OUT.glob("*해외선물_수수료.json"))
path = files[-1]
data = json.loads(path.read_text(encoding="utf-8"))

print("FILE", path.name)
print("URL_HINT", "https://blog.naver.com/xfjma9282/224369509624")
print("TITLE", data["title"])
print("THUMB_TEXT", data["thumb_text"])
print("AI", data.get("ai"))
print("IMAGE_TOPICS", data.get("image_topics"))
print("BLOCKS", len(data["blocks"]))

types: dict[str, int] = {}
for b in data["blocks"]:
    types[b["type"]] = types.get(b["type"], 0) + 1
print("TYPES", types)

joined = "\n".join(b["text"] for b in data["blocks"])
print("CHARS_JOINED", len(joined))
print("PHRASE_OK", "이거다" in joined)
links = [b for b in data["blocks"] if b["type"] == "link"]
print("LINKS", [(b["text"], b.get("url")) for b in links])

# Fact checks
bad_pct = any(
    ("거래대금" in b["text"] and "%" in b["text"])
    or ("비율로" in b["text"] and "수수료" in b["text"] and "정액" not in b["text"])
    for b in data["blocks"]
    if b["type"] in {"paragraph", "hook", "quote"}
)
has_roundtrip = "왕복" in joined
has_fixed = "정액" in joined or "계약당" in joined
print("FACT_ROUNDTRIP", has_roundtrip)
print("FACT_FIXED_FEE", has_fixed)
print("FACT_BAD_PERCENT", bad_pct)

# URL leaked into paragraphs?
url_leak = [
    b["type"]
    for b in data["blocks"]
    if b["type"] != "link" and "http" in b["text"]
]
print("URL_LEAK_NON_LINK", url_leak)

shutil.copy2(data["thumbnail"], QA / "thumb.png")
for i, img in enumerate(data["body_images"], 1):
    shutil.copy2(img, QA / f"body_{i:02d}.png")
print("IMAGES_COPIED", 1 + len(data["body_images"]))

print("--- BLOCK PREVIEW ---")
for b in data["blocks"]:
    t = b["text"].replace("\n", " ")
    print(f"{b['type']:8s} {len(b['text']):4d} | {t[:70]}")
