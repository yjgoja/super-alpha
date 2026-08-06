import json
from pathlib import Path

p = Path(
    r"C:\Users\yjgoj\.cursor\projects\d-ea-web\agent-transcripts"
    r"\82a93be1-67e9-4110-bc3d-8483d49d702a\82a93be1-67e9-4110-bc3d-8483d49d702a.jsonl"
)
out = Path(r"D:\ea자동매매\web\naver-blog-seo\scripts\_editor_patches")
out.mkdir(parents=True, exist_ok=True)
hits = []
n = 0
for i, line in enumerate(p.open(encoding="utf-8")):
    if "editor.py" not in line:
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    content = obj.get("message", {}).get("content")
    if not isinstance(content, list):
        continue
    for c in content:
        if c.get("type") != "tool_use" or c.get("name") not in ("Write", "StrReplace"):
            continue
        inp = c.get("input", {})
        path = str(inp.get("path", ""))
        if "editor.py" not in path.replace("\\", "/"):
            continue
        ns = inp.get("new_string") or inp.get("contents") or ""
        if not ns:
            continue
        n += 1
        fname = out / f"{i:05d}_{n:02d}_{c['name']}_len{len(ns)}.txt"
        fname.write_text(ns, encoding="utf-8")
        preview = ns[:120].replace("\n", " | ")
        hits.append((i, c["name"], len(ns), fname.name, preview))
print("hits", len(hits))
for h in hits:
    print(h[0], h[1], "len", h[2], h[3])
    print(" ", h[4])
