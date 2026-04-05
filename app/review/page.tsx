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
  score: number; // similarity (higher is better)
  support: number;
};

type SampleFeature = {
  aspectRatio: number;
  width: number;
  height: number;
  vector: Float32Array;
  baseGray: Float32Array;
  polarity: "dark" | "light" | "mixed";
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

function zNormalize(data: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= Math.max(1, data.length);

  let variance = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i] - mean;
    variance += d * d;
  }
  const std = Math.sqrt(variance / Math.max(1, data.length)) || 1;

  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = (data[i] - mean) / std;
  }
  return out;
}

function l2Normalize(data: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
  const norm = Math.sqrt(sumSq) || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] / norm;
  return out;
}

function cosineSimilarity(a: Float32Array, b: Float32Array) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

function computeSobel(gray: Float32Array, w: number, h: number) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p00 = gray[(y - 1) * w + (x - 1)];
      const p01 = gray[(y - 1) * w + x];
      const p02 = gray[(y - 1) * w + (x + 1)];
      const p10 = gray[y * w + (x - 1)];
      const p12 = gray[y * w + (x + 1)];
      const p20 = gray[(y + 1) * w + (x - 1)];
      const p21 = gray[(y + 1) * w + x];
      const p22 = gray[(y + 1) * w + (x + 1)];

      const sx =
        -p00 + p02 +
        -2 * p10 + 2 * p12 +
        -p20 + p22;

      const sy =
        -p00 - 2 * p01 - p02 +
        p20 + 2 * p21 + p22;

      const idx = y * w + x;
      gx[idx] = sx;
      gy[idx] = sy;
      mag[idx] = Math.hypot(sx, sy);
    }
  }

  return { gx, gy, mag };
}

function averagePool(
  src: Float32Array,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
) {
  const out = new Float32Array(outW * outH);

  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor((oy * srcH) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * srcH) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor((ox * srcW) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * srcW) / outW));

      let sum = 0;
      let cnt = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += src[y * srcW + x];
          cnt++;
        }
      }
      out[oy * outW + ox] = cnt > 0 ? sum / cnt : 0;
    }
  }

  return out;
}

function appendVectors(parts: Float32Array[]) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function estimatePolarity(gray: Float32Array): "dark" | "light" | "mixed" {
  let dark = 0;
  let light = 0;
  for (let i = 0; i < gray.length; i++) {
    dark += Math.max(0, 0.60 - gray[i]);
    light += Math.max(0, gray[i] - 0.40);
  }
  if (dark > light * 1.25) return "dark";
  if (light > dark * 1.25) return "light";
  return "mixed";
}

function trimMargins(
  gray: Float32Array,
  w: number,
  h: number
): { gray: Float32Array; width: number; height: number } {
  const { mag } = computeSobel(gray, w, h);

  const rowEnergy = new Float32Array(h);
  const colEnergy = new Float32Array(w);

  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const v = mag[idx] + Math.abs(gray[idx] - 0.5) * 0.25;
      row += v;
      colEnergy[x] += v;
    }
    rowEnergy[y] = row;
  }

  let rowMax = 0;
  let colMax = 0;
  for (let y = 0; y < h; y++) rowMax = Math.max(rowMax, rowEnergy[y]);
  for (let x = 0; x < w; x++) colMax = Math.max(colMax, colEnergy[x]);

  const rowThr = rowMax * 0.10;
  const colThr = colMax * 0.10;

  let top = 0;
  let bottom = h - 1;
  let left = 0;
  let right = w - 1;

  while (top < h - 2 && rowEnergy[top] < rowThr) top++;
  while (bottom > top + 1 && rowEnergy[bottom] < rowThr) bottom--;
  while (left < w - 2 && colEnergy[left] < colThr) left++;
  while (right > left + 1 && colEnergy[right] < colThr) right--;

  const padX = Math.max(1, Math.round((right - left + 1) * 0.08));
  const padY = Math.max(1, Math.round((bottom - top + 1) * 0.08));

  left = Math.max(0, left - padX);
  right = Math.min(w - 1, right + padX);
  top = Math.max(0, top - padY);
  bottom = Math.min(h - 1, bottom + padY);

  const tw = Math.max(8, right - left + 1);
  const th = Math.max(8, bottom - top + 1);
  const out = new Float32Array(tw * th);

  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      out[y * tw + x] = gray[(top + y) * w + (left + x)];
    }
  }

  return { gray: out, width: tw, height: th };
}

