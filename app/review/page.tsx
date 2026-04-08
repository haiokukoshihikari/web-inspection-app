"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";

declare global {
  interface Window {
    cv?: any;
  }
}

const REVIEW_VERSION = "v2026-04-08-02";

const MAX_SAMPLES = 6;
const SENSITIVITY_KEY = "inspection:sensitivity";
const MISSING_KEY = "inspection:missingOn";
const SAMPLES_KEY = "inspection:samples";
const MATCH_THRESHOLD_KEY = "inspection:matchThreshold";
const ROTATION_RANGE_KEY = "inspection:rotationRange";
const SCALE_RANGE_KEY = "inspection:scaleRange";
const SHEAR_RANGE_KEY = "inspection:shearRange";
const RESOLUTION_KEY = "inspection:compareResolution";
const HIT_LIMIT_KEY = "inspection:hitLimit";
const RECTIFY_KEY = "inspection:rectifyMode";

type DebugViewMode =
  | "ORIGINAL"
  | "GRAY"
  | "EQUALIZE"
  | "CLAHE"
  | "BIN50"
  | "BIN80"
  | "EDGE";

type MatchMethodMode = "CCOEFF" | "CCORR" | "SQDIFF";
type RotationRangeMode = 0 | 3 | 6 | 9;
type ScaleRangeMode = 0 | 5 | 10;
type ShearRangeMode = 0 | 5 | 10;
type CompareResolutionMode = 1200 | 1600 | 2000 | 2400;
type HitLimitMode = 30 | 60 | 100 | 300 | 9999;
type RectifyMode = "OFF" | "ON";

type CropNorm = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type SampleItem = {
  id: string;
  count: number;
  color: string;
  thumbUrl?: string;
  compareUrl?: string;
  aspectRatio?: number;
  sourceImageUrl?: string;
  cropNorm?: CropNorm;
  savedRectifyMode?: RectifyMode;
};

type MatchBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  label: string;
  rotationDeg: number;
  scaleFactor: number;
  shearFactor: number;
};

const DEBUG_MODES: DebugViewMode[] = [
  "ORIGINAL",
  "GRAY",
  "EQUALIZE",
  "CLAHE",
  "BIN50",
  "BIN80",
  "EDGE",
];

const MATCH_METHODS: MatchMethodMode[] = ["CCOEFF", "CCORR", "SQDIFF"];
const ROTATION_RANGE_OPTIONS: RotationRangeMode[] = [0, 3, 6, 9];
const SCALE_RANGE_OPTIONS: ScaleRangeMode[] = [0, 5, 10];
const SHEAR_RANGE_OPTIONS: ShearRangeMode[] = [0, 5, 10];
const RESOLUTION_OPTIONS: CompareResolutionMode[] = [1200, 1600, 2000, 2400];
const HIT_LIMIT_OPTIONS: HitLimitMode[] = [30, 60, 100, 300, 9999];
const RECTIFY_OPTIONS: RectifyMode[] = ["OFF", "ON"];

const DEFAULT_SAMPLES: SampleItem[] = [];

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function clamp01(v: number) {
  return clamp(v, 0, 1);
}

