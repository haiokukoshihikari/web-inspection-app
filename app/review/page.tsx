"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";

declare global {
  interface Window {
    cv?: any;
  }
}

const REVIEW_VERSION = "review-stable-12";

const MAX_SAMPLES = 6;
const MISSING_KEY = "inspection:missingOn";
const SAMPLES_KEY = "inspection:samples";
const BASE_THRESHOLD_KEY = "inspection:baseThreshold";
const SENSITIVITY_KEY = "inspection:sensitivity";
const ROTATION_RANGE_KEY = "inspection:rotationRange";
const SCALE_RANGE_KEY = "inspection:scaleRange";
const SHEAR_RANGE_KEY = "inspection:shearRange";
const RESOLUTION_KEY = "inspection:compareResolution";
const HIT_LIMIT_KEY = "inspection:hitLimit";
const AUTO_SAVE_KEY = "inspection:autoSaveOn";
const MISSING_CANDIDATE_THRESHOLD_KEY = "inspection:missingCandidateThreshold";
const PENDING_SELECTED_SAMPLE_ID_KEY = "inspection:pendingSelectedSampleId";
const PROFILE_EXPORT_COUNTER_PREFIX = "inspection:profileExportCounter:";

const UI_THRESHOLD_MIN = 0.25;
const UI_THRESHOLD_MAX = 0.74;

type DebugViewMode = "ORIGINAL" | "EDGE";
type MatchMethodMode = "CCOEFF" | "CCORR" | "SQDIFF";
type RotationRangeMode = 0 | 3 | 6 | 9;
type ScaleRangeMode = 0 | 5 | 10;
type ShearRangeMode = 0 | 5 | 10;
type CompareResolutionMode = 1200 | 1600 | 2000 | 2400;
type HitLimitMode = 30 | 60 | 100 | 300 | 9999;

type SampleItem = {
  id: string;
  count: number;
  color: string;
  thumbUrl?: string;
  compareUrl?: string;
  aspectRatio?: number;
  savedResolution?: CompareResolutionMode;
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

type GridPoint = {
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;
};

type CandidateBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
};

type LinePoint = {
  x: number;
  y: number;
};

type GridModel = {
  points: GridPoint[];
  rowLines: LinePoint[][];
  colLines: LinePoint[][];
};

type CaptureDebugInfo = {
  sourceType: "camera" | "file";
  originalWidth: number;
  originalHeight: number;
  storedWidth: number;
  storedHeight: number;
  quality: number;
  dataUrlLength: number;
};