function buildFeatureVector(
  grayRaw: Float32Array,
  w: number,
  h: number
): { vector: Float32Array; polarity: "dark" | "light" | "mixed" } {
  const gray = robustNormalize(grayRaw);
  const { gx, gy, mag } = computeSobel(gray, w, h);

  const pooledGray = zNormalize(averagePool(gray, w, h, 12, 12));
  const pooledMag = zNormalize(averagePool(robustNormalize(mag), w, h, 12, 12));

  const absGx = new Float32Array(gx.length);
  const absGy = new Float32Array(gy.length);
  for (let i = 0; i < gx.length; i++) {
    absGx[i] = Math.abs(gx[i]);
    absGy[i] = Math.abs(gy[i]);
  }

  const pooledGx = zNormalize(averagePool(robustNormalize(absGx), w, h, 8, 8));
  const pooledGy = zNormalize(averagePool(robustNormalize(absGy), w, h, 8, 8));

  const rowProj = new Float32Array(8);
  const colProj = new Float32Array(8);

  for (let i = 0; i < 8; i++) {
    const y0 = Math.floor((i * h) / 8);
    const y1 = Math.max(y0 + 1, Math.floor(((i + 1) * h) / 8));
    let sum = 0;
    let cnt = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        sum += mag[y * w + x];
        cnt++;
      }
    }
    rowProj[i] = cnt > 0 ? sum / cnt : 0;
  }

  for (let i = 0; i < 8; i++) {
    const x0 = Math.floor((i * w) / 8);
    const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * w) / 8));
    let sum = 0;
    let cnt = 0;
    for (let x = x0; x < x1; x++) {
      for (let y = 0; y < h; y++) {
        sum += mag[y * w + x];
        cnt++;
      }
    }
    colProj[i] = cnt > 0 ? sum / cnt : 0;
  }

  const aspect = new Float32Array([w / h]);
  const vector = l2Normalize(
    appendVectors([
      pooledGray,
      pooledMag,
      pooledGx,
      pooledGy,
      zNormalize(rowProj),
      zNormalize(colProj),
      aspect,
    ])
  );

  return {
    vector,
    polarity: estimatePolarity(gray),
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

function buildMassMap(gray: Float32Array, w: number, h: number, polarity: "dark" | "light" | "mixed") {
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const g = gray[i];
    if (polarity === "dark") {
      out[i] = Math.max(0, 0.70 - g);
    } else if (polarity === "light") {
      out[i] = Math.max(0, g - 0.30);
    } else {
      out[i] = Math.abs(g - 0.5);
    }
  }
  return out;
}

