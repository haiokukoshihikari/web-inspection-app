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
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  sampleId: string;
  score: number;
  support: number;
};

type TemplateFeature = {
  aspectRatio: number;
  polarity: "dark" | "light";
  width: number;
  height: number;
  data: Float32Array;
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

function makeIntegralMap(src: Float32Array, w: number, h: number) {
  const integral = new Float32Array((w + 1) * (h + 1));

  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    for (let x = 1; x <= w; x++) {
      rowSum += src[(y - 1) * w + (x - 1)];
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + rowSum;
    }
  }

  return integral;
}

function rectSum(
  integral: Float32Array,
  fullW: number,
  x: number,
  y: number,
  w: number,
  h: number
) {
  const stride = fullW + 1;
  const x1 = x;
  const y1 = y;
  const x2 = x + w;
  const y2 = y + h;

  return (
    integral[y2 * stride + x2] -
    integral[y1 * stride + x2] -
    integral[y2 * stride + x1] +
    integral[y1 * stride + x1]
  );
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

function overlapOrNear(a: DetectionBox, b: DetectionBox) {
  const near = centerDistance(a, b) < Math.max(a.w, b.w) * 0.55;
  return iou(a, b) > 0.1 || near;
}

function addSupportToCandidates(candidates: DetectionBox[]) {
  return candidates.map((c, idx) => {
    let support = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (i === idx) continue;
      if (overlapOrNear(c, candidates[i])) support++;
    }
    return { ...c, support };
  });
}

function mergeGlobalDetections(detections: DetectionBox[]) {
  const sorted = [...detections].sort((a, b) => {
    if (b.support !== a.support) return b.support - a.support;
    return a.score - b.score;
  });

  const merged: DetectionBox[] = [];
  for (const d of sorted) {
    const overlaps = merged.some((m) => overlapOrNear(m, d));
    if (!overlaps) merged.push(d);
  }
  return merged;
}

function colorFromSample(sample: SampleItem) {
  if (sample.color.includes("sky")) return "#38bdf8";
  if (sample.color.includes("emerald")) return "#34d399";
  if (sample.color.includes("amber")) return "#f59e0b";
  if (sample.color.includes("fuchsia")) return "#d946ef";
  if (sample.color.includes("cyan")) return "#06b6d4";
  return "#f43f5e";
}

function robustNormalize(data: Float32Array): Float32Array {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  const range = Math.max(1e-6, max - min);
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = (data[i] - min) / range;
  }
  return out;
}

function blur3x3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          sum += src[yy * w + xx];
          cnt++;
        }
      }
      out[y * w + x] = sum / cnt;
    }
  }
  return out;
}

function makeForegroundMap(
  gray: Float32Array,
  w: number,
  h: number,
  polarity: "dark" | "light"
): Float32Array {
  const smooth = blur3x3(gray, w, h);
  const out = new Float32Array(w * h);

  for (let i = 0; i < gray.length; i++) {
    const diff =
      polarity === "dark"
        ? Math.max(0, smooth[i] - gray[i])
        : Math.max(0, gray[i] - smooth[i]);
    out[i] = diff;
  }

  const norm = robustNormalize(out);

  let mean = 0;
  for (let i = 0; i < norm.length; i++) mean += norm[i];
  mean /= Math.max(1, norm.length);

  let variance = 0;
  for (let i = 0; i < norm.length; i++) {
    const d = norm[i] - mean;
    variance += d * d;
  }
  const std = Math.sqrt(variance / Math.max(1, norm.length)) || 1;

  const z = new Float32Array(norm.length);
  for (let i = 0; i < norm.length; i++) {
    z[i] = Math.max(0, (norm[i] - mean) / std);
  }

  return robustNormalize(z);
}

function templateDistance(a: Float32Array, b: Float32Array) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / Math.max(1, len);
}

async function buildTemplateFeature(sample: SampleItem): Promise<TemplateFeature | null> {
  if (!sample.thumbUrl) return null;

  const img = await loadImage(sample.thumbUrl);
  const ratio =
    sample.aspectRatio && sample.aspectRatio > 0
      ? sample.aspectRatio
      : img.naturalWidth / img.naturalHeight || 1;

  const th = 36;
  const tw = Math.max(16, Math.round(th * ratio));
  const gray = imageToGray(img, tw, th);

  let darkEnergy = 0;
  let lightEnergy = 0;
  for (let i = 0; i < gray.length; i++) {
    darkEnergy += Math.max(0, 0.55 - gray[i]);
    lightEnergy += Math.max(0, gray[i] - 0.45);
  }

  const polarity: "dark" | "light" = lightEnergy > darkEnergy ? "light" : "dark";
  const fg = makeForegroundMap(gray, tw, th, polarity);

  return {
    aspectRatio: ratio,
    polarity,
    width: tw,
    height: th,
    data: fg,
  };
}

