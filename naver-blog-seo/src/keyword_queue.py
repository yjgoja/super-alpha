from __future__ import annotations

import json
from datetime import date
from pathlib import Path


class KeywordQueue:
    """키워드를 하루 N개씩 소진하고, 끝나면 순환한다."""

    def __init__(self, keywords: list[str], state_path: Path):
        self.keywords = keywords
        self.state_path = state_path
        self.state = self._load()

    def _load(self) -> dict:
        if self.state_path.exists():
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        return {"cursor": 0, "history": []}

    def save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            json.dumps(self.state, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def next_batch(self, n: int) -> list[str]:
        batch: list[str] = []
        cursor = int(self.state.get("cursor", 0))
        total = len(self.keywords)
        for _ in range(n):
            batch.append(self.keywords[cursor % total])
            cursor += 1
        self.state["cursor"] = cursor % total
        self.state.setdefault("history", []).append(
            {"date": date.today().isoformat(), "keywords": batch}
        )
        self.save()
        return batch