async function buildSampleFeature(sample: SampleItem): Promise<SampleFeature | null> {
  if (!sample.thumbUrl) return null;

  const img = await loadImage(sample.thumbUrl);
  const ratio =
    sample.aspectRatio && sample.aspectRatio > 0
      ? sample.aspectRatio
      : img.naturalWidth / img.naturalHeight || 1;

  const baseH = 48;
  const baseW = Math.max(18, Math.round(baseH * ratio));
  const raw = imageToGray(img, baseW, baseH);
  const trimmed = trimMargins(raw, baseW, baseH);
  const feature = buildFeatureVector(trimmed.gray, trimmed.width, trimmed.height);

  return {
    aspectRatio: trimmed.width / trimmed.height,
    width: trimmed.width,
    height: trimmed.height,
    vector: feature.vector,
    baseGray: trimmed.gray,
    polarity: feature.polarity,
  };
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

        const sampleRaw = await Promise.all(visibleSamples.map((s) => buildSampleFeature(s)));
        const sampleEntries = visibleSamples
          .map((sample, index) => ({ sample, feature: sampleRaw[index] }))
          .filter(
            (entry): entry is { sample: SampleItem; feature: SampleFeature } => !!entry.feature
          );

        if (cancelled) return;
        if (sampleEntries.length === 0) {
          setDetections([]);
          return;
        }

        const allDetections: DetectionBox[] = [];
        const sens01 = Math.max(0, Math.min(100, appliedSensitivity)) / 100;
        const stride = appliedSensitivity >= 80 ? 10 : appliedSensitivity >= 45 ? 12 : 14;

        for (const entry of sampleEntries) {
          const { sample, feature } = entry;
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (cancelled) return;

          const massMap = buildMassMap(sceneGray, sceneW, sceneH, feature.polarity);
          const integral = makeIntegralMap(massMap, sceneW, sceneH);

          const baseH = Math.max(18, feature.height + 4);
          const baseW = Math.max(14, Math.round(baseH * feature.aspectRatio));
          const scaleList = [0.78, 0.90, 1.0, 1.12, 1.26];
          const rawCandidates: DetectionBox[] = [];

          for (const scaleMul of scaleList) {
            const ww = Math.max(14, Math.round(baseW * scaleMul));
            const hh = Math.max(14, Math.round(baseH * scaleMul));
            if (ww >= sceneW || hh >= sceneH) continue;

            for (let y = 0; y <= sceneH - hh; y += stride) {
              if (y % (stride * 8) === 0) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (cancelled) return;
              }

              for (let x = 0; x <= sceneW - ww; x += stride) {
                const mass = rectSum(integral, sceneW, x, y, ww, hh) / (ww * hh);
                if (mass < 0.028) continue;

                const patchGray = cropGrayPatch(
                  sceneGray,
                  sceneW,
                  sceneH,
                  x,
                  y,
                  ww,
                  hh,
                  feature.width,
                  feature.height
                );
                const patchFeature = buildFeatureVector(
                  patchGray,
                  feature.width,
                  feature.height
                );

                let sim = cosineSimilarity(feature.vector, patchFeature.vector);

                // 見本の明暗傾向と大きくズレる候補を少し減点
                if (
                  feature.polarity !== "mixed" &&
                  patchFeature.polarity !== "mixed" &&
                  feature.polarity !== patchFeature.polarity
                ) {
                  sim -= 0.04;
                }

                rawCandidates.push({
                  x: x / sceneW,
                  y: y / sceneH,
                  w: ww / sceneW,
                  h: hh / sceneH,
                  color: colorFromSample(sample),
                  sampleId: sample.id,
                  score: sim,
                  support: 0,
                });
              }
            }
          }

          if (rawCandidates.length === 0) continue;

          rawCandidates.sort((a, b) => b.score - a.score);
          const topTrimmed = rawCandidates.slice(0, 80);
          const supported = addSupportToCandidates(topTrimmed).sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.support - a.support;
          });

          const bestScore = supported[0]?.score ?? -1;
          const acceptThreshold = Math.max(0.60, bestScore - (0.18 - sens01 * 0.10));

          const picked: DetectionBox[] = [];
          for (const c of supported) {
            if (c.score < acceptThreshold) continue;
            const overlaps = picked.some((p) => overlapOrNear(p, c));
            if (!overlaps) picked.push(c);
            if (picked.length >= 3) break;
          }

          // 候補が弱い場合は0件にする
          if (bestScore < 0.68) {
            continue;
          }

          // 強い候補がないときは1件まで
          const maxCount =
            bestScore >= 0.88 ? 3 :
            bestScore >= 0.80 ? 2 : 1;

          allDetections.push(...picked.slice(0, maxCount));
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
        if (!cancelled) {
          setDetections([]);
        }
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
              <div key={sample.id} className="relative overflow-visible isolate">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowDeleteFor(showDeleteFor === sample.id ? null : sample.id);
                  }}
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 px-2 py-2 flex items-center gap-2 min-w-0"
                >
                  {sample.thumbUrl ? (
                    <div
                      className="relative h-10 shrink-0 rounded-lg overflow-hidden border border-white/10 bg-black flex items-center justify-center"
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
                  <div
                    className="absolute top-1 right-1 z-50"
                    onMouseDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
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