/** Client-side PNL share card — 16:9 hologram plate + Super Alpha logo */

export type SharePnlPayload = {
  returnPct: number;
  pnlUsd: number;
  /** Optional; defaults to now when rendering */
  at?: Date;
};

export function fmtUsd(n: number) {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtPct(n: number) {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

/** 2026년 7월 22일  01:09 */
export function fmtShareDateTime(d: Date) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}년 ${m}월 ${day}일  ${hh}:${mm}`;
}

const W = 1920;
const H = 1080; // 16:9

const FONT_EN = "Manrope, system-ui, sans-serif";
const FONT_KR = "Pretendard, Malgun Gothic, sans-serif";

let bgCache: HTMLImageElement | null = null;
let logoCache: HTMLImageElement | null = null;
let fontsReady: Promise<void> | null = null;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`이미지 로드 실패: ${src}`));
    img.src = src;
  });
}

async function getAssets() {
  if (!bgCache) bgCache = await loadImage("/share/bg-hologram.png");
  if (!logoCache) logoCache = await loadImage("/brand/sa-logo.png");
  return { bg: bgCache, logo: logoCache };
}

async function ensureFonts() {
  if (typeof document === "undefined") return;
  if (!fontsReady) {
    fontsReady = (async () => {
      try {
        if (typeof FontFace !== "undefined") {
          const face = new FontFace(
            "Pretendard",
            "url(/fonts/Pretendard-Bold.ttf)",
            { weight: "700", style: "normal", display: "swap" },
          );
          const loaded = await face.load();
          document.fonts.add(loaded);
        }
      } catch {
        /* fall back */
      }
      try {
        await document.fonts.ready;
        await Promise.all([
          document.fonts.load(`700 48px ${FONT_KR}`),
          document.fonts.load(`700 68px ${FONT_KR}`),
          document.fonts.load(`700 72px ${FONT_EN}`),
          document.fonts.load(`800 300px ${FONT_EN}`),
        ]);
      } catch {
        /* fall back to system */
      }
    })();
  }
  await fontsReady;
}

/**
 * Render Super Alpha share card → PNG blob (1920×1080, 16:9).
 * Layout A2b + Pretendard KR + 한글 일시(좌하단).
 */
export async function renderSharePnlPng(payload: SharePnlPayload): Promise<Blob> {
  await ensureFonts();
  const { bg, logo } = await getAssets();

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas를 사용할 수 없습니다.");

  const isUp =
    payload.returnPct > 0 || (payload.returnPct === 0 && payload.pnlUsd >= 0);
  const accent = isUp ? "#5ddea5" : "#ff6b7a";
  const at = payload.at ?? new Date();

  // Background plate
  ctx.drawImage(bg, 0, 0, W, H);

  // Left readability veil (stronger for big type)
  const veil = ctx.createLinearGradient(0, 0, W * 0.72, 0);
  veil.addColorStop(0, "rgba(0,0,0,0.68)");
  veil.addColorStop(0.55, "rgba(0,0,0,0.32)");
  veil.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, W, H);

  // Brand row
  const logoH = 140;
  const logoW = (logo.width / logo.height) * logoH;
  const brandX = 56;
  const brandY = 48;
  ctx.drawImage(logo, brandX, brandY, logoW, logoH);

  const textX = brandX + logoW + 24;
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 72px ${FONT_EN}`;
  ctx.textBaseline = "top";
  ctx.fillText("Super Alpha", textX, brandY + 4);

  ctx.fillStyle = "#e8c36a";
  ctx.font = `700 48px ${FONT_KR}`;
  ctx.fillText("퀀트 자동매매", textX, brandY + logoH / 2 + 8);

  const brandBottom = brandY + logoH;
  // Clear breath between brand and stats block
  const gapAfterBrand = 110;

  // Labels + numbers — fill left column
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 68px ${FONT_KR}`;
  ctx.fillText("오늘 수익률", 56, brandBottom + gapAfterBrand);

  ctx.fillStyle = accent;
  ctx.font = `800 300px ${FONT_EN}`;
  ctx.fillText(fmtPct(payload.returnPct), 40, brandBottom + gapAfterBrand + 78);

  ctx.fillStyle = "#ffffff";
  ctx.font = `700 64px ${FONT_KR}`;
  ctx.fillText("수익", 56, 720);

  ctx.fillStyle = accent;
  ctx.font = `700 160px ${FONT_EN}`;
  ctx.fillText(fmtUsd(payload.pnlUsd), 44, 800);

  // Bottom-left datetime
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.font = `700 40px ${FONT_KR}`;
  ctx.fillText(fmtShareDateTime(at), 56, 980);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("이미지 생성 실패"))),
      "image/png",
    );
  });
  return blob;
}

export async function downloadPngBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Copy PNG to clipboard (PC). Falls back to download on unsupported browsers. */
export async function copyPngToClipboard(blob: Blob): Promise<"copied" | "downloaded"> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const item = new ClipboardItem({ "image/png": blob });
      await navigator.clipboard.write([item]);
      return "copied";
    }
  } catch {
    /* fall through */
  }
  await downloadPngBlob(blob, "super-alpha-pnl.png");
  return "downloaded";
}

export async function sharePngBlob(blob: Blob, title: string) {
  const file = new File([blob], "super-alpha-pnl.png", { type: "image/png" });
  if (
    typeof navigator !== "undefined" &&
    navigator.share &&
    navigator.canShare?.({ files: [file] })
  ) {
    await navigator.share({
      files: [file],
      title,
      text: "Super Alpha 퀀트 자동매매",
    });
    return "shared" as const;
  }
  return copyPngToClipboard(blob);
}
