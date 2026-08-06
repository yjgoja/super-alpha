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

    def peek_one(self) -> str:
        total = len(self.keywords)
        if total == 0:
            raise ValueError("키워드가 비어 있습니다.")
        cursor = int(self.state.get("cursor", 0))
        return self.keywords[cursor % total]

    def commit_one(self, keyword: str) -> None:
        """발행 성공한 키워드 1건만 커서/히스토리에 반영."""
        total = len(self.keywords)
        cursor = int(self.state.get("cursor", 0))
        expected = self.keywords[cursor % total]
        if keyword != expected:
            # 수동 지정 키워드여도 히스토리에는 기록
            self.state.setdefault("history", []).append(
                {"date": date.today().isoformat(), "keywords": [keyword], "manual": True}
            )
            self.save()
            return
        self.state["cursor"] = (cursor + 1) % total
        self.state.setdefault("history", []).append(
            {"date": date.today().isoformat(), "keywords": [keyword]}
        )
        self.save()

    def next_batch(self, n: int) -> list[str]:
        """dry-run 등에서 일괄 소진. 실제 발행은 peek_one+commit_one 권장."""
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
