"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const MAX_SAMPLES = 6;
const SENSITIVITY_KEY = "inspection:sensitivity";
const MISSING_KEY = "inspection:missingOn";
const SAMPLES_KEY = "inspection:samples";

type SampleItem = {
  id: string;
  count: number;
  color: string;
  thumbUrl?: string;
  aspectRatio?: number;
};

type DetectionBox = {
  x: number; // 画像内 0-1
  y: number; // 画像内 0-1
  w: number; // 画像内 0-1
  h: number; // 画像内 0-1
  color: string;
  sampleId: string;
  score: number;
};

const DEFAULT_SAMPLES: SampleItem[] = [
  { id: "1", count: 0, color: "border-sky-400 bg-sky-500/20", aspectRatio: 1 },
  { id: "2", count: 0, color: "border-emerald-400 bg-emerald-500/20", aspectRatio: 1 },
  { id: "3", count: 0, color: "border-amber-400 bg-amber-500/20", aspectRatio: 1 },
  { id: "4", count: 0, color: "border-fuchsia-400 bg-fuchsia-500/20", aspectRatio: 1 },
];

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function imageToGray(
  img: HTMLImageElement,
  targetW: number,
  targetH: number
): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new Float32Array(targetW * targetH);

  ctx.drawImage(img, 0, 0, targetW, targetH);
  const data = ctx.getImageData(0, 0, targetW, targetH).data;
  const out = new Float32Array(targetW * targetH);

  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
  }
  return out;
}

function canvasToGray(
  canvas: HTMLCanvasElement
): { gray: Float32Array; width: number; height: number } {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { gray: new Float32Array(0), width: 0, height: 0 };

  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const out = new Float32Array(width * height);

  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
  }
  return { gray: out, width, height };
}

function makeEdgeMap(gray: Float32Array, w: number, h: number) {
  const out = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;

      const gx =
        -gray[(y - 1) * w + (x - 1)] +
        gray[(y - 1) * w + (x + 1)] +
        -2 * gray[y * w + (x - 1)] +
        2 * gray[y * w + (x + 1)] +
        -gray[(y + 1) * w + (x - 1)] +
        gray[(y + 1) * w + (x + 1)];

      const gy =
        -gray[(y - 1) * w + (x - 1)] +
        -2 * gray[(y - 1) * w + x] +
        -gray[(y - 1) * w + (x + 1)] +
        gray[(y + 1) * w + (x - 1)] +
        2 * gray[(y + 1) * w + x] +
        gray[(y + 1) * w + (x + 1)];

      out[i] = Math.min(1, Math.sqrt(gx * gx + gy * gy));
    }
  }

  return out;
}

function meanOfArray(arr: Float32Array) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

function sampleWindowStd(
  scene: Float32Array,
  sceneW: number,
  sx: number,
  sy: number,
  tplW: number,
  tplH: number
) {
  let sum = 0;
  let sumSq = 0;
  const count = tplW * tplH;

  for (let y = 0; y < tplH; y++) {
    const row = (sy + y) * sceneW + sx;
    for (let x = 0; x < tplW; x++) {
      const v = scene[row + x];
      sum += v;
      sumSq += v * v;
    }
  }

  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return Math.sqrt(variance);
}

function sampleWindowMean(
  scene: Float32Array,
  sceneW: number,
  sx: number,
  sy: number,
  tplW: number,
  tplH: number
) {
  let sum = 0;
  const count = tplW * tplH;

  for (let y = 0; y < tplH; y++) {
    const row = (sy + y) * sceneW + sx;
    for (let x = 0; x < tplW; x++) {
      sum += scene[row + x];
    }
  }

  return sum / count;
}

function sampleWindowScoreDual(
  sceneGray: Float32Array,
  sceneEdge: Float32Array,
  sceneW: number,
  sx: number,
  sy: number,
  tplGray: Float32Array,
  tplEdge: Float32Array,
  tplW: number,
  tplH: number
) {
  let diffGray = 0;
  let diffEdge = 0;
  let idxTpl = 0;

  for (let y = 0; y < tplH; y++) {
    const row = (sy + y) * sceneW + sx;
    for (let x = 0; x < tplW; x++) {
      const sceneIdx = row + x;
      diffGray += Math.abs(sceneGray[sceneIdx] - tplGray[idxTpl]);
      diffEdge += Math.abs(sceneEdge[sceneIdx] - tplEdge[idxTpl]);
      idxTpl++;
    }
  }

  const count = tplW * tplH;
  const grayScore = diffGray / count;
  const edgeScore = diffEdge / count;

  return grayScore * 0.35 + edgeScore * 0.65;
}