function colorFromIndex(index: number) {
  const colors = ["#38bdf8", "#34d399", "#f59e0b", "#d946ef", "#06b6d4", "#fb7185"];
  return colors[index % colors.length];
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function imageSrcToMat(
  cv: any,
  src: string,
  maxWidth: number
): Promise<{ srcMat: any; width: number; height: number } | null> {
  const img = await loadImage(src);
  const scale = Math.min(1, maxWidth / img.naturalWidth);
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.drawImage(img, 0, 0, width, height);

  const srcMat = cv.imread(canvas);
  return { srcMat, width, height };
}

function matToDataUrl(cv: any, mat: any): string {
  const canvas = document.createElement("canvas");
  cv.imshow(canvas, mat);
  return canvas.toDataURL("image/png");
}

function buildProcessedGrayMat(
  cv: any,
  srcMat: any,
  mode: DebugViewMode
): any {
  let gray: any = null;
  let work1: any = null;
  let work2: any = null;

  try {
    gray = new cv.Mat();
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);

    if (mode === "ORIGINAL" || mode === "GRAY") {
      return gray.clone();
    }

    if (mode === "EQUALIZE") {
      work1 = new cv.Mat();
      cv.equalizeHist(gray, work1);
      return work1.clone();
    }

    if (mode === "CLAHE") {
      const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
      work1 = new cv.Mat();
      clahe.apply(gray, work1);
      clahe.delete();
      return work1.clone();
    }

    if (mode === "BIN50" || mode === "BIN80") {
      const thresholdValue = mode === "BIN50" ? 50 : 80;
      work1 = new cv.Mat();
      cv.GaussianBlur(gray, work1, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
      work2 = new cv.Mat();
      cv.threshold(work1, work2, thresholdValue, 255, cv.THRESH_BINARY);
      return work2.clone();
    }

    if (mode === "EDGE") {
      work1 = new cv.Mat();
      cv.GaussianBlur(gray, work1, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
      work2 = new cv.Mat();
      cv.Canny(work1, work2, 60, 180);
      return work2.clone();
    }

    return gray.clone();
  } finally {
    try {
      gray?.delete?.();
      work1?.delete?.();
      work2?.delete?.();
    } catch {}
  }
}

function buildDebugImageFromSrcMat(cv: any, srcMat: any, mode: DebugViewMode): string {
  let processed: any = null;
  let out: any = null;

  try {
    if (mode === "ORIGINAL") {
      return matToDataUrl(cv, srcMat);
    }

    processed = buildProcessedGrayMat(cv, srcMat, mode);
    out = new cv.Mat();
    cv.cvtColor(processed, out, cv.COLOR_GRAY2RGBA);
    return matToDataUrl(cv, out);
  } finally {
    try {
      processed?.delete?.();
      out?.delete?.();
    } catch {}
  }
}

function getOpenCvMatchMethod(cv: any, mode: MatchMethodMode) {
  if (mode === "CCOEFF") return cv.TM_CCOEFF_NORMED;
  if (mode === "CCORR") return cv.TM_CCORR_NORMED;
  return cv.TM_SQDIFF_NORMED;
}

function getRotationValues(range: RotationRangeMode): number[] {
  if (range === 0) return [0];
  if (range === 3) return [-3, 0, 3];
  if (range === 6) return [-6, -3, 0, 3, 6];
  return [-9, -6, -3, 0, 3, 6, 9];
}

function getScaleValues(range: ScaleRangeMode): number[] {
  if (range === 0) return [1];
  if (range === 5) return [0.95, 1.0, 1.05];
  return [0.9, 0.95, 1.0, 1.05, 1.1];
}

function getShearValues(range: ShearRangeMode): number[] {
  if (range === 0) return [0];
  if (range === 5) return [-0.05, 0, 0.05];
  return [-0.1, -0.05, 0, 0.05, 0.1];
}

function orderQuadPoints(points: { x: number; y: number }[]) {
  const sorted = [...points].sort((a, b) => a.y - b.y);
  const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = sorted.slice(2, 4).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bottom[1], bottom[0]];
}

function rectifySceneApprox(cv: any, srcMat: any): any {
  let gray: any = null;
  let blur: any = null;
  let edges: any = null;
  let contours: any = null;
  let hierarchy: any = null;
  let bestContour: any = null;
  let bestHull: any = null;
  let approx: any = null;
  let dst: any = null;
  let M: any = null;

  try {
    gray = new cv.Mat();
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);

    blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    edges = new cv.Mat();
    cv.Canny(blur, edges, 40, 140);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(edges, edges, kernel);
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    kernel.delete();

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      const rect = cv.boundingRect(cnt);

      const largeEnough =
        rect.width > srcMat.cols * 0.35 &&
        rect.height > srcMat.rows * 0.35;

      if (largeEnough && area > bestArea) {
        bestArea = area;
        bestContour?.delete?.();
        bestContour = cnt.clone();
      }
      cnt.delete();
    }

    if (!bestContour) {
      return srcMat.clone();
    }

    bestHull = new cv.Mat();
    cv.convexHull(bestContour, bestHull, false, true);

    const peri = cv.arcLength(bestHull, true);
    approx = new cv.Mat();
    cv.approxPolyDP(bestHull, approx, 0.02 * peri, true);

    let quad: { x: number; y: number }[] | null = null;

    if (approx.rows === 4) {
      quad = [];
      for (let i = 0; i < 4; i++) {
        quad.push({
          x: approx.intPtr(i, 0)[0],
          y: approx.intPtr(i, 0)[1],
        });
      }
    } else {
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < bestHull.rows; i++) {
        pts.push({
          x: bestHull.intPtr(i, 0)[0],
          y: bestHull.intPtr(i, 0)[1],
        });
      }

      if (pts.length >= 4) {
        const minY = Math.min(...pts.map((p) => p.y));
        const maxY = Math.max(...pts.map((p) => p.y));
        const band = Math.max(10, Math.round((maxY - minY) * 0.15));

        const topBand = pts.filter((p) => p.y <= minY + band);
        const bottomBand = pts.filter((p) => p.y >= maxY - band);

        if (topBand.length >= 2 && bottomBand.length >= 2) {
          quad = [
            topBand.reduce((a, b) => (a.x < b.x ? a : b)),
            topBand.reduce((a, b) => (a.x > b.x ? a : b)),
            bottomBand.reduce((a, b) => (a.x > b.x ? a : b)),
            bottomBand.reduce((a, b) => (a.x < b.x ? a : b)),
          ];
        }
      }
    }

    if (!quad) {
      return srcMat.clone();
    }

    const [tl, tr, br, bl] = orderQuadPoints(quad);

    const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
    const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);

    const dstW = Math.max(1, Math.round(Math.max(widthTop, widthBottom)));
    const dstH = Math.max(1, Math.round(Math.max(heightLeft, heightRight)));

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      tl.x, tl.y,
      tr.x, tr.y,
      br.x, br.y,
      bl.x, bl.y,
    ]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      dstW - 1, 0,
      dstW - 1, dstH - 1,
      0, dstH - 1,
    ]);

    M = cv.getPerspectiveTransform(srcTri, dstTri);
    dst = new cv.Mat();
    cv.warpPerspective(
      srcMat,
      dst,
      M,
      new cv.Size(dstW, dstH),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(0, 0, 0, 255)
    );

    srcTri.delete();
    dstTri.delete();

    return dst.clone();
  } finally {
    try {
      gray?.delete?.();
      blur?.delete?.();
      edges?.delete?.();
      contours?.delete?.();
      hierarchy?.delete?.();
      bestContour?.delete?.();
      bestHull?.delete?.();
      approx?.delete?.();
      dst?.delete?.();
      M?.delete?.();
    } catch {}
  }
}