function cropGrayPatch(
  sceneGray: Float32Array,
  sceneW: number,
  sceneH: number,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  outW: number,
  outH: number
): Float32Array {
  const out = new Float32Array(outW * outH);

  for (let oy = 0; oy < outH; oy++) {
    const srcY = sy + ((oy + 0.5) * sh) / outH;
    const iy = Math.max(0, Math.min(sceneH - 1, Math.floor(srcY)));

    for (let ox = 0; ox < outW; ox++) {
      const srcX = sx + ((ox + 0.5) * sw) / outW;
      const ix = Math.max(0, Math.min(sceneW - 1, Math.floor(srcX)));
      out[oy * outW + ox] = sceneGray[iy * sceneW + ix];
    }
  }

  return out;
}

export default function ReviewPage() {
  const router = useRouter();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [capturedImage, setCapturedImage] = useState("");
  const [draftSensitivity, setDraftSensitivity] = useState(58);
  const [appliedSensitivity, setAppliedSensitivity] = useState(58);
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
  const [prepareDetecting, setPrepareDetecting] = useState(false);
  const [isAdjustingSensitivity, setIsAdjustingSensitivity] = useState(false);
  const [isSliderDragging, setIsSliderDragging] = useState(false);

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
        if (Number.isFinite(n)) {
          setDraftSensitivity(n);
          setAppliedSensitivity(n);
        }
      }

      const savedMissing = localStorage.getItem(MISSING_KEY);
      if (savedMissing !== null) {
        setMissingOn(savedMissing === "true");
      }

      const savedSamples = localStorage.getItem(SAMPLES_KEY);
      if (savedSamples) {
        try {
          const parsed = JSON.parse(savedSamples);
          if (Array.isArray(parsed)) setSamples(parsed);
          else setSamples(DEFAULT_SAMPLES);
        } catch {
          setSamples(DEFAULT_SAMPLES);
        }
      } else {
        setSamples(DEFAULT_SAMPLES);
      }
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

  useEffect(() => {
    const stopDragging = () => {
      setIsSliderDragging(false);
    };

    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    window.addEventListener("mouseup", stopDragging);
    window.addEventListener("touchend", stopDragging);
    window.addEventListener("touchcancel", stopDragging);

    return () => {
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
      window.removeEventListener("mouseup", stopDragging);
      window.removeEventListener("touchend", stopDragging);
      window.removeEventListener("touchcancel", stopDragging);
    };
  }, []);

  useEffect(() => {
    if (isSliderDragging) {
      setIsAdjustingSensitivity(true);
      return;
    }

    if (draftSensitivity === appliedSensitivity) {
      setIsAdjustingSensitivity(false);
      return;
    }

    setIsAdjustingSensitivity(true);

    const timer = window.setTimeout(() => {
      setAppliedSensitivity(draftSensitivity);
      localStorage.setItem(SENSITIVITY_KEY, String(draftSensitivity));
      setIsAdjustingSensitivity(false);
    }, 120);

    return () => window.clearTimeout(timer);
  }, [draftSensitivity, appliedSensitivity, isSliderDragging]);

  const updateImageRect = () => {
    const frame = frameRef.current;
    const img = imgRef.current;
    if (!frame || !img) return;

    const frameWidth = frame.clientWidth;
    const frameHeight = frame.clientHeight;
    const naturalWidth = img.naturalWidth;
    const naturalHeight = img.naturalHeight;
    if (!frameWidth || !frameHeight || !naturalWidth || !naturalHeight) return;

    const scale = Math.min(frameWidth / naturalWidth, frameHeight / naturalHeight);
    const displayWidth = naturalWidth * scale;
    const displayHeight = naturalHeight * scale;
    const left = (frameWidth - displayWidth) / 2;
    const top = (frameHeight - displayHeight) / 2;

    setImageRect({ left, top, width: displayWidth, height: displayHeight });
  };

  useEffect(() => {
    const onResize = () => updateImageRect();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!capturedImage) return;
    const t1 = window.setTimeout(() => updateImageRect(), 0);
    const t2 = window.setTimeout(() => updateImageRect(), 120);
    const t3 = window.setTimeout(() => updateImageRect(), 300);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [capturedImage, detections.length]);

  const handleSensitivityChange = (value: number) => {
    setDraftSensitivity(value);
  };

  const handleMissingToggle = () => {
    const next = !missingOn;
    setMissingOn(next);
    localStorage.setItem(MISSING_KEY, String(next));
  };

  const canAdd = useMemo(() => samples.length < MAX_SAMPLES, [samples.length]);
  const visibleSamples = useMemo(() => samples.filter((s) => !!s.thumbUrl), [samples]);

  const detectedCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of samples) map[s.id] = 0;
    for (const d of detections) map[d.sampleId] = (map[d.sampleId] || 0) + 1;
    return map;
  }, [samples, detections]);

  useEffect(() => {
    let cancelled = false;

    async function runDetection() {
      if (!capturedImage || visibleSamples.length === 0) {
        setDetections([]);
        return;
      }

      setDetections([]);
      setPrepareDetecting(true);

      await new Promise((resolve) => setTimeout(resolve, 180));
      if (cancelled) return;

      setPrepareDetecting(false);
      setDetecting(true);

      try {
        const sceneImg = await loadImage(capturedImage);
        if (cancelled) return;

        const maxSceneW = 520;
        const resizeScale = Math.min(1, maxSceneW / sceneImg.naturalWidth);
        const sceneW = Math.max(1, Math.round(sceneImg.naturalWidth * resizeScale));
        const sceneH = Math.max(1, Math.round(sceneImg.naturalHeight * resizeScale));

        const sceneCanvas = document.createElement("canvas");
        sceneCanvas.width = sceneW;
        sceneCanvas.height = sceneH;
        const sceneCtx = sceneCanvas.getContext("2d");
        if (!sceneCtx) return;

        sceneCtx.drawImage(sceneImg, 0, 0, sceneW, sceneH);
        const { gray: sceneGray } = canvasToGray(sceneCanvas);

        const templateRaw = await Promise.all(
          visibleSamples.map((s) => buildTemplateFeature(s))
        );

        const templateEntries = visibleSamples
          .map((sample, index) => ({
            sample,
            tpl: templateRaw[index],
          }))
          .filter(
            (entry): entry is { sample: SampleItem; tpl: TemplateFeature } => !!entry.tpl
          );

        if (cancelled) return;
        if (templateEntries.length === 0) {
          setDetections([]);
          return;
        }

        const allDetections: DetectionBox[] = [];
        const sensitivity01 = Math.max(0, Math.min(100, appliedSensitivity)) / 100;
        const threshold = 0.34 - sensitivity01 * 0.08;
        const stride = appliedSensitivity >= 75 ? 10 : appliedSensitivity >= 45 ? 12 : 14;

        for (const entry of templateEntries) {
          const { sample, tpl } = entry;

          await new Promise((resolve) => setTimeout(resolve, 0));
          if (cancelled) return;

          const sceneFg = makeForegroundMap(sceneGray, sceneW, sceneH, tpl.polarity);
          const sceneIntegral = makeIntegralMap(sceneFg, sceneW, sceneH);
          const candidates: DetectionBox[] = [];

          const baseH = Math.max(24, tpl.height + 10);
          const baseW = Math.max(20, Math.round(baseH * tpl.aspectRatio));
          const scaleList = [0.88, 1.0, 1.12];

          for (const scaleMul of scaleList) {
            const ww = Math.max(16, Math.round(baseW * scaleMul));
            const hh = Math.max(16, Math.round(baseH * scaleMul));
            if (ww >= sceneW || hh >= sceneH) continue;

            for (let y = 0; y <= sceneH - hh; y += stride) {
              if (y % (stride * 8) === 0) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (cancelled) return;
              }

              for (let x = 0; x <= sceneW - ww; x += stride) {
                const mass = rectSum(sceneIntegral, sceneW, x, y, ww, hh) / (ww * hh);
                if (mass < 0.03) continue;

                const patchGray = cropGrayPatch(
                  sceneGray,
                  sceneW,
                  sceneH,
                  x,
                  y,
                  ww,
                  hh,
                  tpl.width,
                  tpl.height
                );
                const patchFg = makeForegroundMap(patchGray, tpl.width, tpl.height, tpl.polarity);
                const dist = templateDistance(tpl.data, patchFg);

                if (dist <= threshold) {
                  candidates.push({
                    x: x / sceneW,
                    y: y / sceneH,
                    w: ww / sceneW,
                    h: hh / sceneH,
                    color: colorFromSample(sample),
                    sampleId: sample.id,
                    score: dist,
                    support: 0,
                  });
                }
              }
            }
          }

          const trimmed = candidates.sort((a, b) => a.score - b.score).slice(0, 60);
          const supported = addSupportToCandidates(trimmed).sort((a, b) => {
            if (b.support !== a.support) return b.support - a.support;
            return a.score - b.score;
          });

          const picked: DetectionBox[] = [];
          for (const c of supported) {
            const overlaps = picked.some((p) => overlapOrNear(p, c));
            if (!overlaps) picked.push(c);
            if (picked.length >= 3) break;
          }

          allDetections.push(...picked);
        }

        const merged = mergeGlobalDetections(allDetections);

        if (!cancelled) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
          if (cancelled) return;
          setDetections(merged);
        }
      } catch (e) {
        console.error("detection error:", e);
        if (!cancelled) setDetections([]);
      } finally {
        if (!cancelled) {
          setDetecting(false);
          setPrepareDetecting(false);
        }
      }
    }

    runDetection();

    return () => {
      cancelled = true;
    };
  }, [capturedImage, visibleSamples, appliedSensitivity]);

  const overlayMuted = isAdjustingSensitivity || prepareDetecting || detecting;
  const overlayMessage = isAdjustingSensitivity
    ? "調整中..."
    : prepareDetecting
      ? "準備中..."
      : detecting
        ? "検知中..."
        : "";

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <div className="px-4 pt-4 pb-3 border-b border-zinc-800 bg-zinc-950 space-y-3">
        <div className="flex items-center gap-3">
          <div className="text-sm text-zinc-300 shrink-0">感度</div>
          <input
            type="range"
            min={0}
            max={100}
            value={draftSensitivity}
            onChange={(e) => handleSensitivityChange(Number(e.target.value))}
            onInput={(e) =>
              handleSensitivityChange(Number((e.target as HTMLInputElement).value))
            }
            onPointerDown={() => setIsSliderDragging(true)}
            onTouchStart={() => setIsSliderDragging(true)}
            onMouseDown={() => setIsSliderDragging(true)}
            disabled={detecting || prepareDetecting}
            className={`flex-1 ${(detecting || prepareDetecting) ? "opacity-50 cursor-not-allowed" : ""}`}
          />
          <div
            className={`text-sm w-9 text-right ${(detecting || prepareDetecting) ? "text-zinc-500" : "text-zinc-300"}`}
          >
            {draftSensitivity}
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
                onLoad={() => {
                  updateImageRect();
                  window.setTimeout(() => updateImageRect(), 120);
                }}
              />

              {detections.map((box, index) => (
                <div
                  key={`${box.sampleId}-${index}`}
                  className="absolute rounded-md border-[3px] transition-opacity"
                  style={{
                    left: imageRect.left + imageRect.width * box.x,
                    top: imageRect.top + imageRect.height * box.y,
                    width: imageRect.width * box.w,
                    height: imageRect.height * box.h,
                    borderColor: box.color,
                    opacity: overlayMuted ? 0.35 : 1,
                  }}
                />
              ))}

              {overlayMessage ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/45">
                  <div className="px-6 py-4 rounded-2xl border border-white/15 bg-black/55 text-center shadow-xl">
                    <div className="text-2xl font-semibold tracking-wide">{overlayMessage}</div>
                    <div className="mt-1 text-sm text-zinc-300">少しお待ちください</div>
                  </div>
                </div>
              ) : null}

              <div className="absolute left-3 bottom-3 text-[10px] bg-black/70 px-2 py-1 rounded border border-white/10">
                {`検知数: ${detections.length}`}
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
              sample.aspectRatio && sample.aspectRatio > 0 ? sample.aspectRatio : 1;
            const thumbW = Math.max(40, Math.min(72, Math.round(40 * ratio)));

            return (
              <div key={sample.id} className="relative overflow-visible">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowDeleteFor(showDeleteFor === sample.id ? null : sample.id);
                  }}
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
                    <div className={`w-10 h-10 rounded-lg border shrink-0 ${sample.color}`} />
                  )}

                  <div className="text-lg font-semibold truncate">
                    {detectedCounts[sample.id] ?? 0}
                  </div>
                </button>

                {showDeleteFor === sample.id && (
                  <div className="absolute top-1 right-1 z-20">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm("削除しますか？")) {
                          setSamples((prev) => prev.filter((s) => s.id !== sample.id));
                          setShowDeleteFor(null);
                        }
                      }}
                      className="w-10 h-10 rounded-full bg-rose-500 text-white shadow-lg flex items-center justify-center"
                      aria-label="見本を削除"
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