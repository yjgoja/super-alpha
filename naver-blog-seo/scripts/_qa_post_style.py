"""발행글 HTML에서 노란 배경 / 가운데 정렬 존재 여부 점검."""
from __future__ import annotations

import re
import sys
import urllib.request
from collections import Counter

url = (
    sys.argv[1]
    if len(sys.argv) > 1
    else "https://blog.naver.com/PostView.naver?blogId=xfjma9282&logNo=224370029872"
)
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", errors="replace")

# style 속성 안의 background
styles = re.findall(r'style="([^"]*background[^"]*)"', html, re.I)
styles += re.findall(r"style='([^']*background[^']*)'", html, re.I)

bg_colors: list[str] = []
for s in styles:
    for m in re.finditer(r"background(?:-color)?\s*:\s*([^;]+)", s, re.I):
        bg_colors.append(m.group(1).strip().lower())

# data-color 속성
data_colors = [c.lower() for c in re.findall(r'data-color="([^"]+)"', html, re.I)]

yellow_keys = (
    "fff2cc",
    "ffe599",
    "ffff00",
    "ffeb3b",
    "ffee58",
    "fff176",
    "ffff99",
    "ffd966",
    "255, 235",
    "255,242",
    "255, 229",
    "255,255,0",
    "255, 255, 0",
)


def is_yellow(v: str) -> bool:
    s = v.replace(" ", "")
    if any(k.replace(" ", "") in s for k in yellow_keys):
        return True
    m = re.search(r"rgb\((\d+),(\d+),(\d+)\)", s)
    if not m:
        return False
    r, g, b = map(int, m.groups())
    return r >= 220 and g >= 190 and b <= 170 and abs(r - g) < 80


def is_gray(v: str) -> bool:
    s = v.replace(" ", "")
    m = re.search(r"rgb\((\d+),(\d+),(\d+)\)", s)
    if m:
        r, g, b = map(int, m.groups())
        return abs(r - g) < 12 and abs(g - b) < 12 and 80 <= r <= 230
    return bool(re.search(r"#(?:ccc|eee|ddd|999|bbb|f3f3f3|e0e0e0|efefef)", s))


yellow_n = sum(1 for c in bg_colors if is_yellow(c))
gray_n = sum(1 for c in bg_colors if is_gray(c))
aligns = Counter(re.findall(r"text-align:\s*(center|left|right)", html, re.I))

title = re.search(r"<title>(.*?)</title>", html, re.I | re.S)
print("URL", url)
print("TITLE", (title.group(1).strip() if title else "")[:80])
print("BG_COLOR_TOP", Counter(bg_colors).most_common(15))
print("YELLOW_BG", yellow_n)
print("GRAY_BG", gray_n)
print("ALIGNS", dict(aligns))
print("DATA_COLOR_SAMPLE", Counter(data_colors).most_common(10))
print("OK_YELLOW", yellow_n > 0)
print("OK_CENTER", aligns.get("center", 0) > 0)
print("OK_NO_GRAY_HIGHLIGHT", gray_n == 0 or yellow_n >= gray_n)
