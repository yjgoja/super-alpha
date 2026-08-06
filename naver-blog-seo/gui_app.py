from __future__ import annotations

import os
import queue
import threading
import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk

from src.ai_openai import FOOTER_LINK
from src.config_loader import load_config, save_config_yaml, save_env
from src.paths import app_root, ensure_runtime_files
from src.poster import run_dry_batch, run_live_batch
from src.scheduler import start_daily_scheduler


class NaverBlogApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("네이버 블로그 SEO 자동 포스팅 (ChatGPT)")
        self.geometry("860x780")
        self.minsize(800, 700)

        self.root_dir = ensure_runtime_files()
        self.log_q: queue.Queue[str] = queue.Queue()
        self.pause_event = threading.Event()
        self.pause_message = tk.StringVar(value="")
        self.worker: threading.Thread | None = None
        self._build()
        self._load_into_form()
        self.after(200, self._drain_logs)

    def _build(self) -> None:
        pad = {"padx": 10, "pady": 6}
        frm = ttk.Frame(self)
        frm.pack(fill="both", expand=True, **pad)

        ai = ttk.LabelFrame(frm, text="ChatGPT / OpenAI API")
        ai.pack(fill="x", **pad)
        self.api_var = tk.StringVar()
        ttk.Label(ai, text="API Key").grid(row=0, column=0, sticky="w", padx=8, pady=4)
        ttk.Entry(ai, textvariable=self.api_var, show="*", width=58).grid(
            row=0, column=1, sticky="we", padx=8, pady=4
        )
        ttk.Label(ai, text="글·이미지 모두 OpenAI로 생성 (정보성 글 + DALL·E)").grid(
            row=1, column=1, sticky="w", padx=8, pady=(0, 6)
        )
        ai.columnconfigure(1, weight=1)

        cred = ttk.LabelFrame(frm, text="네이버 계정")
        cred.pack(fill="x", **pad)
        self.id_var = tk.StringVar()
        self.pw_var = tk.StringVar()
        self.auto_var = tk.BooleanVar(value=False)
        ttk.Label(cred, text="아이디").grid(row=0, column=0, sticky="w", padx=8, pady=4)
        ttk.Entry(cred, textvariable=self.id_var, width=36).grid(row=0, column=1, sticky="we", padx=8, pady=4)
        ttk.Label(cred, text="비밀번호").grid(row=1, column=0, sticky="w", padx=8, pady=4)
        ttk.Entry(cred, textvariable=self.pw_var, show="*", width=36).grid(
            row=1, column=1, sticky="we", padx=8, pady=4
        )
        ttk.Checkbutton(
            cred,
            text="자동 발행 (비권장 / 기본은 수동 검수)",
            variable=self.auto_var,
        ).grid(row=0, column=2, rowspan=2, padx=12)

        conf = ttk.LabelFrame(frm, text="SEO 설정")
        conf.pack(fill="both", expand=False, **pad)

        ttk.Label(conf, text="키워드 (줄바꿈)").grid(row=0, column=0, sticky="nw", padx=8, pady=4)
        self.keywords_txt = scrolledtext.ScrolledText(conf, height=5, width=40)
        self.keywords_txt.grid(row=0, column=1, columnspan=3, sticky="we", padx=8, pady=4)

        ttk.Label(conf, text="필수 문구").grid(row=1, column=0, sticky="w", padx=8, pady=4)
        self.phrases_var = tk.StringVar(value="이거다")
        ttk.Entry(conf, textvariable=self.phrases_var, width=40).grid(
            row=1, column=1, sticky="we", padx=8, pady=4
        )

        ttk.Label(conf, text="필수 하단 링크").grid(row=2, column=0, sticky="w", padx=8, pady=4)
        self.link_var = tk.StringVar(value=FOOTER_LINK)
        ttk.Entry(conf, textvariable=self.link_var, width=40).grid(
            row=2, column=1, columnspan=3, sticky="we", padx=8, pady=4
        )

        ttk.Label(conf, text="하루 개수").grid(row=3, column=0, sticky="w", padx=8, pady=4)
        self.count_var = tk.IntVar(value=4)
        ttk.Spinbox(conf, from_=1, to=20, textvariable=self.count_var, width=8).grid(
            row=3, column=1, sticky="w", padx=8, pady=4
        )

        ttk.Label(conf, text="본문 이미지 수").grid(row=3, column=2, sticky="w", padx=8, pady=4)
        self.img_var = tk.IntVar(value=8)
        ttk.Spinbox(conf, from_=1, to=20, textvariable=self.img_var, width=8).grid(
            row=3, column=3, sticky="w", padx=8, pady=4
        )

        ttk.Label(conf, text="발행 시각(쉼표)").grid(row=4, column=0, sticky="w", padx=8, pady=4)
        self.times_var = tk.StringVar(value="09:30,12:30,15:30,19:00")
        ttk.Entry(conf, textvariable=self.times_var, width=40).grid(
            row=4, column=1, columnspan=3, sticky="we", padx=8, pady=4
        )

        ttk.Label(conf, text="브랜드명").grid(row=5, column=0, sticky="w", padx=8, pady=4)
        self.brand_var = tk.StringVar(value="올브릿지 노트")
        ttk.Entry(conf, textvariable=self.brand_var, width=40).grid(
            row=5, column=1, columnspan=3, sticky="we", padx=8, pady=4
        )

        btns = ttk.Frame(frm)
        btns.pack(fill="x", **pad)
        ttk.Button(btns, text="설정 저장", command=self.save_settings).pack(side="left", padx=4)
        ttk.Button(btns, text="미리보기 생성 (AI)", command=lambda: self.start_job("dry")).pack(
            side="left", padx=4
        )
        ttk.Button(btns, text="지금 바로 작성", command=lambda: self.start_job("once")).pack(
            side="left", padx=4
        )
        ttk.Button(btns, text="하루 스케줄 시작", command=lambda: self.start_job("schedule")).pack(
            side="left", padx=4
        )
        ttk.Button(btns, text="폴더 열기", command=self.open_folder).pack(side="right", padx=4)

        pause_bar = ttk.Frame(frm)
        pause_bar.pack(fill="x", **pad)
        ttk.Label(pause_bar, textvariable=self.pause_message, foreground="#0b57d0").pack(
            side="left", padx=4
        )
        ttk.Button(pause_bar, text="계속 / 확인", command=self.resume_pause).pack(side="right", padx=4)

        logf = ttk.LabelFrame(frm, text="실행 로그")
        logf.pack(fill="both", expand=True, **pad)
        self.log_txt = scrolledtext.ScrolledText(logf, height=14, state="disabled")
        self.log_txt.pack(fill="both", expand=True, padx=8, pady=8)

        ttk.Label(
            frm,
            text=f"데이터 폴더: {self.root_dir}  |  글 하단 필수 링크: {FOOTER_LINK}",
            foreground="#555",
        ).pack(anchor="w", padx=10)

    def _load_into_form(self) -> None:
        env = self.root_dir / ".env"
        if env.exists():
            for line in env.read_text(encoding="utf-8").splitlines():
                if "=" not in line or line.strip().startswith("#"):
                    continue
                k, v = line.split("=", 1)
                key = k.strip()
                val = v.strip()
                if key == "NAVER_ID":
                    self.id_var.set(val)
                elif key == "NAVER_PW":
                    self.pw_var.set(val)
                elif key == "OPENAI_API_KEY":
                    self.api_var.set(val)
                elif key == "AUTO_PUBLISH":
                    self.auto_var.set(val.lower() in {"1", "true", "yes", "y"})
        try:
            cfg = load_config(require_credentials=False, require_openai=False)
            self.keywords_txt.delete("1.0", "end")
            self.keywords_txt.insert("1.0", "\n".join(cfg.keywords))
            self.phrases_var.set(", ".join(cfg.required_phrases))
            self.link_var.set(cfg.footer_link)
            self.count_var.set(cfg.posts_per_day)
            self.img_var.set(cfg.body_image_count)
            self.times_var.set(",".join(cfg.post_times))
            self.brand_var.set(str(cfg.content.get("brand_name", "올브릿지 노트")))
        except Exception as e:
            self._append_log(f"설정 로드 경고: {e}")

    def save_settings(self) -> bool:
        keywords = [x.strip() for x in self.keywords_txt.get("1.0", "end").splitlines() if x.strip()]
        phrases = [x.strip() for x in self.phrases_var.get().replace("，", ",").split(",") if x.strip()]
        times = [x.strip() for x in self.times_var.get().replace("，", ",").split(",") if x.strip()]
        link = self.link_var.get().strip() or FOOTER_LINK
        if not keywords:
            messagebox.showerror("오류", "키워드를 1개 이상 입력하세요.")
            return False
        if not phrases:
            messagebox.showerror("오류", "필수 문구를 입력하세요.")
            return False
        if not self.api_var.get().strip():
            messagebox.showerror("오류", "ChatGPT API 키를 입력하세요.")
            return False
        save_env(
            self.id_var.get().strip(),
            self.pw_var.get().strip(),
            openai_api_key=self.api_var.get().strip(),
            auto_publish=bool(self.auto_var.get()),
            headless=False,
        )
        save_config_yaml(
            keywords=keywords,
            required_phrases=phrases,
            posts_per_day=int(self.count_var.get()),
            post_times=times or ["00:00"],
            body_image_count=int(self.img_var.get()),
            brand_name=self.brand_var.get().strip() or "올브릿지 노트",
            footer_link=link,
        )
        self._append_log("설정 저장 완료")
        return True

    def open_folder(self) -> None:
        os.startfile(str(app_root()))  # noqa: S606

    def _append_log(self, msg: str) -> None:
        self.log_txt.configure(state="normal")
        self.log_txt.insert("end", msg + "\n")
        self.log_txt.see("end")
        self.log_txt.configure(state="disabled")

    def _drain_logs(self) -> None:
        while True:
            try:
                msg = self.log_q.get_nowait()
            except queue.Empty:
                break
            self._append_log(msg)
        self.after(200, self._drain_logs)

    def log(self, msg: str) -> None:
        self.log_q.put(msg)

    def pause(self, msg: str) -> None:
        self.pause_event.clear()
        self.pause_message.set(msg)
        self.log(msg)
        self.pause_event.wait()
        self.pause_message.set("")

    def resume_pause(self) -> None:
        self.pause_event.set()

    def start_job(self, mode: str) -> None:
        if self.worker and self.worker.is_alive():
            messagebox.showwarning("진행 중", "이미 작업이 실행 중입니다.")
            return
        if not self.save_settings():
            return
        self.worker = threading.Thread(target=self._run, args=(mode,), daemon=True)
        self.worker.start()

    def _run(self, mode: str) -> None:
        try:
            need_creds = mode != "dry"
            cfg = load_config(require_credentials=need_creds, require_openai=True)
            if mode == "dry":
                results = run_dry_batch(cfg, log=self.log)
                ok = all(
                    r["required_ok"] and r["body_images"] >= cfg.body_image_count and r["footer_link_ok"]
                    for r in results
                )
                self.log(f"미리보기 완료: {'OK' if ok else 'FAIL'} ({len(results)}건)")
            elif mode == "once":
                run_live_batch(cfg, log=self.log, pause=self.pause)
                self.log("작성 작업 종료")
            elif mode == "schedule":
                self.log("스케줄 모드 시작 (창을 닫으면 중지됩니다)")
                for t in cfg.post_times[: cfg.posts_per_day]:
                    self.log(f"예약 시각: 매일 {t}")
                start_daily_scheduler(cfg, log=self.log, pause=self.pause)
        except Exception as e:
            self.log(f"[ERROR] {e}")


def main() -> None:
    ensure_runtime_files()
    app = NaverBlogApp()
    app.mainloop()


if __name__ == "__main__":
    main()