function transformTemplateGray(
  cv: any,
  grayMat: any,
  rotationDeg: number,
  scaleFactor: number,
  shearFactor: number
): any | null {
  let scaled: any = null;
  let rotated: any = null;
  let sheared: any = null;
  let Mrot: any = null;
  let Mshear: any = null;

  try {
    const srcW = grayMat.cols;
    const srcH = grayMat.rows;
    const newW = Math.max(1, Math.round(srcW * scaleFactor));
    const newH = Math.max(1, Math.round(srcH * scaleFactor));

    scaled = new cv.Mat();
    cv.resize(grayMat, scaled, new cv.Size(newW, newH), 0, 0, cv.INTER_LINEAR);

    let current = scaled;

    if (rotationDeg !== 0) {
      const center = new cv.Point(current.cols / 2, current.rows / 2);
      Mrot = cv.getRotationMatrix2D(center, rotationDeg, 1);

      const cos = Math.abs(Mrot.doubleAt(0, 0));
      const sin = Math.abs(Mrot.doubleAt(0, 1));
      const boundW = Math.max(1, Math.round(current.rows * sin + current.cols * cos));
      const boundH = Math.max(1, Math.round(current.rows * cos + current.cols * sin));

      Mrot.doublePtr(0, 2)[0] += boundW / 2 - center.x;
      Mrot.doublePtr(1, 2)[0] += boundH / 2 - center.y;

      rotated = new cv.Mat();
      cv.warpAffine(
        current,
        rotated,
        Mrot,
        new cv.Size(boundW, boundH),
        cv.INTER_LINEAR,
        cv.BORDER_CONSTANT,
        new cv.Scalar(0)
      );
      current = rotated;
    }

    if (shearFactor !== 0) {
      const extraW = Math.ceil(Math.abs(shearFactor) * current.rows);
      const outW = current.cols + extraW;
      const outH = current.rows;

      Mshear = cv.matFromArray(2, 3, cv.CV_64F, [
        1, shearFactor, shearFactor < 0 ? extraW : 0,
        0, 1, 0,
      ]);

      sheared = new cv.Mat();
      cv.warpAffine(
        current,
        sheared,
        Mshear,
        new cv.Size(outW, outH),
        cv.INTER_LINEAR,
        cv.BORDER_CONSTANT,
        new cv.Scalar(0)
      );
      current = sheared;
    }

    return current.clone();
  } finally {
    try {
      scaled?.delete?.();
      rotated?.delete?.();
      sheared?.delete?.();
      Mrot?.delete?.();
      Mshear?.delete?.();
    } catch {}
  }
}

async function rebuildSampleMat(params: {
  cv: any;
  sample: SampleItem;
  compareResolution: CompareResolutionMode;
  rectifyMode: RectifyMode;
}): Promise<{ mat: any; previewUrl: string; aspectRatio: number } | null> {
  const { cv, sample, compareResolution, rectifyMode } = params;

  if (!sample.sourceImageUrl || !sample.cropNorm) {
    if (!sample.compareUrl) return null;
    const loaded = await imageSrcToMat(cv, sample.compareUrl, compareResolution);
    if (!loaded) return null;
    return {
      mat: loaded.srcMat.clone(),
      previewUrl: sample.compareUrl,
      aspectRatio: loaded.width / loaded.height,
    };
  }

  let src: any = null;
  let work: any = null;
  let crop: any = null;

  try {
    const loaded = await imageSrcToMat(cv, sample.sourceImageUrl, compareResolution);
    if (!loaded) return null;

    src = loaded.srcMat;
    work = rectifyMode === "ON" ? rectifySceneApprox(cv, src) : src.clone();

    const x = clamp(Math.round(sample.cropNorm.x * work.cols), 0, work.cols - 1);
    const y = clamp(Math.round(sample.cropNorm.y * work.rows), 0, work.rows - 1);
    const w = clamp(Math.round(sample.cropNorm.w * work.cols), 1, work.cols - x);
    const h = clamp(Math.round(sample.cropNorm.h * work.rows), 1, work.rows - y);

    crop = work.roi(new cv.Rect(x, y, w, h)).clone();

    return {
      mat: crop.clone(),
      previewUrl: matToDataUrl(cv, crop),
      aspectRatio: w / h,
    };
  } finally {
    try {
      src?.delete?.();
      work?.delete?.();
      crop?.delete?.();
    } catch {}
  }
}