const DEBUG_MODES: DebugViewMode[] = ["ORIGINAL", "EDGE"];
const ROTATION_RANGE_OPTIONS: RotationRangeMode[] = [0, 3, 6, 9];
const SCALE_RANGE_OPTIONS: ScaleRangeMode[] = [0, 5, 10];
const SHEAR_RANGE_OPTIONS: ShearRangeMode[] = [0, 5, 10];
const RESOLUTION_OPTIONS: CompareResolutionMode[] = [1200, 1600, 2000, 2400];
const HIT_LIMIT_OPTIONS: HitLimitMode[] = [30, 60, 100, 300, 9999];

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function clamp01(v: number) {
  return clamp(v, 0, 1);
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function colorFromIndex(index: number) {
  const colors = ["#38bdf8", "#34d399", "#f59e0b", "#d946ef", "#06b6d4", "#fb7185"];
  return colors[index % colors.length];
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
) {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;

  const overlapW = Math.min(ax2, bx2) - Math.max(a.x, b.x);
  const overlapH = Math.min(ay2, by2) - Math.max(a.y, b.y);
  return overlapW > 0 && overlapH > 0;
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

function buildProcessedGrayMat(cv: any, srcMat: any, mode: DebugViewMode): any {
  let gray: any = null;
  let work1: any = null;
  let work2: any = null;

  try {
    gray = new cv.Mat();
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);

    if (mode === "ORIGINAL") {
      return gray.clone();
    }

    work1 = new cv.Mat();
    cv.GaussianBlur(gray, work1, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
    work2 = new cv.Mat();
    cv.Canny(work1, work2, 60, 180);
    return work2.clone();
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

function runStrongMatches(params: {
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

    const allStrong: MatchBox[] = [];
    const rotationValues = getRotationValues(rotationRange);
    const scaleValues = getScaleValues(scaleRange);
    const shearValues = getShearValues(shearRange);
    const localMaxCount = hitLimit === 9999 ? 300 : Math.max(50, Math.min(hitLimit * 4, 240));

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

              allStrong.push({
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

    allStrong.sort((a, b) => b.score - a.score);

    const strongDeduped: MatchBox[] = [];
    for (const box of allStrong) {
      const overlapped = strongDeduped.some((d) => rectsOverlap(box, d));
      if (!overlapped) strongDeduped.push(box);
      if (strongDeduped.length >= hitLimit) break;
    }

    return strongDeduped;
  } finally {
    try {
      sceneGray?.delete?.();
      sampleGray?.delete?.();
    } catch {}
  }
}


function clusterAxis(values: number[], tolerance: number) {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const lastGroup = groups[groups.length - 1];
    const center = lastGroup.reduce((s, v) => s + v, 0) / lastGroup.length;

    if (Math.abs(current - center) <= tolerance) lastGroup.push(current);
    else groups.push([current]);
  }

  return groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

function nearestIndex(values: number[], target: number) {
  if (values.length === 0) return -1;
  let best = 0;
  let bestDist = Math.abs(values[0] - target);
  for (let i = 1; i < values.length; i++) {
    const d = Math.abs(values[i] - target);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

function uniqueSortedLine(points: LinePoint[], axis: "x" | "y") {
  const sorted = [...points].sort((a, b) => (axis === "x" ? a.x - b.x : a.y - b.y));
  const out: LinePoint[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (!last) {
      out.push(p);
      continue;
    }
    const same =
      axis === "x"
        ? Math.abs(last.x - p.x) < 0.0001 && Math.abs(last.y - p.y) < 0.0001
        : Math.abs(last.y - p.y) < 0.0001 && Math.abs(last.x - p.x) < 0.0001;
    if (!same) out.push(p);
  }
  return out;
}

function interpolateYAtX(line: LinePoint[], targetX: number) {
  if (line.length === 0) return 0;
  if (line.length === 1) return line[0].y;

  const sorted = uniqueSortedLine(line, "x");
  if (targetX <= sorted[0].x) {
    const a = sorted[0];
    const b = sorted[Math.min(1, sorted.length - 1)];
    const dx = b.x - a.x;
    if (Math.abs(dx) < 1e-6) return a.y;
    const t = (targetX - a.x) / dx;
    return a.y + (b.y - a.y) * t;
  }

  const last = sorted.length - 1;
  if (targetX >= sorted[last].x) {
    const a = sorted[Math.max(0, last - 1)];
    const b = sorted[last];
    const dx = b.x - a.x;
    if (Math.abs(dx) < 1e-6) return b.y;
    const t = (targetX - a.x) / dx;
    return a.y + (b.y - a.y) * t;
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (targetX >= a.x && targetX <= b.x) {
      const dx = b.x - a.x;
      if (Math.abs(dx) < 1e-6) return (a.y + b.y) / 2;
      const t = (targetX - a.x) / dx;
      return a.y + (b.y - a.y) * t;
    }
  }

  return sorted[0].y;
}

function interpolateXAtY(line: LinePoint[], targetY: number) {
  if (line.length === 0) return 0;
  if (line.length === 1) return line[0].x;

  const sorted = uniqueSortedLine(line, "y");
  if (targetY <= sorted[0].y) {
    const a = sorted[0];
    const b = sorted[Math.min(1, sorted.length - 1)];
    const dy = b.y - a.y;
    if (Math.abs(dy) < 1e-6) return a.x;
    const t = (targetY - a.y) / dy;
    return a.x + (b.x - a.x) * t;
  }

  const last = sorted.length - 1;
  if (targetY >= sorted[last].y) {
    const a = sorted[Math.max(0, last - 1)];
    const b = sorted[last];
    const dy = b.y - a.y;
    if (Math.abs(dy) < 1e-6) return b.x;
    const t = (targetY - a.y) / dy;
    return a.x + (b.x - a.x) * t;
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (targetY >= a.y && targetY <= b.y) {
      const dy = b.y - a.y;
      if (Math.abs(dy) < 1e-6) return (a.x + b.x) / 2;
      const t = (targetY - a.y) / dy;
      return a.x + (b.x - a.x) * t;
    }
  }

  return sorted[0].x;
}

function buildGridModelFromStrong(strongBoxes: MatchBox[]): GridModel {
  if (strongBoxes.length < 4) {
    return { points: [], rowLines: [], colLines: [] };
  }

  const centers = strongBoxes.map((b) => ({
    cx: b.x + b.w / 2,
    cy: b.y + b.h / 2,
    w: b.w,
    h: b.h,
  }));

  const medianW = median(centers.map((c) => c.w));
  const medianH = median(centers.map((c) => c.h));
  if (!medianW || !medianH) {
    return { points: [], rowLines: [], colLines: [] };
  }

  const rowCenters = clusterAxis(centers.map((c) => c.cy), medianH * 0.7);
  const colCenters = clusterAxis(centers.map((c) => c.cx), medianW * 0.7);
  if (rowCenters.length < 2 || colCenters.length < 2) {
    return { points: [], rowLines: [], colLines: [] };
  }

  const rowBuckets: LinePoint[][] = rowCenters.map(() => []);
  const colBuckets: LinePoint[][] = colCenters.map(() => []);

  for (const c of centers) {
    const rowIdx = nearestIndex(rowCenters, c.cy);
    const colIdx = nearestIndex(colCenters, c.cx);
    if (rowIdx >= 0) rowBuckets[rowIdx].push({ x: c.cx, y: c.cy });
    if (colIdx >= 0) colBuckets[colIdx].push({ x: c.cx, y: c.cy });
  }

  const rowLines = rowBuckets
    .map((row) => uniqueSortedLine(row, "x"))
    .filter((row) => row.length >= 2);

  const colLines = colBuckets
    .map((col) => uniqueSortedLine(col, "y"))
    .filter((col) => col.length >= 2);

  if (rowLines.length < 2 || colLines.length < 2) {
    return { points: [], rowLines, colLines };
  }

  const colAnchors = colLines.map((line) => median(line.map((p) => p.x)));
  const rowAnchors = rowLines.map((line) => median(line.map((p) => p.y)));

  const points: GridPoint[] = [];
  for (let r = 0; r < rowLines.length; r++) {
    for (let c = 0; c < colLines.length; c++) {
      const targetX = colAnchors[c];
      const targetY = rowAnchors[r];
      const y = interpolateYAtX(rowLines[r], targetX);
      const x = interpolateXAtY(colLines[c], targetY);

      points.push({
        cx: clamp01(x),
        cy: clamp01(y),
        w: medianW,
        h: medianH,
        score: 0,
      });
    }
  }

  return { points, rowLines, colLines };
}

function findExistenceForGridPoint(point: GridPoint, strongBoxes: MatchBox[]) {
  return strongBoxes.some((b) => {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return (
      Math.abs(cx - point.cx) <= point.w * 0.45 &&
      Math.abs(cy - point.cy) <= point.h * 0.45
    );
  });
}

function sampleGridPointScore(
  cv: any,
  sceneProcessedGray: any,
  sampleProcessedGray: any,
  point: GridPoint
) {
  const sceneW = sceneProcessedGray.cols;
  const sceneH = sceneProcessedGray.rows;
  const tplW = sampleProcessedGray.cols;
  const tplH = sampleProcessedGray.rows;

  if (tplW >= sceneW || tplH >= sceneH) return 0;

  const cxPx = Math.round(point.cx * sceneW);
  const cyPx = Math.round(point.cy * sceneH);

  const x = clamp(Math.round(cxPx - tplW / 2), 0, Math.max(0, sceneW - tplW));
  const y = clamp(Math.round(cyPx - tplH / 2), 0, Math.max(0, sceneH - tplH));

  const roiRect = new cv.Rect(x, y, tplW, tplH);
  const roi = sceneProcessedGray.roi(roiRect);
  const result = new cv.Mat();

  try {
    cv.matchTemplate(roi, sampleProcessedGray, result, cv.TM_CCOEFF_NORMED);
    const mm = cv.minMaxLoc(result);
    return mm.maxVal;
  } finally {
    roi.delete();
    result.delete();
  }
}


export default function ReviewPage() {
  const router = useRouter();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const prevResolutionRef = useRef<CompareResolutionMode | null>(null);
  const thresholdApplyTimerRef = useRef<number | null>(null);

  const [capturedImage, setCapturedImage] = useState("");
  const [captureDebugInfo, setCaptureDebugInfo] = useState<CaptureDebugInfo | null>(null);

  const [missingOn, setMissingOn] = useState(true);
  const [missingCandidateThreshold, setMissingCandidateThreshold] = useState(0.3);
  const [showDeleteFor, setShowDeleteFor] = useState<string | null>(null);
  const [samplesLoaded, setSamplesLoaded] = useState(false);

  const [samples, setSamples] = useState<SampleItem[]>([]);

  const [cvReady, setCvReady] = useState(false);
  const [cvError, setCvError] = useState("");
  const [cvStatus, setCvStatus] = useState("OpenCV 未読込");

  const [debugMode, setDebugMode] = useState<DebugViewMode>("ORIGINAL");
  const matchMethod: MatchMethodMode = "CCOEFF";
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);

  const [mainPreviewUrl, setMainPreviewUrl] = useState("");
  const [samplePreviewUrl, setSamplePreviewUrl] = useState("");
  const [buildingPreview, setBuildingPreview] = useState(false);
  const [pendingRecheck, setPendingRecheck] = useState(false);
  const [matchBoxes, setMatchBoxes] = useState<MatchBox[]>([]);
  const [gridPoints, setGridPoints] = useState<GridPoint[]>([]);
  const [rowLines, setRowLines] = useState<LinePoint[][]>([]);
  const [colLines, setColLines] = useState<LinePoint[][]>([]);
  const [candidatePoints, setCandidatePoints] = useState<CandidateBox[]>([]);
  const [missingCandidates, setMissingCandidates] = useState<CandidateBox[]>([]);

  const [baseThreshold, setBaseThreshold] = useState(0.5);
  const [matchThreshold, setMatchThreshold] = useState(0.5);
  const [draftThreshold, setDraftThreshold] = useState(0.5);
  const [sensitivity, setSensitivity] = useState(50);
  const [draftMissingCandidateThreshold, setDraftMissingCandidateThreshold] = useState(0.3);
  const [appliedMissingCandidateThreshold, setAppliedMissingCandidateThreshold] = useState(0.3);

  const [rotationRange, setRotationRange] = useState<RotationRangeMode>(0);
  const [scaleRange, setScaleRange] = useState<ScaleRangeMode>(0);
  const [shearRange, setShearRange] = useState<ShearRangeMode>(0);
  const [compareResolution, setCompareResolution] = useState<CompareResolutionMode>(1200);
  const [hitLimit, setHitLimit] = useState<HitLimitMode>(30);

  const [autoSaveOn, setAutoSaveOn] = useState(false);
  const [savingOnLeave, setSavingOnLeave] = useState(false);
  const [saveLeavingMessage, setSaveLeavingMessage] = useState("");

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

      const debugRaw = sessionStorage.getItem("captureDebugInfo");
      if (debugRaw) {
        const parsed = JSON.parse(debugRaw) as CaptureDebugInfo;
        setCaptureDebugInfo(parsed);
      }

      const savedMissing = localStorage.getItem(MISSING_KEY);
      if (savedMissing !== null) setMissingOn(savedMissing === "true");

      const savedCandidateThreshold = localStorage.getItem(MISSING_CANDIDATE_THRESHOLD_KEY);
      if (savedCandidateThreshold !== null) {
        const n = Number(savedCandidateThreshold);
        if (Number.isFinite(n)) {
          const nextCandidateThreshold = clamp(Number(n.toFixed(2)), 0.05, 0.95);
          setDraftMissingCandidateThreshold(nextCandidateThreshold);
          setAppliedMissingCandidateThreshold(nextCandidateThreshold);
        }
      }

      const savedAutoSave = localStorage.getItem(AUTO_SAVE_KEY);
      if (savedAutoSave !== null) setAutoSaveOn(savedAutoSave === "true");

      const savedSamples = localStorage.getItem(SAMPLES_KEY);
      if (savedSamples) {
        const parsed = JSON.parse(savedSamples);
        if (Array.isArray(parsed)) {
          setSamples(parsed);
          const pendingSelectedId = sessionStorage.getItem(PENDING_SELECTED_SAMPLE_ID_KEY);
          if (pendingSelectedId && parsed.some((item: SampleItem) => item.id === pendingSelectedId)) {
            setSelectedSampleId(pendingSelectedId);
            sessionStorage.removeItem(PENDING_SELECTED_SAMPLE_ID_KEY);
          }
        }
      }

      const savedBaseThreshold = localStorage.getItem(BASE_THRESHOLD_KEY);
      const savedSensitivity = localStorage.getItem(SENSITIVITY_KEY);

      let initialBaseThreshold = 0.5;
      if (savedBaseThreshold !== null) {
        const n = Number(savedBaseThreshold);
        if (Number.isFinite(n)) {
          initialBaseThreshold = clamp(n, UI_THRESHOLD_MIN, UI_THRESHOLD_MAX);
        }
      }

      let initialSensitivity = 50;
      if (savedSensitivity !== null) {
        const n = Number(savedSensitivity);
        if (Number.isFinite(n)) initialSensitivity = clamp(Math.round(n), 0, 100);
      }

      const initialThreshold = clamp(
        Number((initialBaseThreshold - (initialSensitivity - 50) * 0.005).toFixed(3)),
        0,
        0.99
      );

      setBaseThreshold(initialBaseThreshold);
      setDraftThreshold(initialBaseThreshold);
      setSensitivity(initialSensitivity);
      setMatchThreshold(initialThreshold);

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
    } catch {}

    setSamplesLoaded(true);
  }, []);

  useEffect(() => {
    if (!samplesLoaded) return;
    localStorage.setItem(SAMPLES_KEY, JSON.stringify(samples));
  }, [samples, samplesLoaded]);

  useEffect(() => {
    localStorage.setItem(MISSING_CANDIDATE_THRESHOLD_KEY, String(appliedMissingCandidateThreshold));
  }, [appliedMissingCandidateThreshold]);

  useEffect(() => {
    if (!samplesLoaded) return;

    if (prevResolutionRef.current === null) {
      prevResolutionRef.current = compareResolution;
      return;
    }

    if (prevResolutionRef.current !== compareResolution) {
      setSamples([]);
      setSelectedSampleId(null);
      setSamplePreviewUrl("");
      setMatchBoxes([]);
      setGridPoints([]);
      setRowLines([]);
      setColLines([]);
      setCandidatePoints([]);
      setMissingCandidates([]);
      localStorage.removeItem(SAMPLES_KEY);
      prevResolutionRef.current = compareResolution;
    }
  }, [compareResolution, samplesLoaded]);

  useEffect(() => {
    return () => {
      if (thresholdApplyTimerRef.current !== null) {
        window.clearTimeout(thresholdApplyTimerRef.current);
      }
    };
  }, []);

  const effectiveThresholdFrom = (base: number, sens: number) => {
    return clamp(Number((base - (sens - 50) * 0.005).toFixed(3)), 0, 0.99);
  };

  const scheduleRecheckApply = (
    nextBase: number,
    nextSensitivity: number,
    nextMissingCandidateThreshold: number
  ) => {
    if (thresholdApplyTimerRef.current !== null) {
      window.clearTimeout(thresholdApplyTimerRef.current);
    }

    setPendingRecheck(true);
    setBuildingPreview(false);

    thresholdApplyTimerRef.current = window.setTimeout(() => {
      const nextEffective = effectiveThresholdFrom(nextBase, nextSensitivity);
      setPendingRecheck(false);
      setBuildingPreview(true);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setMatchThreshold(nextEffective);
          setAppliedMissingCandidateThreshold(nextMissingCandidateThreshold);
        });
      });
    }, 1000);
  };

  const applyDirectThresholdChange = (nextThresholdRaw: number) => {
    const nextBase = clamp(Number(nextThresholdRaw.toFixed(2)), UI_THRESHOLD_MIN, UI_THRESHOLD_MAX);
    setDraftThreshold(nextBase);
    setBaseThreshold(nextBase);
    setSensitivity(50);
    scheduleRecheckApply(nextBase, 50, draftMissingCandidateThreshold);
  };

  const applySensitivityChange = (nextSensitivityRaw: number) => {
    const nextSensitivity = clamp(Math.round(nextSensitivityRaw), 0, 100);
    setSensitivity(nextSensitivity);
    scheduleRecheckApply(baseThreshold, nextSensitivity, draftMissingCandidateThreshold);
  };

  const applyMissingCandidateThresholdChange = (nextThresholdRaw: number) => {
    const nextThreshold = clamp(Number(nextThresholdRaw.toFixed(2)), 0.05, 0.95);
    setDraftMissingCandidateThreshold(nextThreshold);
    scheduleRecheckApply(baseThreshold, sensitivity, nextThreshold);
  };

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
  }, [mainPreviewUrl, displayBasis, matchBoxes, candidatePoints, missingCandidates, gridPoints, rowLines, colLines]);

  useEffect(() => {
    let cancelled = false;

    async function buildPreviewsAndMatch() {
      if (!cvReady || !capturedImage) return;
      const cv = window.cv;
      if (!cv) return;

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });

      let sceneMat: any = null;
      let sceneProcessedGray: any = null;
      let sampleMat: any = null;
      let sampleProcessedGray: any = null;

      try {
        const loadedScene = await imageSrcToMat(cv, capturedImage, compareResolution);
        if (!loadedScene) return;

        sceneMat = loadedScene.srcMat;

        if (cancelled) return;

        setDisplayBasis({ width: sceneMat.cols, height: sceneMat.rows });
        setMainPreviewUrl(
          debugMode === "ORIGINAL"
            ? matToDataUrl(cv, sceneMat)
            : buildDebugImageFromSrcMat(cv, sceneMat, debugMode)
        );

        const sample = samples.find(
          (s) =>
            s.id === selectedSampleId &&
            !!s.compareUrl &&
            s.savedResolution === compareResolution
        );

        if (!sample) {
          setSamplePreviewUrl("");
          setMatchBoxes([]);
          setGridPoints([]);
          setRowLines([]);
          setColLines([]);
          setCandidatePoints([]);
          setMissingCandidates([]);
          return;
        }

        const loadedSample = await imageSrcToMat(cv, sample.compareUrl!, compareResolution);
        if (!loadedSample) {
          setSamplePreviewUrl("");
          setMatchBoxes([]);
          setGridPoints([]);
          setRowLines([]);
          setColLines([]);
          setCandidatePoints([]);
          setMissingCandidates([]);
          return;
        }

        sampleMat = loadedSample.srcMat;

        setSamplePreviewUrl(
          debugMode === "ORIGINAL"
            ? sample.compareUrl!
            : buildDebugImageFromSrcMat(cv, sampleMat, debugMode)
        );

        const strong = runStrongMatches({
          cv,
          sceneSrcMat: sceneMat,
          sampleSrcMat: sampleMat,
          sceneWidth: sceneMat.cols,
          sceneHeight: sceneMat.rows,
          debugMode,
          matchMode: matchMethod,
          threshold: matchThreshold,
          rotationRange,
          scaleRange,
          shearRange,
          hitLimit,
        });

        sceneProcessedGray = buildProcessedGrayMat(cv, sceneMat, debugMode);
        sampleProcessedGray = buildProcessedGrayMat(cv, sampleMat, debugMode);

        const gridModel = buildGridModelFromStrong(strong);
        const grid = gridModel.points;
        const candidateBoxes: CandidateBox[] = [];
        const missingBoxes: CandidateBox[] = [];

        for (const gp of grid) {
          const score = sampleGridPointScore(cv, sceneProcessedGray, sampleProcessedGray, gp);
          const pointWithScore: GridPoint = { ...gp, score };
          const exists = findExistenceForGridPoint(pointWithScore, strong);

          const box: CandidateBox = {
            x: clamp01(pointWithScore.cx - pointWithScore.w / 2),
            y: clamp01(pointWithScore.cy - pointWithScore.h / 2),
            w: clamp01(pointWithScore.w),
            h: clamp01(pointWithScore.h),
            score,
          };

          if (box.x + box.w > 1) box.x = Math.max(0, 1 - box.w);
          if (box.y + box.h > 1) box.y = Math.max(0, 1 - box.h);

          if (exists) continue;
          if (score >= appliedMissingCandidateThreshold && score < matchThreshold) {
            candidateBoxes.push(box);
          } else {
            missingBoxes.push(box);
          }
        }

        if (!cancelled) {
          setMatchBoxes(strong);
          setGridPoints(grid);
          setRowLines(gridModel.rowLines);
          setColLines(gridModel.colLines);
          setCandidatePoints(candidateBoxes);
          setMissingCandidates(missingOn ? missingBoxes : []);
        }
      } catch (e) {
        console.error(e);
      } finally {
        try {
          sceneMat?.delete?.();
          sceneProcessedGray?.delete?.();
          sampleMat?.delete?.();
          sampleProcessedGray?.delete?.();
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
    matchThreshold,
    appliedMissingCandidateThreshold,
    rotationRange,
    scaleRange,
    shearRange,
    compareResolution,
    hitLimit,
    selectedSampleId,
    samples,
    missingOn,
  ]);

  
const drawPolylineCanvas = (
    ctx: CanvasRenderingContext2D,
    points: LinePoint[],
    width: number,
    height: number
  ) => {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x * width, points[0].y * height);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x * width, points[i].y * height);
    }
    ctx.stroke();
  };

  const polylineToSvgPoints = (points: LinePoint[]) =>
    points.map((p) => `${p.x * imageRect.width},${p.y * imageRect.height}`).join(" ");

  const handleMissingToggle = () => {
    const next = !missingOn;
    setMissingOn(next);
    localStorage.setItem(MISSING_KEY, String(next));
  };

  const adjustDraftThreshold = (delta: number) => {
    applyDirectThresholdChange(draftThreshold + delta);
  };

  const adjustSensitivity = (delta: number) => {
    applySensitivityChange(sensitivity + delta);
  };

  const adjustMissingCandidateThreshold = (delta: number) => {
    applyMissingCandidateThresholdChange(draftMissingCandidateThreshold + delta);
  };

  const reversedDraftThreshold = UI_THRESHOLD_MAX + UI_THRESHOLD_MIN - draftThreshold;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  const dataUrlToFile = async (dataUrl: string, filename: string) => {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return new File([blob], filename, {
      type: blob.type || "image/jpeg",
      lastModified: Date.now(),
    });
  };

  const downloadDataUrl = async (dataUrl: string, filename: string) => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    await sleep(250);
  };

  const buildResultImageDataUrl = async () => {
    const baseSrc = mainPreviewUrl || capturedImage;
    if (!baseSrc) return "";

    const img = await loadImage(baseSrc);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    ctx.lineWidth = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) * 0.004));
    ctx.font = `${Math.max(18, Math.round(canvas.width * 0.018))}px sans-serif`;
    ctx.textBaseline = "top";

    matchBoxes.forEach((box, i) => {
      const x = Math.round(box.x * canvas.width);
      const y = Math.round(box.y * canvas.height);
      const w = Math.round(box.w * canvas.width);
      const h = Math.round(box.h * canvas.height);
      const color = colorFromIndex(i);

      ctx.strokeStyle = color;
      ctx.strokeRect(x, y, w, h);

      const label = `${i + 1}`;
      const padX = 8;
      const padY = 4;
      const textW = ctx.measureText(label).width;
      const boxW = Math.ceil(textW + padX * 2);
      const boxH = Math.ceil(parseInt(ctx.font, 10) + padY * 2);

      ctx.fillStyle = color;
      ctx.fillRect(x, Math.max(0, y - boxH), boxW, boxH);

      ctx.fillStyle = "#000";
      ctx.fillText(label, x + padX, Math.max(0, y - boxH) + padY);
    });

    if (missingOn) {
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 1;
      rowLines.forEach((line) => drawPolylineCanvas(ctx, line, canvas.width, canvas.height));
      colLines.forEach((line) => drawPolylineCanvas(ctx, line, canvas.width, canvas.height));

      ctx.setLineDash([10, 8]);
      ctx.lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.003));
      ctx.strokeStyle = "#fbbf24";
      candidatePoints.forEach((box) => {
        const x = Math.round(box.x * canvas.width);
        const y = Math.round(box.y * canvas.height);
        const w = Math.round(box.w * canvas.width);
        const h = Math.round(box.h * canvas.height);
        ctx.strokeRect(x, y, w, h);
      });

      ctx.strokeStyle = "#fb7185";
      missingCandidates.forEach((box) => {
        const x = Math.round(box.x * canvas.width);
        const y = Math.round(box.y * canvas.height);
        const w = Math.round(box.w * canvas.width);
        const h = Math.round(box.h * canvas.height);
        ctx.strokeRect(x, y, w, h);
      });

      ctx.setLineDash([]);
    }

    return canvas.toDataURL("image/jpeg", 0.92);
  };

  const handleLeaveWithAutoSave = async (path: string) => {
    if (savingOnLeave) return;

    if (!autoSaveOn || path !== "/camera") {
      router.push(path);
      return;
    }

    try {
      setSavingOnLeave(true);
      setSaveLeavingMessage("共有シートを準備しています");

      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
        now.getDate()
      ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
        now.getMinutes()
      ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;

      const files: File[] = [];

      if (capturedImage) {
        files.push(await dataUrlToFile(capturedImage, `inspection_raw_${stamp}.jpg`));
      }

      const resultDataUrl = await buildResultImageDataUrl();
      if (resultDataUrl) {
        files.push(await dataUrlToFile(resultDataUrl, `inspection_result_${stamp}.jpg`));
      }

      const nav = navigator as Navigator & {
        canShare?: (data?: ShareData) => boolean;
      };

      if (
        files.length > 0 &&
        typeof nav.share === "function" &&
        typeof nav.canShare === "function" &&
        nav.canShare({ files })
      ) {
        setSaveLeavingMessage("共有シートを開いています");
        await nav.share({
          files,
          title: "inspection images",
        });
        setSavingOnLeave(false);
        setSaveLeavingMessage("");
        router.push(path);
        return;
      }

      setSaveLeavingMessage("共有に未対応のため保存を試みています");

      if (capturedImage) {
        await downloadDataUrl(capturedImage, `inspection_raw_${stamp}.jpg`);
      }
      if (resultDataUrl) {
        await downloadDataUrl(resultDataUrl, `inspection_result_${stamp}.jpg`);
      }

      setSavingOnLeave(false);
      setSaveLeavingMessage("");
      await sleep(200);
      router.push(path);
    } catch (err: any) {
      console.error(err);

      if (err?.name === "AbortError") {
        setSavingOnLeave(false);
        setSaveLeavingMessage("");
        setSaveToast(null);
        return;
      }

      alert("画像保存に失敗しました。");
      setSavingOnLeave(false);
      setSaveLeavingMessage("");
      setSaveToast(null);
    }
  };


  const pad3 = (n: number) => String(n).padStart(3, "0");

  const nextProfileVersion = () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const datePart = `${y}${m}${d}`;
    const counterKey = `${PROFILE_EXPORT_COUNTER_PREFIX}${datePart}`;

    let next = 1;
    try {
      const raw = localStorage.getItem(counterKey);
      const parsed = raw ? Number(raw) : 0;
      if (Number.isFinite(parsed) && parsed > 0) next = parsed + 1;
      localStorage.setItem(counterKey, String(next));
    } catch {}

    return `${datePart}-${pad3(next)}`;
  };

  const handleExportProfile = () => {
    const nameInput = window.prompt("設定名を入力してください", "default");
    if (nameInput === null) return;

    const profileName = (nameInput || "default").trim() || "default";
    const version = nextProfileVersion();

    const profile = {
      profileName,
      version,
      baseThreshold: Number(baseThreshold.toFixed(2)),
      missingCandidateThreshold: Number(missingCandidateThreshold.toFixed(2)),
      rotationRange,
      scaleRange,
      shearRange,
      compareResolution,
      hitLimit,
    };

    const json = JSON.stringify(profile, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `inspection-profile-${profileName}-${version}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
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

        <div className="flex items-center gap-2">
          <div className="text-sm text-zinc-300 shrink-0">感度</div>

          <button
            onClick={() => adjustSensitivity(-1)}
            className="w-8 h-8 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200"
          >
            -
          </button>

          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={sensitivity}
            onChange={(e) => applySensitivityChange(Number(e.target.value))}
            className="flex-1"
          />

          <button
            onClick={() => adjustSensitivity(1)}
            className="w-8 h-8 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200"
          >
            +
          </button>

          <div className="text-sm w-10 text-right text-zinc-300">{sensitivity}</div>
        </div>

        <div className="flex items-center gap-2">
          <div className="text-sm text-zinc-300 shrink-0">しきい値</div>

          <button
            onClick={() => adjustDraftThreshold(-0.01)}
            className="w-8 h-8 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200"
          >
            -
          </button>

          <input
            type="range"
            min={UI_THRESHOLD_MIN}
            max={UI_THRESHOLD_MAX}
            step={0.01}
            value={reversedDraftThreshold}
            onChange={(e) => {
              const raw = Number(e.target.value);
              const restored = UI_THRESHOLD_MAX + UI_THRESHOLD_MIN - raw;
              applyDirectThresholdChange(restored);
            }}
            className="flex-1"
          />

          <button
            onClick={() => adjustDraftThreshold(0.01)}
            className="w-8 h-8 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200"
          >
            +
          </button>

          <div className="text-sm w-12 text-right text-zinc-300">
            {draftThreshold.toFixed(2)}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="text-sm text-zinc-300 shrink-0">欠落候補</div>

          <button
            onClick={() => adjustMissingCandidateThreshold(-0.01)}
            className="w-8 h-8 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200"
          >
            -
          </button>

          <input
            type="range"
            min={0.05}
            max={0.95}
            step={0.01}
            value={draftMissingCandidateThreshold}
            onChange={(e) =>
              applyMissingCandidateThresholdChange(Number(e.target.value))
            }
            className="flex-1"
          />

          <button
            onClick={() => adjustMissingCandidateThreshold(0.01)}
            className="w-8 h-8 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200"
          >
            +
          </button>

          <div className="text-sm w-12 text-right text-zinc-300">
            {draftMissingCandidateThreshold.toFixed(2)}
          </div>
        </div>

        <div className="text-[11px] text-zinc-500">
          {`しきい値 ${draftThreshold.toFixed(2)} / 感度 ${sensitivity} / 実適用 ${matchThreshold.toFixed(
            3
          )} / 候補点下限 ${draftMissingCandidateThreshold.toFixed(2)}`}
        </div>

        <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-sm">欠落候補</div>
          <button
            onClick={handleMissingToggle}
            className={`relative w-14 h-8 rounded-full transition ${missingOn ? "bg-rose-500" : "bg-zinc-700"}`}
          >
            <span
              className={`absolute top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white transition ${
                missingOn ? "left-7" : "left-1"
              }`}
            />
          </button>
        </div>

        <button
          onClick={handleExportProfile}
          className="w-full rounded-2xl border border-sky-400/30 bg-sky-500/10 px-4 py-3 text-sm font-medium text-sky-200"
        >
          設定を書き出す
        </button>

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

              {missingOn && (rowLines.length > 0 || colLines.length > 0) ? (
                <svg
                  className="absolute pointer-events-none"
                  style={{
                    left: imageRect.left,
                    top: imageRect.top,
                    width: imageRect.width,
                    height: imageRect.height,
                  }}
                  viewBox={`0 0 ${imageRect.width} ${imageRect.height}`}
                >
                  {rowLines.map((line, i) =>
                    line.length >= 2 ? (
                      <polyline
                        key={`row-line-${i}`}
                        points={polylineToSvgPoints(line)}
                        fill="none"
                        stroke="rgba(255,255,255,0.28)"
                        strokeWidth="1"
                      />
                    ) : null
                  )}
                  {colLines.map((line, i) =>
                    line.length >= 2 ? (
                      <polyline
                        key={`col-line-${i}`}
                        points={polylineToSvgPoints(line)}
                        fill="none"
                        stroke="rgba(255,255,255,0.28)"
                        strokeWidth="1"
                      />
                    ) : null
                  )}
                </svg>
              ) : null}

              {candidatePoints.map((box, i) => (
                <div
                  key={`candidate-${i}-${box.x}-${box.y}`}
                  className="absolute rounded-md pointer-events-none border-[2px] border-dashed border-amber-300"
                  style={{
                    left: imageRect.left + imageRect.width * box.x,
                    top: imageRect.top + imageRect.height * box.y,
                    width: imageRect.width * box.w,
                    height: imageRect.height * box.h,
                  }}
                  title={`候補点 ${box.score.toFixed(3)}`}
                />
              ))}

              {missingOn &&
                missingCandidates.map((box, i) => (
                  <div
                    key={`missing-${i}-${box.x}-${box.y}`}
                    className="absolute rounded-md pointer-events-none border-[3px] border-dashed border-rose-400"
                    style={{
                      left: imageRect.left + imageRect.width * box.x,
                      top: imageRect.top + imageRect.height * box.y,
                      width: imageRect.width * box.w,
                      height: imageRect.height * box.h,
                    }}
                    title={`欠落候補 ${box.score.toFixed(3)}`}
                  />
                ))}

              {pendingRecheck ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/35">
                  <div className="px-5 py-3 rounded-2xl border border-white/15 bg-black/70 text-center">
                    <div className="text-lg font-semibold">再検査待機中…</div>
                    <div className="mt-1 text-sm text-zinc-300">条件変更の確定待ちです</div>
                  </div>
                </div>
              ) : null}

              {buildingPreview ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
                  <div className="px-5 py-3 rounded-2xl border border-white/15 bg-black/70 text-center">
                    <div className="text-lg font-semibold">検査中…</div>
                    <div className="mt-1 text-sm text-zinc-300">条件変更を反映しています</div>
                  </div>
                </div>
              ) : null}

              <div className="absolute left-3 bottom-3 text-[10px] bg-black/70 px-2 py-1 rounded border border-white/10">
                {`MAIN: ${debugMode}`}
              </div>

              <div className="absolute right-3 bottom-3 text-[10px] bg-black/70 px-2 py-1 rounded border border-white/10">
                {`存在点 ${matchBoxes.length} / 格子点 ${gridPoints.length} / 候補点 ${candidatePoints.length} / 欠落候補 ${missingCandidates.length}`}
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

          <div className="mt-2 text-[11px] text-zinc-400">SAMPLE: {debugMode}</div>

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
            const ratio = sample.aspectRatio && sample.aspectRatio > 0 ? sample.aspectRatio : 1;
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

                {showDeleteFor === sample.id ? (
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
                            setGridPoints([]);
                            setCandidatePoints([]);
                            setMissingCandidates([]);
                          }
                        }
                      }}
                      className="w-10 h-10 rounded-full bg-rose-500 text-white shadow-lg flex items-center justify-center"
                      aria-label="見本を削除"
                    >
                      ×
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}

          {canAdd ? (
            <button
              onClick={() => router.push("/add-sample")}
              className="w-full h-14 rounded-2xl border border-dashed border-zinc-700 bg-zinc-900 text-2xl text-zinc-300"
            >
              +
            </button>
          ) : null}
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
            onClick={() => void handleLeaveWithAutoSave("/camera")}
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