function iou(a: DetectionBox, b: DetectionBox) {
  const ax1 = a.x;
  const ay1 = a.y;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;

  const bx1 = b.x;
  const by1 = b.y;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;

  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;

  return union > 0 ? inter / union : 0;
}

function centerDistance(a: DetectionBox, b: DetectionBox) {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  return Math.hypot(ax - bx, ay - by);
}

function mergeGlobalDetections(detections: DetectionBox[]) {
  const sorted = [...detections].sort((a, b) => a.score - b.score);
  const merged: DetectionBox[] = [];

  for (const d of sorted) {
    const overlaps = merged.some((m) => {
      const near = centerDistance(m, d) < Math.max(m.w, d.w) * 0.45;
      return iou(m, d) > 0.1 || near;
    });

    if (!overlaps) merged.push(d);
  }

  return merged;
}

export default function ReviewPage() {
  const router = useRouter();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [capturedImage, setCapturedImage] = useState("");
  const [sensitivity, setSensitivity] = useState(58);
  const [missingOn, setMissingOn] = useState(true);
  const [showDeleteFor, setShowDeleteFor] = useState<string | null>(null);
  const [samplesLoaded, setSamplesLoaded] = useState(false);

  const [imageRect, setImageRect] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });

  const [samples, setSamples] = useState<SampleItem[]>(DEFAULT_SAMPLES);
  const [detections, setDetections] = useState<DetectionBox[]>([]);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    try {
      const storedImage = sessionStorage.getItem("capturedImage");
      if (storedImage && storedImage.startsWith("data:image/")) {
        setCapturedImage(storedImage);
      }
    } catch (e) {
      console.error("sessionStorage load error:", e);
    }

    try {
      const savedSensitivity = localStorage.getItem(SENSITIVITY_KEY);
      if (savedSensitivity !== null) {
        const n = Number(savedSensitivity);
        if (Number.isFinite(n)) setSensitivity(n);
      }

      const savedMissing = localStorage.getItem(MISSING_KEY);
      if (savedMissing !== null) {
        setMissingOn(savedMissing === "true");
      }

      const savedSamples = localStorage.getItem(SAMPLES_KEY);
      if (savedSamples) {
        try {
          const parsed = JSON.parse(savedSamples);
          if (Array.isArray(parsed)) {
            setSamples(parsed);
          } else {
            setSamples(DEFAULT_SAMPLES);
          }
        } catch (e) {
          console.error("samples parse error:", e);
          setSamples(DEFAULT_SAMPLES);
        }
      } else {
        setSamples(DEFAULT_SAMPLES);
      }
    } catch (e) {
      console.error("localStorage init error:", e);
      setSamples(DEFAULT_SAMPLES);
    } finally {
      setSamplesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!samplesLoaded) return;
    try {
      localStorage.setItem(SAMPLES_KEY, JSON.stringify(samples));
    } catch (e) {
      console.error("samples save error:", e);
    }
  }, [samples, samplesLoaded]);

  const updateImageRect = () => {
    if (!frameRef.current || !imgRef.current) return;

    const frame = frameRef.current.getBoundingClientRect();
    const img = imgRef.current.getBoundingClientRect();

    setImageRect({
      left: img.left - frame.left,
      top: img.top - frame.top,
      width: img.width,
      height: img.height,
    });
  };

  useEffect(() => {
    const onResize = () => updateImageRect();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const handleSensitivityChange = (value: number) => {
    setSensitivity(value);
    localStorage.setItem(SENSITIVITY_KEY, String(value));
  };

  const handleMissingToggle = () => {
    const next = !missingOn;
    setMissingOn(next);
    localStorage.setItem(MISSING_KEY, String(next));
  };

  const canAdd = useMemo(() => samples.length < MAX_SAMPLES, [samples.length]);

  const visibleSamples = useMemo(
    () => samples.filter((s) => !!s.thumbUrl),
    [samples]
  );

  const detectedCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of samples) map[s.id] = 0;
    for (const d of detections) {
      map[d.sampleId] = (map[d.sampleId] || 0) + 1;
    }
    return map;
  }, [samples, detections]);

  useEffect(() => {
    let cancelled = false;

    async function runDetection() {
      if (!capturedImage || visibleSamples.length === 0) {
        setDetections([]);
        return;
      }

      setDetecting(true);

      try {
        const sceneImg = await loadImage(capturedImage);
        if (cancelled) return;

        const maxSceneW = 720;
        const scale = Math.min(1, maxSceneW / sceneImg.naturalWidth);
        const sceneW = Math.max(1, Math.round(sceneImg.naturalWidth * scale));
        const sceneH = Math.max(1, Math.round(sceneImg.naturalHeight * scale));

        const sceneCanvas = document.createElement("canvas");
        sceneCanvas.width = sceneW;
        sceneCanvas.height = sceneH;
        const sceneCtx = sceneCanvas.getContext("2d");
        if (!sceneCtx) return;

        sceneCtx.drawImage(sceneImg, 0, 0, sceneW, sceneH);

        const { gray: sceneGray } = canvasToGray(sceneCanvas);
        const sceneEdge = makeEdgeMap(sceneGray, sceneW, sceneH);

        const allDetections: DetectionBox[] = [];

        const threshold =
          0.11 - (Math.max(0, Math.min(100, sensitivity)) / 100) * 0.03;
        const stride = sensitivity >= 70 ? 8 : sensitivity >= 40 ? 10 : 12;

        for (const sample of visibleSamples) {
          if (!sample.thumbUrl) continue;

          const sampleImg = await loadImage(sample.thumbUrl);
          if (cancelled) return;

          const ratio =
            sample.aspectRatio && sample.aspectRatio > 0
              ? sample.aspectRatio
              : sampleImg.naturalWidth / sampleImg.naturalHeight || 1;

          const baseTplH = 54;
          const baseTplW = Math.max(24, Math.round(baseTplH * ratio));
          const scaleList = [0.95, 1.05];

          const candidates: DetectionBox[] = [];

          for (const s of scaleList) {
            const tplW = Math.max(14, Math.round(baseTplW * s));
            const tplH = Math.max(14, Math.round(baseTplH * s));

            if (tplW >= sceneW || tplH >= sceneH) continue;

            const tplGray = imageToGray(sampleImg, tplW, tplH);
            const tplEdge = makeEdgeMap(tplGray, tplW, tplH);

            const tplEdgeMean = meanOfArray(tplEdge);

            for (let y = 0; y <= sceneH - tplH; y += stride) {
              for (let x = 0; x <= sceneW - tplW; x += stride) {
                const std = sampleWindowStd(sceneGray, sceneW, x, y, tplW, tplH);
                if (std < 0.10) continue;

                const edgeMean = sampleWindowMean(sceneEdge, sceneW, x, y, tplW, tplH);
                if (edgeMean < tplEdgeMean * 0.55) continue;

                const score = sampleWindowScoreDual(
                  sceneGray,
                  sceneEdge,
                  sceneW,
                  x,
                  y,
                  tplGray,
                  tplEdge,
                  tplW,
                  tplH
                );

                if (score <= threshold) {
                  candidates.push({
                    x: x / sceneW,
                    y: y / sceneH,
                    w: tplW / sceneW,
                    h: tplH / sceneH,
                    color: sample.color.includes("sky")
                      ? "#38bdf8"
                      : sample.color.includes("emerald")
                        ? "#34d399"
                        : sample.color.includes("amber")
                          ? "#f59e0b"
                          : sample.color.includes("fuchsia")
                            ? "#d946ef"
                            : sample.color.includes("cyan")
                              ? "#06b6d4"
                              : "#f43f5e",
                    sampleId: sample.id,
                    score,
                  });
                }
              }
            }
          }

          candidates.sort((a, b) => a.score - b.score);
          const picked: DetectionBox[] = [];

          for (const c of candidates) {
            const overlaps = picked.some((p) => {
              const near = centerDistance(p, c) < Math.max(p.w, c.w) * 0.45;
              return iou(p, c) > 0.1 || near;
            });

            if (!overlaps) picked.push(c);
            if (picked.length >= 2) break;
          }

          allDetections.push(...picked);
        }

        const merged = mergeGlobalDetections(allDetections);

        if (!cancelled) {
          setDetections(merged);
        }
      } catch (e) {
        console.error("detection error:", e);
        if (!cancelled) setDetections([]);
      } finally {
        if (!cancelled) setDetecting(false);
      }
    }

    runDetection();

    return () => {
      cancelled = true;
    };
  }, [capturedImage, visibleSamples, sensitivity]);

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <div className="px-4 pt-4 pb-3 border-b border-zinc-800 bg-zinc-950 space-y-3">
        <div className="flex items-center gap-3">
          <div className="text-sm text-zinc-300 shrink-0">感度</div>
          <input
            type="range"
            min={0}
            max={100}
            value={sensitivity}
            onChange={(e) => handleSensitivityChange(Number(e.target.value))}
            className="flex-1"
          />
          <div className="text-sm w-9 text-right text-zinc-300">
            {sensitivity}
          </div>
        </div>

        <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-sm">欠落候補</div>
          <button
            onClick={handleMissingToggle}
            className={`w-14 h-8 rounded-full transition ${
              missingOn ? "bg-rose-500" : "bg-zinc-700"
            }`}
          >
            <span
              className={`block w-6 h-6 bg-white rounded-full transition translate-y-1 ${
                missingOn ? "translate-x-7" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </div>

      <div className="flex-1 p-4">
        <div
          ref={frameRef}
          className="w-full max-h-[52vh] rounded-[1.5rem] border border-zinc-800 bg-zinc-900 relative overflow-hidden aspect-[3/4] mx-auto flex items-center justify-center"
        >
          {capturedImage ? (
            <>
              <img
                ref={imgRef}
                src={capturedImage}
                alt="撮影画像"
                className="max-w-full max-h-full object-contain block"
                onLoad={updateImageRect}
              />

              {detections.map((box, index) => (
                <div
                  key={`${box.sampleId}-${index}`}
                  className="absolute rounded-md border-[3px]"
                  style={{
                    left: imageRect.left + imageRect.width * box.x,
                    top: imageRect.top + imageRect.height * box.y,
                    width: imageRect.width * box.w,
                    height: imageRect.height * box.h,
                    borderColor: box.color,
                  }}
                />
              ))}

              <div className="absolute left-3 bottom-3 text-[10px] bg-black/70 px-2 py-1 rounded border border-white/10 max-w-[85%] break-all">
                {detecting ? "検知中..." : `検知数: ${detections.length}`}
              </div>
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-zinc-400">
              まだ撮影画像がありません
            </div>
          )}
        </div>
      </div>

      <div className="px-4 pb-3">
        <div className="grid grid-cols-3 gap-3">
          {samples.map((sample) => {
            const ratio =
              sample.aspectRatio && sample.aspectRatio > 0
                ? sample.aspectRatio
                : 1;
            const thumbW = Math.max(40, Math.min(72, Math.round(40 * ratio)));

            return (
              <div key={sample.id} className="relative">
                <button
                  onClick={() =>
                    setShowDeleteFor(showDeleteFor === sample.id ? null : sample.id)
                  }
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 px-2 py-2 flex items-center gap-2 min-w-0"
                >
                  {sample.thumbUrl ? (
                    <div
                      className="h-10 shrink-0 rounded-lg overflow-hidden border border-white/10 bg-black flex items-center justify-center"
                      style={{ width: thumbW }}
                    >
                      <img
                        src={sample.thumbUrl}
                        alt="見本"
                        className="max-w-full max-h-full object-contain"
                      />
                    </div>
                  ) : (
                    <div
                      className={`w-10 h-10 rounded-lg border shrink-0 ${sample.color}`}
                    />
                  )}

                  <div className="text-lg font-semibold truncate">
                    {detectedCounts[sample.id] ?? 0}
                  </div>
                </button>

                {showDeleteFor === sample.id && (
                  <div className="absolute -top-2 -right-2">
                    <button
                      onClick={() => {
                        if (window.confirm("削除しますか？")) {
                          setSamples((prev) =>
                            prev.filter((s) => s.id !== sample.id)
                          );
                          setShowDeleteFor(null);
                        }
                      }}
                      className="w-8 h-8 rounded-full bg-rose-500 text-white shadow-lg"
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {canAdd && (
            <button
              onClick={() => router.push("/add-sample")}
              className="w-full h-14 rounded-2xl border border-dashed border-zinc-700 bg-zinc-900 text-2xl text-zinc-300"
            >
              +
            </button>
          )}
        </div>
      </div>

      <div className="bg-black px-5 pt-2 pb-6">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/settings")}
            className="w-11 h-11 rounded-full border border-white/15 bg-white/5 flex flex-col items-center justify-center gap-1"
            aria-label="設定"
          >
            <span className="block w-4 h-0.5 bg-white rounded" />
            <span className="block w-4 h-0.5 bg-white rounded" />
            <span className="block w-4 h-0.5 bg-white rounded" />
          </button>

          <div className="flex-1" />

          <button
            onClick={() => router.push("/camera")}
            className="w-14 h-14 rounded-2xl border border-white/15 bg-white/5 flex items-center justify-center shadow-lg active:scale-[0.98]"
            aria-label="再撮影"
            title="再撮影"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-7 h-7 text-white"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 7h3l2-2h6l2 2h3v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
              <circle cx="12" cy="12" r="3.5" />
            </svg>
          </button>
        </div>
      </div>
    </main>
  );
}