function runMultiMatch(params: {
  cv: any;
  sceneSrcMat: any;
  sampleSrcMat: any;
  sceneWidth: number;
  sceneHeight: number;
  debugMode: DebugViewMode;
  matchMode: MatchMethodMode;
  threshold: number;
  rotationRange: RotationRangeMode;
  scaleRange: ScaleRangeMode;
  shearRange: ShearRangeMode;
  hitLimit: HitLimitMode;
}): MatchBox[] {
  const {
    cv,
    sceneSrcMat,
    sampleSrcMat,
    sceneWidth,
    sceneHeight,
    debugMode,
    matchMode,
    threshold,
    rotationRange,
    scaleRange,
    shearRange,
    hitLimit,
  } = params;

  let sceneGray: any = null;
  let sampleGray: any = null;

  try {
    sceneGray = buildProcessedGrayMat(cv, sceneSrcMat, debugMode);
    sampleGray = buildProcessedGrayMat(cv, sampleSrcMat, debugMode);

    const boxes: MatchBox[] = [];
    const rotationValues = getRotationValues(rotationRange);
    const scaleValues = getScaleValues(scaleRange);
    const shearValues = getShearValues(shearRange);

    const localMaxCount = hitLimit === 9999 ? 300 : Math.max(20, Math.min(hitLimit, 120));

    for (const rotationDeg of rotationValues) {
      for (const scaleFactor of scaleValues) {
        for (const shearFactor of shearValues) {
          let template: any = null;
          let result: any = null;

          try {
            template = transformTemplateGray(cv, sampleGray, rotationDeg, scaleFactor, shearFactor);
            if (!template) continue;

            if (
              template.cols < 8 ||
              template.rows < 8 ||
              template.cols >= sceneGray.cols ||
              template.rows >= sceneGray.rows
            ) {
              continue;
            }

            result = new cv.Mat();
            cv.matchTemplate(sceneGray, template, result, getOpenCvMatchMethod(cv, matchMode));

            for (let i = 0; i < localMaxCount; i++) {
              const mm = cv.minMaxLoc(result);

              let x = 0;
              let y = 0;
              let score = 0;

              if (matchMode === "SQDIFF") {
                x = mm.minLoc.x;
                y = mm.minLoc.y;
                score = 1 - mm.minVal;
              } else {
                x = mm.maxLoc.x;
                y = mm.maxLoc.y;
                score = mm.maxVal;
              }

              if (score < threshold) break;

              const w = template.cols;
              const h = template.rows;

              boxes.push({
                x: clamp01(x / sceneWidth),
                y: clamp01(y / sceneHeight),
                w: clamp01(w / sceneWidth),
                h: clamp01(h / sceneHeight),
                score,
                label: `${matchMode} / ${debugMode} / rot ${rotationDeg >= 0 ? "+" : ""}${rotationDeg} / scale ${scaleFactor.toFixed(2)} / shear ${shearFactor.toFixed(2)}`,
                rotationDeg,
                scaleFactor,
                shearFactor,
              });

              const suppressX = clamp(x - Math.round(w * 0.35), 0, result.cols - 1);
              const suppressY = clamp(y - Math.round(h * 0.35), 0, result.rows - 1);
              const suppressW = clamp(Math.round(w * 0.7), 1, result.cols - suppressX);
              const suppressH = clamp(Math.round(h * 0.7), 1, result.rows - suppressY);
              if (suppressW <= 0 || suppressH <= 0) break;

              const roi = result.roi(new cv.Rect(suppressX, suppressY, suppressW, suppressH));
              if (matchMode === "SQDIFF") roi.setTo(new cv.Scalar(1));
              else roi.setTo(new cv.Scalar(-1));
              roi.delete();
            }
          } finally {
            try {
              template?.delete?.();
              result?.delete?.();
            } catch {}
          }
        }
      }
    }

    boxes.sort((a, b) => b.score - a.score);

    const deduped: MatchBox[] = [];
    for (const box of boxes) {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;

      const exists = deduped.some((d) => {
        const dcx = d.x + d.w / 2;
        const dcy = d.y + d.h / 2;
        const dx = cx - dcx;
        const dy = cy - dcy;
        const dist = Math.hypot(dx, dy);
        const ref = Math.max(box.w, box.h, d.w, d.h) * 0.45;
        return dist < ref;
      });

      if (!exists) deduped.push(box);
      if (deduped.length >= hitLimit) break;
    }

    return deduped;
  } finally {
    try {
      sceneGray?.delete?.();
      sampleGray?.delete?.();
    } catch {}
  }
}

