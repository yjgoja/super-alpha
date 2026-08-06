from __future__ import annotations

import json
from pathlib import Path

TRANSCRIPT_DIR = Path(r"C:\Users\yjgoj\.cursor\projects\d-ea-web\agent-transcripts")
OUT_ROOT = Path(r"D:\ea자동매매\web\naver-blog-seo")


def walk(obj, last: dict[str, str]) -> None:
    if isinstance(obj, dict):
        name = str(obj.get("name") or obj.get("toolName") or "")
        if name in {"Write", "write"}:
            inp = obj.get("input") or obj.get("arguments") or obj.get("params") or {}
            if isinstance(inp, str):
                try:
                    inp = json.loads(inp)
                except Exception:
                    inp = {}
            path = inp.get("path") or inp.get("file_path")
            contents = inp.get("contents") or inp.get("content")
            if path and isinstance(contents, str) and "naver-blog-seo" in str(path).replace("\\", "/"):
                last[str(Path(path))] = contents
        for v in obj.values():
            walk(v, last)
    elif isinstance(obj, list):
        for v in obj:
            walk(v, last)


def main() -> None:
    last: dict[str, str] = {}
    files = sorted(TRANSCRIPT_DIR.rglob("*.jsonl"))
    print("transcripts", len(files))
    for tp in files:
        with tp.open(encoding="utf-8", errors="ignore") as f:
            for line in f:
                try:
                    walk(json.loads(line), last)
                except Exception:
                    continue

    print("recovered", len(last))
    for path_str, contents in sorted(last.items()):
        src = Path(path_str)
        # normalize into project
        parts = list(src.parts)
        if "naver-blog-seo" not in parts:
            continue
        idx = parts.index("naver-blog-seo")
        rel = Path(*parts[idx + 1 :])
        dest = OUT_ROOT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(contents, encoding="utf-8")
        print("WROTE", dest, "bytes", len(contents.encode("utf-8")))


if __name__ == "__main__":
    main()
