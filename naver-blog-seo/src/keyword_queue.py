from __future__ import annotations

import json
from datetime import date
from pathlib import Path


class KeywordQueue:
    """키워드를 하루 N개씩 소진하고, 끝나면 순환한다. 하루 상한 강제."""

    def __init__(self, keywords: list[str], state_path: Path):
        self.keywords = keywords
        self.state_path = state_path
        self.state = self._load()

    def _load(self) -> dict:
        if self.state_path.exists():
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        return {"cursor": 0, "history": [], "daily": {}}

    def save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            json.dumps(self.state, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _today(self) -> str:
        return date.today().isoformat()

    def posted_today(self) -> int:
        daily = self.state.setdefault("daily", {})
        today = self._today()
        n = int(daily.get(today, 0) or 0)
        if n == 0:
            for h in self.state.get("history") or []:
                if h.get("date") == today:
                    n += len(h.get("keywords") or [])
        return n

    def remaining_today(self, limit: int) -> int:
        return max(0, int(limit) - self.posted_today())

    def peek_one(self) -> str:
        total = len(self.keywords)
        if total == 0:
            raise ValueError("키워드가 비어 있습니다.")
        cursor = int(self.state.get("cursor", 0))
        return self.keywords[cursor % total]

    def commit_one(self, keyword: str, *, advance_cursor: bool = True) -> None:
        total = len(self.keywords)
        cursor = int(self.state.get("cursor", 0))
        today = self._today()
        expected = self.keywords[cursor % total] if total else None
        manual = keyword != expected

        if advance_cursor and not manual and total:
            self.state["cursor"] = (cursor + 1) % total

        self.state.setdefault("history", []).append(
            {
                "date": today,
                "keywords": [keyword],
                **({"manual": True} if manual else {}),
            }
        )
        daily = self.state.setdefault("daily", {})
        daily[today] = int(daily.get(today, 0) or 0) + 1
        if len(daily) > 20:
            keep = sorted(daily.keys())[-14:]
            self.state["daily"] = {k: daily[k] for k in keep}
        self.save()

    def next_batch(self, n: int) -> list[str]:
        batch: list[str] = []
        cursor = int(self.state.get("cursor", 0))
        total = len(self.keywords)
        for _ in range(n):
            batch.append(self.keywords[cursor % total])
            cursor += 1
        self.state["cursor"] = cursor % total
        self.state.setdefault("history", []).append(
            {"date": self._today(), "keywords": batch}
        )
        self.save()
        return batch