export default function ReviewPage() {
  const router = useRouter();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const prevRectifyRef = useRef<RectifyMode | null>(null);

  const [capturedImage, setCapturedImage] = useState("");
  const [draftSensitivity, setDraftSensitivity] = useState(58);
  const [appliedSensitivity, setAppliedSensitivity] = useState(58);
  const [missingOn, setMissingOn] = useState(true);
  const [showDeleteFor, setShowDeleteFor] = useState<string | null>(null);
  const [samplesLoaded, setSamplesLoaded] = useState(false);

  const [samples, setSamples] = useState<SampleItem[]>(DEFAULT_SAMPLES);

  const [cvReady, setCvReady] = useState(false);
  const [cvError, setCvError] = useState("");
  const [cvStatus, setCvStatus] = useState("OpenCV 未読込");

  const [debugMode, setDebugMode] = useState<DebugViewMode>("ORIGINAL");
  const [matchMethod, setMatchMethod] = useState<MatchMethodMode>("CCOEFF");
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);

  const [mainPreviewUrl, setMainPreviewUrl] = useState("");
  const [samplePreviewUrl, setSamplePreviewUrl] = useState("");
  const [buildingPreview, setBuildingPreview] = useState(false);
  const [matchBoxes, setMatchBoxes] = useState<MatchBox[]>([]);
  const [matchThreshold, setMatchThreshold] = useState(0.8);
  const [rotationRange, setRotationRange] = useState<RotationRangeMode>(0);
  const [scaleRange, setScaleRange] = useState<ScaleRangeMode>(0);
  const [shearRange, setShearRange] = useState<ShearRangeMode>(0);
  const [compareResolution, setCompareResolution] =
    useState<CompareResolutionMode>(1200);
  const [hitLimit, setHitLimit] = useState<HitLimitMode>(30);
  const [rectifyMode, setRectifyMode] = useState<RectifyMode>("OFF");

  const [displayBasis, setDisplayBasis] = useState({ width: 0, height: 0 });
  const [imageRect, setImageRect] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });

  useEffect(() => {
    try {
      const storedImage = sessionStorage.getItem("capturedImage");
      if (storedImage && storedImage.startsWith("data:image/")) {
        setCapturedImage(storedImage);
        setMainPreviewUrl(storedImage);
      }

      const savedSensitivity = localStorage.getItem(SENSITIVITY_KEY);
      if (savedSensitivity !== null) {
        const n = Number(savedSensitivity);
        if (Number.isFinite(n)) {
          setDraftSensitivity(n);
          setAppliedSensitivity(n);
        }
      }

      const savedMissing = localStorage.getItem(MISSING_KEY);
      if (savedMissing !== null) setMissingOn(savedMissing === "true");

      const savedSamples = localStorage.getItem(SAMPLES_KEY);
      if (savedSamples) {
        const parsed = JSON.parse(savedSamples);
        if (Array.isArray(parsed)) setSamples(parsed);
      }

      const savedThreshold = localStorage.getItem(MATCH_THRESHOLD_KEY);
      if (savedThreshold !== null) {
        const n = Number(savedThreshold);
        if (Number.isFinite(n)) setMatchThreshold(n);
      }

      const savedRotationRange = localStorage.getItem(ROTATION_RANGE_KEY);
      if (savedRotationRange !== null) {
        const n = Number(savedRotationRange) as RotationRangeMode;
        if ([0, 3, 6, 9].includes(n)) setRotationRange(n);
      }

      const savedScaleRange = localStorage.getItem(SCALE_RANGE_KEY);
      if (savedScaleRange !== null) {
        const n = Number(savedScaleRange) as ScaleRangeMode;
        if ([0, 5, 10].includes(n)) setScaleRange(n);
      }

      const savedShearRange = localStorage.getItem(SHEAR_RANGE_KEY);
      if (savedShearRange !== null) {
        const n = Number(savedShearRange) as ShearRangeMode;
        if ([0, 5, 10].includes(n)) setShearRange(n);
      }

      const savedResolution = localStorage.getItem(RESOLUTION_KEY);
      if (savedResolution !== null) {
        const n = Number(savedResolution) as CompareResolutionMode;
        if ([1200, 1600, 2000, 2400].includes(n)) setCompareResolution(n);
      }

      const savedHitLimit = localStorage.getItem(HIT_LIMIT_KEY);
      if (savedHitLimit !== null) {
        const n = Number(savedHitLimit) as HitLimitMode;
        if ([30, 60, 100, 300, 9999].includes(n)) setHitLimit(n);
      }

      const savedRectify = localStorage.getItem(RECTIFY_KEY);
      if (savedRectify === "OFF" || savedRectify === "ON") {
        setRectifyMode(savedRectify);
        prevRectifyRef.current = savedRectify;
      } else {
        prevRectifyRef.current = "OFF";
      }
    } catch {}

    setSamplesLoaded(true);
  }, []);

  useEffect(() => {
    if (!samplesLoaded) return;
    localStorage.setItem(SAMPLES_KEY, JSON.stringify(samples));
  }, [samples, samplesLoaded]);

  useEffect(() => {
    if (!samplesLoaded) return;
    if (prevRectifyRef.current === null) {
      prevRectifyRef.current = rectifyMode;
      return;
    }
    if (prevRectifyRef.current !== rectifyMode) {
      setSamples([]);
      setSelectedSampleId(null);
      setSamplePreviewUrl("");
      setMatchBoxes([]);
      localStorage.removeItem(SAMPLES_KEY);
      prevRectifyRef.current = rectifyMode;
    }
  }, [rectifyMode, samplesLoaded]);

  useEffect(() => {
    if (draftSensitivity === appliedSensitivity) return;
    const timer = window.setTimeout(() => {
      setAppliedSensitivity(draftSensitivity);
      localStorage.setItem(SENSITIVITY_KEY, String(draftSensitivity));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [draftSensitivity, appliedSensitivity]);

  useEffect(() => {
    localStorage.setItem(MATCH_THRESHOLD_KEY, String(matchThreshold));
  }, [matchThreshold]);

  useEffect(() => {
    localStorage.setItem(ROTATION_RANGE_KEY, String(rotationRange));
  }, [rotationRange]);

  useEffect(() => {
    localStorage.setItem(SCALE_RANGE_KEY, String(scaleRange));
  }, [scaleRange]);

  useEffect(() => {
    localStorage.setItem(SHEAR_RANGE_KEY, String(shearRange));
  }, [shearRange]);

  useEffect(() => {
    localStorage.setItem(RESOLUTION_KEY, String(compareResolution));
  }, [compareResolution]);

  useEffect(() => {
    localStorage.setItem(HIT_LIMIT_KEY, String(hitLimit));
  }, [hitLimit]);

  useEffect(() => {
    localStorage.setItem(RECTIFY_KEY, rectifyMode);
  }, [rectifyMode]);

  useEffect(() => {
    let cancelled = false;
    let pollId: number | null = null;
    let timeoutId: number | null = null;

    const cleanup = () => {
      if (pollId !== null) window.clearInterval(pollId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };

    const markReady = (cvObj: any) => {
      if (cancelled) return;
      cleanup();
      window.cv = cvObj;
      setCvReady(true);
      setCvError("");
      setCvStatus("OpenCV 利用可能");
    };

    const markError = (msg: string) => {
      if (cancelled) return;
      cleanup();
      setCvReady(false);
      setCvError("OpenCVの読み込みに失敗しました");
      setCvStatus(msg);
    };

    const tryResolve = async () => {
      try {
        let cvObj = window.cv;
        if (!cvObj) {
          setCvStatus("cv 未生成");
          return;
        }
        if (cvObj instanceof Promise) {
          cvObj = await cvObj;
          if (cancelled) return;
          window.cv = cvObj;
        }
        if (cvObj && typeof cvObj.getBuildInformation === "function") {
          markReady(cvObj);
          return;
        }
      } catch (e: any) {
        markError(`失敗: ${String(e?.message ?? e)}`);
      }
    };

    timeoutId = window.setTimeout(() => markError("OpenCV load timeout"), 20000);
    pollId = window.setInterval(() => void tryResolve(), 300);
    void tryResolve();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  const updateImageRect = () => {
    const frame = frameRef.current;
    if (!frame) return;

    const frameWidth = frame.clientWidth;
    const frameHeight = frame.clientHeight;
    const basisWidth = displayBasis.width;
    const basisHeight = displayBasis.height;
    if (!frameWidth || !frameHeight || !basisWidth || !basisHeight) return;

    const scale = Math.min(frameWidth / basisWidth, frameHeight / basisHeight);
    const displayWidth = basisWidth * scale;
    const displayHeight = basisHeight * scale;
    const left = (frameWidth - displayWidth) / 2;
    const top = (frameHeight - displayHeight) / 2;

    setImageRect({ left, top, width: displayWidth, height: displayHeight });
  };

  useEffect(() => {
    const onResize = () => updateImageRect();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [displayBasis]);

  useEffect(() => {
    if (!mainPreviewUrl || !displayBasis.width || !displayBasis.height) return;
    const t1 = window.setTimeout(() => updateImageRect(), 0);
    const t2 = window.setTimeout(() => updateImageRect(), 100);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [mainPreviewUrl, displayBasis, matchBoxes]);

  useEffect(() => {
    let cancelled = false;

    async function buildPreviewsAndMatch() {
      if (!cvReady || !capturedImage) return;
      const cv = window.cv;
      if (!cv) return;

      setBuildingPreview(true);

      let sceneOriginal: any = null;
      let sceneWork: any = null;
      let sampleMat: any = null;

      try {
        const loadedScene = await imageSrcToMat(cv, capturedImage, compareResolution);
        if (!loadedScene) return;

        sceneOriginal = loadedScene.srcMat;
        sceneWork =
          rectifyMode === "ON" ? rectifySceneApprox(cv, sceneOriginal) : sceneOriginal.clone();

        if (cancelled) return;

        setDisplayBasis({ width: sceneWork.cols, height: sceneWork.rows });
        setMainPreviewUrl(
          debugMode === "ORIGINAL"
            ? matToDataUrl(cv, sceneWork)
            : buildDebugImageFromSrcMat(cv, sceneWork, debugMode)
        );

        const sample = samples.find(
          (s) => s.id === selectedSampleId && (s.sourceImageUrl || s.compareUrl)
        );

        if (!sample) {
          setSamplePreviewUrl("");
          setMatchBoxes([]);
          return;
        }

        const rebuilt = await rebuildSampleMat({
          cv,
          sample,
          compareResolution,
          rectifyMode,
        });
        if (!rebuilt) {
          setSamplePreviewUrl("");
          setMatchBoxes([]);
          return;
        }

        sampleMat = rebuilt.mat;

        setSamplePreviewUrl(
          debugMode === "ORIGINAL"
            ? rebuilt.previewUrl
            : buildDebugImageFromSrcMat(cv, sampleMat, debugMode)
        );

        const hits = runMultiMatch({
          cv,
          sceneSrcMat: sceneWork,
          sampleSrcMat: sampleMat,
          sceneWidth: sceneWork.cols,
          sceneHeight: sceneWork.rows,
          debugMode,
          matchMode: matchMethod,
          threshold: matchThreshold,
          rotationRange,
          scaleRange,
          shearRange,
          hitLimit,
        });

        if (!cancelled) {
          setMatchBoxes(hits);
        }
      } catch (e) {
        console.error(e);
      } finally {
        try {
          sceneOriginal?.delete?.();
          sceneWork?.delete?.();
          sampleMat?.delete?.();
        } catch {}
        if (!cancelled) setBuildingPreview(false);
      }
    }

    void buildPreviewsAndMatch();

    return () => {
      cancelled = true;
    };
  }, [
    cvReady,
    capturedImage,
    debugMode,
    matchMethod,
    matchThreshold,
    rotationRange,
    scaleRange,
    shearRange,
    compareResolution,
    hitLimit,
    rectifyMode,
    selectedSampleId,
    samples,
  ]);

  const handleMissingToggle = () => {
    const next = !missingOn;
    setMissingOn(next);
    localStorage.setItem(MISSING_KEY, String(next));
  };

  const canAdd = useMemo(() => samples.length < MAX_SAMPLES, [samples.length]);

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <Script
        src="/opencv/opencv.js"
        strategy="afterInteractive"
        onLoad={() => setCvStatus("script.onload 発火")}
        onError={() => {
          setCvReady(false);
          setCvError("OpenCVの読み込みに失敗しました");
        }}
      />

      <div className="fixed right-2 bottom-2 z-[9999] text-[10px] px-2 py-1 rounded bg-black/70 text-zinc-300 border border-white/10 pointer-events-none">
        {REVIEW_VERSION}
      </div>

      <div className="px-4 pt-4 pb-3 border-b border-zinc-800 bg-zinc-950 space-y-3">
        <div className="flex items-center gap-3">
          <div className="text-sm text-zinc-300 shrink-0">感度</div>
          <input
            type="range"
            min={0}
            max={100}
            value={draftSensitivity}
            onChange={(e) => setDraftSensitivity(Number(e.target.value))}
            className="flex-1"
          />
          <div className="text-sm w-9 text-right text-zinc-300">{draftSensitivity}</div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-sm text-zinc-300 shrink-0">しきい値</div>
          <input
            type="range"
            min={0}
            max={0.99}
            step={0.01}
            value={matchThreshold}
            onChange={(e) => setMatchThreshold(Number(e.target.value))}
            className="flex-1"
          />
          <div className="text-sm w-12 text-right text-zinc-300">
            {matchThreshold.toFixed(2)}
          </div>
        </div>

        <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-sm">欠落候補</div>
          <button
            onClick={handleMissingToggle}
            className={`w-14 h-8 rounded-full transition ${missingOn ? "bg-rose-500" : "bg-zinc-700"}`}
          >
            <span
              className={`block w-6 h-6 bg-white rounded-full transition translate-y-1 ${
                missingOn ? "translate-x-7" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <div className="text-xs text-zinc-400">{cvStatus}</div>
        {cvError ? <div className="text-xs text-rose-400">{cvError}</div> : null}
      </div>

      <div className="px-4 pt-3 space-y-2">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {DEBUG_MODES.map((mode) => (
            <button
              key={mode}
              onClick={() => setDebugMode(mode)}
              className={`px-3 py-1.5 rounded-full text-xs border whitespace-nowrap ${
                debugMode === mode
                  ? "bg-white text-black border-white"
                  : "bg-zinc-900 text-zinc-300 border-zinc-700"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {MATCH_METHODS.map((mode) => (
            <button
              key={mode}
              onClick={() => setMatchMethod(mode)}
              className={`px-3 py-1.5 rounded-full text-xs border whitespace-nowrap ${
                matchMethod === mode
                  ? "bg-emerald-300 text-black border-emerald-300"
                  : "bg-zinc-900 text-zinc-300 border-zinc-700"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {ROTATION_RANGE_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => setRotationRange(v)}
              className={`px-3 py-1.5 rounded-full text-xs border whitespace-nowrap ${
                rotationRange === v
                  ? "bg-sky-300 text-black border-sky-300"
                  : "bg-zinc-900 text-zinc-300 border-zinc-700"
              }`}
            >
              {v === 0 ? "ROT 0°" : `ROT ±${v}°`}
            </button>
          ))}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {SCALE_RANGE_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => setScaleRange(v)}
              className={`px-3 py-1.5 rounded-full text-xs border whitespace-nowrap ${
                scaleRange === v
                  ? "bg-amber-300 text-black border-amber-300"
                  : "bg-zinc-900 text-zinc-300 border-zinc-700"
              }`}
            >
              {v === 0 ? "SCALE 0%" : `SCALE ±${v}%`}
            </button>
          ))}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {SHEAR_RANGE_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => setShearRange(v)}
              className={`px-3 py-1.5 rounded-full text-xs border whitespace-nowrap ${
                shearRange === v
                  ? "bg-violet-300 text-black border-violet-300"
                  : "bg-zinc-900 text-zinc-300 border-zinc-700"
              }`}
            >
              {v === 0 ? "SHEAR 0%" : `SHEAR ±${v}%`}
            </button>
          ))}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {RESOLUTION_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => setCompareResolution(v)}
              className={`px-3 py-1.5 rounded-full text-xs border whitespace-nowrap ${
                compareResolution === v
                  ? "bg-teal-300 text-black border-teal-300"
                  : "bg-zinc-900 text-zinc-300 border-zinc-700"
              }`}
            >
              {v}
            </button>
          ))}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {HIT_LIMIT_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => setHitLimit(v)}
              className={`px-3 py-1.5 rounded-full text-xs border whitespace-nowrap ${
                hitLimit === v
                  ? "bg-rose-300 text-black border-rose-300"
                  : "bg-zinc-900 text-zinc-300 border-zinc-700"
              }`}
            >
              {v === 9999 ? "MAX" : `${v}`}
            </button>
          ))}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {RECTIFY_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => setRectifyMode(v)}
              className={`px-3 py-1.5 rounded-full text-xs border whitespace-nowrap ${
                rectifyMode === v
                  ? "bg-lime-300 text-black border-lime-300"
                  : "bg-zinc-900 text-zinc-300 border-zinc-700"
              }`}
            >
              {v === "OFF" ? "RECT OFF" : "RECT ON"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 p-4 space-y-4">
        <div
          ref={frameRef}
          className="w-full rounded-[1.5rem] border border-zinc-800 bg-zinc-900 relative overflow-hidden mx-auto flex items-center justify-center"
          style={{ height: "min(64vh, 72vw, 760px)" }}
        >
          {mainPreviewUrl ? (
            <>
              <img
                src={mainPreviewUrl}
                alt="撮影画像"
                className="absolute block"
                style={{
                  left: imageRect.left,
                  top: imageRect.top,
                  width: imageRect.width,
                  height: imageRect.height,
                  objectFit: "fill",
                }}
              />

              {matchBoxes.map((box, i) => (
                <div
                  key={`${i}-${box.x}-${box.y}-${box.score}-${box.rotationDeg}-${box.scaleFactor}-${box.shearFactor}`}
                  className="absolute border-[3px] rounded-md pointer-events-none"
                  style={{
                    left: imageRect.left + imageRect.width * box.x,
                    top: imageRect.top + imageRect.height * box.y,
                    width: imageRect.width * box.w,
                    height: imageRect.height * box.h,
                    borderColor: colorFromIndex(i),
                  }}
                  title={box.label}
                />
              ))}

              {buildingPreview ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/45">
                  <div className="px-5 py-3 rounded-2xl border border-white/15 bg-black/55 text-center">
                    <div className="text-lg font-semibold">{debugMode}</div>
                    <div className="mt-1 text-sm text-zinc-300">変換中...</div>
                  </div>
                </div>
              ) : null}

              <div className="absolute left-3 bottom-3 text-[10px] bg-black/70 px-2 py-1 rounded border border-white/10">
                {`MAIN: ${debugMode}`}
              </div>

              <div className="absolute right-3 bottom-3 text-[10px] bg-black/70 px-2 py-1 rounded border border-white/10">
                {`${matchMethod} / hits ${matchBoxes.length}`}
              </div>
            </>
          ) : (
            <div className="text-zinc-400">まだ撮影画像がありません</div>
          )}
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3">
          <div className="text-sm text-zinc-300 mb-2">
            選択中の見本: {selectedSampleId ? selectedSampleId : "なし"}
          </div>
          <div className="w-full h-36 rounded-xl border border-zinc-800 bg-zinc-900 flex items-center justify-center overflow-hidden">
            {samplePreviewUrl ? (
              <img
                src={samplePreviewUrl}
                alt="見本プレビュー"
                className="max-w-full max-h-full object-contain block"
              />
            ) : (
              <div className="text-zinc-500 text-sm">
                見本サムネイルをタップするとここに表示
              </div>
            )}
          </div>
          <div className="mt-2 text-[11px] text-zinc-400">
            SAMPLE: {debugMode}
          </div>

          {matchBoxes.length > 0 ? (
            <div className="mt-3 max-h-32 overflow-auto text-[11px] space-y-1 text-zinc-300">
              {matchBoxes.slice(0, 12).map((box, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span
                    className="inline-block w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: colorFromIndex(i) }}
                  />
                  <span className="truncate">
                    {box.label} / score {box.score.toFixed(3)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="px-4 pb-3">
        <div className="grid grid-cols-3 gap-3">
          {samples.map((sample) => {
            const ratio =
              sample.aspectRatio && sample.aspectRatio > 0 ? sample.aspectRatio : 1;
            const thumbW = Math.max(40, Math.min(72, Math.round(40 * ratio)));
            const selected = selectedSampleId === sample.id;

            return (
              <div key={sample.id} className="relative overflow-visible isolate">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedSampleId((prev) => (prev === sample.id ? null : sample.id));
                  }}
                  className={`w-full rounded-2xl border px-2 py-2 flex items-center gap-2 min-w-0 ${
                    selected ? "border-white bg-zinc-800" : "border-zinc-800 bg-zinc-900"
                  }`}
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
                    <div className="w-10 h-10 rounded-lg border shrink-0 bg-zinc-700" />
                  )}

                  <div className="min-w-0 flex flex-col items-start">
                    <div className="text-sm font-semibold truncate">
                      {selected ? "SELECTED" : "SAMPLE"}
                    </div>
                    <div className="text-[10px] leading-none text-zinc-400 mt-1">
                      TAP TO PREVIEW
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowDeleteFor(showDeleteFor === sample.id ? null : sample.id);
                  }}
                  className="absolute top-1 right-1 z-40 w-7 h-7 rounded-full bg-black/60 border border-white/10 text-white"
                  aria-label="削除メニュー"
                >
                  …
                </button>

                {showDeleteFor === sample.id && (
                  <div className="absolute top-10 right-1 z-50">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (window.confirm("削除しますか？")) {
                          setSamples((prev) => prev.filter((s) => s.id !== sample.id));
                          setShowDeleteFor(null);
                          if (selectedSampleId === sample.id) {
                            setSelectedSampleId(null);
                            setSamplePreviewUrl("");
                            setMatchBoxes([]);
                          }
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