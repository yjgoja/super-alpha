from __future__ import annotations

import base64
import os
from pathlib import Path
from urllib.request import urlopen

from dotenv import load_dotenv
from openai import OpenAI

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env", override=True)
# Release .env fallback
rel = ROOT / "dist" / "NaverBlogSEO_Release" / ".env"
if rel.exists():
    load_dotenv(rel, override=False)

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
prompt = (
    "Korean blog thumbnail. Flat modern finance chart background. "
    'Large bold clear Korean Hangul text centered: "수수료 왕복으로 보라". '
    'Smaller Korean text below: "해외선물 수수료". '
    "High contrast, perfectly readable Hangul syllables. "
    "NO people, NO faces. Icons and charts only."
)
print("generating gpt-image-2 medium...")
r = client.images.generate(
    model="gpt-image-2",
    prompt=prompt,
    size="1536x1024",
    n=1,
    quality="medium",
)
item = r.data[0]
out = ROOT / "output" / "_qa_thumb_image2.png"
b64 = getattr(item, "b64_json", None)
if b64:
    out.write_bytes(base64.b64decode(b64))
else:
    with urlopen(item.url, timeout=180) as resp:  # noqa: S310
        out.write_bytes(resp.read())
print("saved", out, out.stat().st_size)
