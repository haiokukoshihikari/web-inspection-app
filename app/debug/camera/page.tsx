"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";


type SaveStep =
  | "idle"
  | "capture_start"
  | "canvas_create"
  | "canvas_draw"
  | "image_resize"
  | "dataurl_create"
  | "sessionstorage_save"
  | "navigate_review"
  | "done"
  | "error";

type InspectionProfile = {
  profileName: string;
  version: string;
  baseThreshold: number;
  missingCandidateThreshold: number;
  rotationRange: number;
  scaleRange: number;
  shearRange: number;
  compareResolution: number;
  hitLimit: number;
  liveGuideThresholdOffset?: number;
  liveGuideIntervalMs?: number;
  liveDistanceScaleOffsetPct?: number;
  liveDistanceMedianWindow?: number;
  liveDistanceHintConfirmCount?: number;
  liveBlueBandTolerancePct?: number;
  liveBlueBandCenterOffsetPct?: number;
  liveScaleOptions?: number[];
  liveRoiWidthRatio?: number;
  liveRoiHeightRatio?: number;
  
};

const PENDING_SHARED_PROFILE_KEY = "inspection:pendingSharedProfile";

const SAMPLES_KEY = "inspection:samples";
const CAPTURED_LIVE_FRAME_KEY = "capturedLiveFrameAtCapture";
const DEFAULT_LIVE_GUIDE_THRESHOLD_OFFSET = 0.12;
const DEFAULT_LIVE_GUIDE_INTERVAL_MS = 1500;
const LIVE_MAX_BOXES = 1;
const LIVE_PROCESS_LONG_SIDE = 960;
const LIVE_TEMPLATE_LONG_SIDE = 96;
const LIVE_SEARCH_STEP = 4;
const LIVE_SCALE_OPTIONS = [5, 10, 15, 20] as const;
const DEFAULT_LIVE_SCALE_OPTIONS = [5] as const;
const DISTANCE_GUIDE_BLUE_TOLERANCE_PCT = 3;
const DISTANCE_GUIDE_STEP1_PCT = 5;
const DISTANCE_GUIDE_STEP2_PCT = 10;
const DISTANCE_GUIDE_STEP3_PCT = 20;
const DISTANCE_GUIDE_STREAK_REQUIRED = 2;
const DISTANCE_GUIDE_SCALE_WEIGHT = 0.08;
const DISTANCE_GUIDE_SCORE_WEIGHT = 0.02;

type SampleItem = {
  id: string;
  count: number;
  color: string;
  thumbUrl?: string;
  compareUrl?: string;
  cameraCompareUrl?: string;
  aspectRatio?: number;
  savedResolution?: number;
  cameraBaseLongSide?: number;
  detectionSensitivity?: number;
  order?: number;
};

type LiveBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  matchW: number;
  matchH: number;
  score: number;
  sampleWidthPct: number;
  sampleHeightPct: number;
  rawHint: "near" | "far" | "neutral";
  scaleDeltaPct: number;
  centerDistanceNorm: number;
  priorityScore: number;
  distanceGuidePriority: number;
  inDistanceGuideCenterRoi: boolean;
};

type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type CameraDebugSnapshot = {
  collectedAt: string;
  trackLabel: string;
  settings: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  constraints: Record<string, unknown>;
  photoCapabilities: Record<string, unknown> | null;
  photoSettings: Record<string, unknown> | null;
  videoFrame?: { width: number; height: number };
  error?: string;
};

function formatCameraDebugValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return "-";
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>));
  }
}

function createCameraDebugSummary(snapshot: CameraDebugSnapshot | null): string {
  if (!snapshot) {
    return "focus:-\nmode:-\nzoom:-\nsize:-";
  }

  const settings = snapshot.settings || {};
  const capabilities = snapshot.capabilities || {};
  const photoSettings = snapshot.photoSettings || {};
  const photoCapabilities = snapshot.photoCapabilities || {};
  const focusDistance =
    settings.focusDistance ??
    photoSettings.focusDistance ??
    capabilities.focusDistance ??
    photoCapabilities.focusDistance;
  const focusMode =
    settings.focusMode ??
    photoSettings.focusMode ??
    capabilities.focusMode ??
    photoCapabilities.focusMode;
  const zoom = settings.zoom ?? photoSettings.zoom ?? capabilities.zoom ?? photoCapabilities.zoom;
  const width = settings.width ?? photoSettings.imageWidth ?? photoCapabilities.imageWidth;
  const height = settings.height ?? photoSettings.imageHeight ?? photoCapabilities.imageHeight;
  const videoSize = snapshot.videoFrame?.width && snapshot.videoFrame?.height
    ? `${snapshot.videoFrame.width}x${snapshot.videoFrame.height}`
    : "-";

  return [
    `focus:${formatCameraDebugValue(focusDistance)}`,
    `mode:${formatCameraDebugValue(focusMode)}`,
    `zoom:${formatCameraDebugValue(zoom)}`,
    `size:${formatCameraDebugValue(width)}x${formatCameraDebugValue(height)}`,
    `video:${videoSize}`,
  ].join("\n");
}

function calcContainRect(
  containerWidth: number,
  containerHeight: number,
  contentWidth: number,
  contentHeight: number
): Rect {
  if (!containerWidth || !containerHeight || !contentWidth || !contentHeight) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  const contentRatio = contentWidth / contentHeight;
  const containerRatio = containerWidth / containerHeight;

  let width = containerWidth;
  let height = containerHeight;

  if (contentRatio > containerRatio) {
    height = width / contentRatio;
  } else {
    width = height * contentRatio;
  }

  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  };
}


function isInspectionProfile(value: unknown): value is InspectionProfile {
  if (!value || typeof value !== "object") return false
  const data = value as Record<string, unknown>;
  return (
    typeof data.profileName === "string" &&
    typeof data.version === "string" &&
    typeof data.baseThreshold === "number" &&
    typeof data.missingCandidateThreshold === "number" &&
    typeof data.rotationRange === "number" &&
    typeof data.scaleRange === "number" &&
    typeof data.shearRange === "number" &&
    typeof data.compareResolution === "number" &&
    typeof data.hitLimit === "number"
  );
}


function sanitizeLiveScaleOptions(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_LIVE_SCALE_OPTIONS];
  const allowed = new Set<number>(LIVE_SCALE_OPTIONS as readonly number[]);
  const next = Array.from(
    new Set(
      value
        .map((item) => (typeof item === "number" && Number.isFinite(item) ? Math.round(item) : NaN))
        .filter((item) => Number.isFinite(item) && allowed.has(item as number))
    )
  ).sort((a, b) => a - b) as number[];
  return next.length > 0 ? next : [...DEFAULT_LIVE_SCALE_OPTIONS];
}

function sanitizeLiveRoiWidthRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(0.6, Math.max(0.1, Number(value.toFixed(2))));
}

function sanitizeLiveRoiHeightRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.3;
  return Math.min(0.4, Math.max(0.1, Number(value.toFixed(2))));
}

function sanitizeLiveDistanceScaleOffsetPct(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 7;
  return Math.min(20, Math.max(-20, Math.round(value)));
}

function sanitizeMedianWindow(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 5;
  return [9, 11, 13, 15].includes(n) ? n : 9;
}

function sanitizeGuideConfirmCount(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 2;
  return Math.min(3, Math.max(1, n));
}

function sanitizeBlueBandTolerancePct(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 3;
  return Math.min(8, Math.max(1, n));
}

function sanitizeBlueBandCenterOffsetPct(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(10, Math.max(-10, n));
}

type CaptureDebugInfo = {
  sourceType: "camera" | "file";
  originalWidth: number;
  originalHeight: number;
  storedWidth: number;
  storedHeight: number;
  quality: number;
  dataUrlLength: number;
};


function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizedDistanceToCenter(
  x: number,
  y: number,
  w: number,
  h: number,
  roiX: number,
  roiY: number,
  roiW: number,
  roiH: number
) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const roiCx = roiX + roiW / 2;
  const roiCy = roiY + roiH / 2;
  const dx = roiW > 0 ? (cx - roiCx) / (roiW / 2) : 0;
  const dy = roiH > 0 ? (cy - roiCy) / (roiH / 2) : 0;
  return Math.sqrt(dx * dx + dy * dy);
}


function dataUrlToImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = dataUrl;
  });
}

function toGrayArray(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const imageData = ctx.getImageData(0, 0, width, height).data;
  const out = new Float32Array(width * height);
  for (let i = 0, j = 0; i < imageData.length; i += 4, j++) {
    out[j] = imageData[i] * 0.299 + imageData[i + 1] * 0.587 + imageData[i + 2] * 0.114;
  }
  return out;
}

function edgeNormalize(gray: Float32Array, width: number, height: number) {
  const out = new Float32Array(width * height);
  let sum = 0;
  let sumSq = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const gx = gray[idx + 1] - gray[idx - 1];
      const gy = gray[idx + width] - gray[idx - width];
      const mag = Math.sqrt(gx * gx + gy * gy);
      out[idx] = mag;
      sum += mag;
      sumSq += mag * mag;
    }
  }
  const n = Math.max(1, (width - 2) * (height - 2));
  const mean = sum / n;
  const variance = Math.max(1e-6, sumSq / n - mean * mean);
  const std = Math.sqrt(variance);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mean) / std;
  return out;
}

function computeNcc(
  scene: Float32Array,
  sceneWidth: number,
  tpl: Float32Array,
  tplWidth: number,
  tplHeight: number,
  startX: number,
  startY: number
) {
  let sum = 0;
  let count = 0;
  for (let y = 1; y < tplHeight - 1; y += 2) {
    const sceneRow = (startY + y) * sceneWidth + startX;
    const tplRow = y * tplWidth;
    for (let x = 1; x < tplWidth - 1; x += 2) {
      sum += scene[sceneRow + x] * tpl[tplRow + x];
      count++;
    }
  }
  return count > 0 ? sum / count : -1;
}

function sampleSensitivityThreshold(sample: SampleItem | null | undefined) {
  const sens = clamp(Math.round(sample?.detectionSensitivity ?? 50), 0, 100);
  return clamp(Number((0.5 - (sens - 50) * 0.005).toFixed(3)), 0, 0.99);
}

function nextDistanceGuideState(
  current: { hint: string; count: number },
  nextHint: string
) {
  if (!nextHint) return { hint: "", count: 0 };
  if (current.hint === nextHint) {
    return { hint: nextHint, count: current.count + 1 };
  }
  return { hint: nextHint, count: 1 };
}


function buildScaleFactors(scaleOptions: number[]) {
  const normalized = Array.from(
    new Set(
      scaleOptions
        .map((value) => Math.round(value))
        .filter((value) => value >= 0)
    )
  ).sort((a, b) => a - b);

  const factors = new Set<number>([1]);
  for (const pct of normalized) {
    const ratio = pct / 100;
    factors.add(Number((1 - ratio).toFixed(3)));
    factors.add(Number((1 + ratio).toFixed(3)));
  }
  return Array.from(factors).sort((a, b) => a - b);
}

function toggleScaleOption(current: number[], value: number) {
  if (current.includes(value)) {
    const next = current.filter((item) => item !== value);
    return next.length > 0 ? next : [value];
  }
  return [...current, value].sort((a, b) => a - b);
}


function intersectsRect(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number
) {
  return x < rx + rw && x + w > rx && y < ry + rh && y + h > ry;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function nextDistanceGuideHintWithHysteresis(currentHint: string, delta: number) {
  if (currentHint === "もっと離れて下さい") {
    if (delta >= DISTANCE_GUIDE_STEP2_PCT) return "もっと離れて下さい";
  } else if (currentHint === "離れて下さい") {
    if (delta >= DISTANCE_GUIDE_STEP1_PCT) return "離れて下さい";
  } else if (currentHint === "もう少し離れて下さい") {
    if (delta >= 1) return "もう少し離れて下さい";
  } else if (currentHint === "もっと近づいて下さい") {
    if (delta <= -DISTANCE_GUIDE_STEP2_PCT) return "もっと近づいて下さい";
  } else if (currentHint === "近づいて下さい") {
    if (delta <= -DISTANCE_GUIDE_STEP1_PCT) return "近づいて下さい";
  } else if (currentHint === "もう少し近づいて下さい") {
    if (delta <= -1) return "もう少し近づいて下さい";
  }

  if (delta >= DISTANCE_GUIDE_STEP3_PCT) return "もっと離れて下さい";
  if (delta >= DISTANCE_GUIDE_STEP2_PCT) return "離れて下さい";
  if (delta >= DISTANCE_GUIDE_STEP1_PCT) return "もう少し離れて下さい";
  if (delta <= -DISTANCE_GUIDE_STEP3_PCT) return "もっと近づいて下さい";
  if (delta <= -DISTANCE_GUIDE_STEP2_PCT) return "近づいて下さい";
  if (delta <= -DISTANCE_GUIDE_STEP1_PCT) return "もう少し近づいて下さい";
  return "";
}

export default function DebugCameraPage() {
  const router = useRouter();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);

  const [isReady, setIsReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [isCapturing, setIsCapturing] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const [configVersion, setConfigVersion] = useState("--");
  const [sharedProfile, setSharedProfile] = useState<InspectionProfile | null>(null);

  const [saveStep, setSaveStep] = useState<SaveStep>("idle");
  const [liveBoxes, setLiveBoxes] = useState<LiveBox[]>([]);
  const [liveSearchRoiRect, setLiveSearchRoiRect] = useState<Rect | null>(null);
  const [liveGuideActive, setLiveGuideActive] = useState(false);
  const [liveGuideThresholdOffset, setLiveGuideThresholdOffset] = useState(DEFAULT_LIVE_GUIDE_THRESHOLD_OFFSET);
  const [liveGuideIntervalMs, setLiveGuideIntervalMs] = useState(DEFAULT_LIVE_GUIDE_INTERVAL_MS);
  const [liveDistanceScaleOffsetPct, setLiveDistanceScaleOffsetPct] = useState(7);
  const [liveDistanceMedianWindow, setLiveDistanceMedianWindow] = useState(5);
  const [liveDistanceHintConfirmCount, setLiveDistanceHintConfirmCount] = useState(2);
  const [liveBlueBandTolerancePct, setLiveBlueBandTolerancePct] = useState(3);
  const [liveBlueBandCenterOffsetPct, setLiveBlueBandCenterOffsetPct] = useState(0);
  const [liveScaleOptions, setLiveScaleOptions] = useState<number[]>([...DEFAULT_LIVE_SCALE_OPTIONS]);
  const [liveRoiWidthRatio, setLiveRoiWidthRatio] = useState(0.5);
  const [liveRoiHeightRatio, setLiveRoiHeightRatio] = useState(0.3);
  const [liveProcessInfo, setLiveProcessInfo] = useState("");
  const [liveGuideSavedMsg, setLiveGuideSavedMsg] = useState("");
  const [liveGuideSaving, setLiveGuideSaving] = useState(false);
  const [liveGuideOverlayMsg, setLiveGuideOverlayMsg] = useState("");
  const [liveDistanceGuide, setLiveDistanceGuide] = useState("");
  const [liveDistanceDebug, setLiveDistanceDebug] = useState("");
  const [firstSamplePreviewUrl, setFirstSamplePreviewUrl] = useState("");
  const [cameraTemplateInfo, setCameraTemplateInfo] = useState<{ width: number; height: number } | null>(null);
  const [liveTemplateSourceType, setLiveTemplateSourceType] = useState<"live" | "review" | "thumb" | "none">("none");
  const [videoDisplayRect, setVideoDisplayRect] = useState<Rect>({ left: 0, top: 0, width: 0, height: 0 });
  const [cameraDebugSnapshot, setCameraDebugSnapshot] = useState<CameraDebugSnapshot | null>(null);
  const [cameraDebugSummary, setCameraDebugSummary] = useState("focus:-\nmode:-\nzoom:-\nsize:-");
  const [cameraDebugOpen, setCameraDebugOpen] = useState(false);
  const [cameraDebugCopiedMsg, setCameraDebugCopiedMsg] = useState("");
  const liveTemplateRef = useRef<{
    sample: SampleItem;
    variants: Array<{
      scale: number;
      gray: Float32Array;
      width: number;
      height: number;
      rawWidth: number;
      rawHeight: number;
    }>;
    baseWidth: number;
    baseHeight: number;
    baseRawWidth: number;
    baseRawHeight: number;
    sourceType: "live" | "review" | "thumb";
  } | null>(null);
  const liveRunningRef = useRef(false);
  const liveTimerRef = useRef<number | null>(null);
  const liveBoxesHoldUntilRef = useRef(0);
  const distanceGuideStreakRef = useRef<{ hint: string; count: number }>({ hint: "", count: 0 });
  const distanceGuideShownAtRef = useRef(0);
  const distanceGuideCurrentHintRef = useRef("");
  const distanceGuideDeltaHistoryRef = useRef<number[]>([]);

  const liveTemplateScaleFactors = useMemo(() => buildScaleFactors(liveScaleOptions), [liveScaleOptions]);


  const updateVideoDisplayRect = useCallback(() => {
    const frame = previewFrameRef.current;
    const video = videoRef.current;
    if (!frame || !video) return;

    const frameRect = frame.getBoundingClientRect();
    const next = calcContainRect(
      frameRect.width,
      frameRect.height,
      video.videoWidth || frameRect.width,
      video.videoHeight || frameRect.height
    );
    setVideoDisplayRect(next);
  }, []);

  const resetSaveState = useCallback(() => {
    setSaveStep("idle");
  }, []);

  const collectCameraDebugInfo = useCallback(async () => {
    const stream = streamRef.current;
    const track = stream?.getVideoTracks?.()[0];

    if (!track) {
      const empty: CameraDebugSnapshot = {
        collectedAt: new Date().toISOString(),
        trackLabel: "no video track",
        settings: {},
        capabilities: {},
        constraints: {},
        photoCapabilities: null,
        photoSettings: null,
        videoFrame: videoRef.current ? { width: videoRef.current.videoWidth || 0, height: videoRef.current.videoHeight || 0 } : undefined,
        error: "video track がありません",
      };
      setCameraDebugSnapshot(empty);
      setCameraDebugSummary(createCameraDebugSummary(empty));
      return empty;
    }

    let photoCapabilities: Record<string, unknown> | null = null;
    let photoSettings: Record<string, unknown> | null = null;
    let error = "";

    try {
      const ImageCaptureCtor = (window as unknown as { ImageCapture?: new (track: MediaStreamTrack) => {
        getPhotoCapabilities?: () => Promise<unknown>;
        getPhotoSettings?: () => Promise<unknown>;
      } }).ImageCapture;

      if (ImageCaptureCtor) {
        const imageCapture = new ImageCaptureCtor(track);
        if (typeof imageCapture.getPhotoCapabilities === "function") {
          try {
            photoCapabilities = toPlainRecord(await imageCapture.getPhotoCapabilities());
          } catch (photoError) {
            error += `getPhotoCapabilities: ${photoError instanceof Error ? photoError.message : String(photoError)}; `;
          }
        }
        if (typeof imageCapture.getPhotoSettings === "function") {
          try {
            photoSettings = toPlainRecord(await imageCapture.getPhotoSettings());
          } catch (photoError) {
            error += `getPhotoSettings: ${photoError instanceof Error ? photoError.message : String(photoError)}; `;
          }
        }
      } else {
        error += "ImageCapture unsupported; ";
      }
    } catch (imageCaptureError) {
      error += `ImageCapture: ${imageCaptureError instanceof Error ? imageCaptureError.message : String(imageCaptureError)}; `;
    }

    const snapshot: CameraDebugSnapshot = {
      collectedAt: new Date().toISOString(),
      trackLabel: track.label || "unknown",
      settings: typeof track.getSettings === "function" ? toPlainRecord(track.getSettings()) : {},
      capabilities: typeof track.getCapabilities === "function" ? toPlainRecord(track.getCapabilities()) : {},
      constraints: typeof track.getConstraints === "function" ? toPlainRecord(track.getConstraints()) : {},
      photoCapabilities,
      photoSettings,
      videoFrame: videoRef.current ? { width: videoRef.current.videoWidth || 0, height: videoRef.current.videoHeight || 0 } : undefined,
      ...(error.trim() ? { error: error.trim() } : {}),
    };

    setCameraDebugSnapshot(snapshot);
    setCameraDebugSummary(createCameraDebugSummary(snapshot));
    return snapshot;
  }, []);

  const copyCameraDebugInfo = useCallback(async () => {
    const snapshot = cameraDebugSnapshot ?? await collectCameraDebugInfo();
    const text = JSON.stringify(snapshot, null, 2);

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCameraDebugCopiedMsg("コピーしました");
      window.setTimeout(() => setCameraDebugCopiedMsg(""), 1600);
    } catch (error) {
      console.error("カメラ情報のコピーに失敗しました", error);
      setCameraDebugCopiedMsg("コピー失敗");
      window.setTimeout(() => setCameraDebugCopiedMsg(""), 2000);
    }
  }, [cameraDebugSnapshot, collectCameraDebugInfo]);

  const stopCamera = useCallback(() => {
    try {
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.srcObject = null;
      }
    } catch {}

    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    } catch {}
  }, []);

  const startCamera = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;

    try {
      setIsReady(false);
      setErrorMsg("");

      stopCamera();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 4032 },
          height: { ideal: 3024 },
        },
      });

      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        return;
      }

      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;

      await video.play();

      if (!mountedRef.current) return;

      setErrorMsg("");
      setIsReady(true);
      window.setTimeout(() => updateVideoDisplayRect(), 0);
    } catch (err) {
      console.error(err);
      if (!mountedRef.current) return;
      setIsReady(false);
      setErrorMsg("カメラを起動できませんでした");
    } finally {
      startingRef.current = false;
    }
  }, [stopCamera]);

  useEffect(() => {
    mountedRef.current = true;

    const updateOrientation = () => {
      setIsLandscape(window.innerWidth > window.innerHeight);
    };

    updateOrientation();
    window.addEventListener("resize", updateOrientation);

    void startCamera();

    return () => {
      mountedRef.current = false;
      window.removeEventListener("resize", updateOrientation);
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
      }
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  useEffect(() => {
    if (!isReady) return;

    let cancelled = false;

    const refresh = async () => {
      if (cancelled) return;
      await collectCameraDebugInfo();
    };

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isReady, collectCameraDebugInfo]);

  useEffect(() => {
    try {
      if (typeof sharedProfile?.liveGuideThresholdOffset === "number") {
        setLiveGuideThresholdOffset(
          clamp(Number(sharedProfile.liveGuideThresholdOffset.toFixed(2)), -0.40, 0.40)
        );
      } else {
        setLiveGuideThresholdOffset(DEFAULT_LIVE_GUIDE_THRESHOLD_OFFSET);
      }

      if (typeof sharedProfile?.liveGuideIntervalMs === "number") {
        setLiveGuideIntervalMs(clamp(Math.round(sharedProfile.liveGuideIntervalMs), 100, 1000));
      } else {
        setLiveGuideIntervalMs(DEFAULT_LIVE_GUIDE_INTERVAL_MS);
      }

      setLiveDistanceScaleOffsetPct(sanitizeLiveDistanceScaleOffsetPct(sharedProfile?.liveDistanceScaleOffsetPct));
      setLiveScaleOptions(sanitizeLiveScaleOptions(sharedProfile?.liveScaleOptions));
      setLiveDistanceMedianWindow(sanitizeMedianWindow(sharedProfile?.liveDistanceMedianWindow));
      setLiveDistanceHintConfirmCount(sanitizeGuideConfirmCount(sharedProfile?.liveDistanceHintConfirmCount));
      setLiveBlueBandTolerancePct(sanitizeBlueBandTolerancePct(sharedProfile?.liveBlueBandTolerancePct));
      setLiveBlueBandCenterOffsetPct(sanitizeBlueBandCenterOffsetPct(sharedProfile?.liveBlueBandCenterOffsetPct));
      setLiveRoiWidthRatio(sanitizeLiveRoiWidthRatio(sharedProfile?.liveRoiWidthRatio));
      setLiveRoiHeightRatio(sanitizeLiveRoiHeightRatio(sharedProfile?.liveRoiHeightRatio));
    } catch (error) {
      console.error("ライブ簡易検査設定の読み込みに失敗しました", error);
    }
  }, [sharedProfile]);

  useEffect(() => {
    let cancelled = false;

    const loadSharedProfile = async () => {
      try {
        const response = await fetch("/api/config", { cache: "no-store" });
        if (!response.ok) return;

        const data = await response.json();
        if (cancelled) return;

        if (isInspectionProfile(data)) {
          setSharedProfile(data);
          if (data.version.trim()) {
            setConfigVersion(data.version.trim());
          }
        }
      } catch (error) {
        console.error("共有設定の取得に失敗しました", error);
      }
    };

    void loadSharedProfile();

    const handleFocus = () => {
      void loadSharedProfile();
    };

    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadCameraTemplatePreview = async () => {
      try {
        const raw = localStorage.getItem(SAMPLES_KEY);
        if (!raw) {
          setFirstSamplePreviewUrl("");
          setCameraTemplateInfo(null);
          return;
        }

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          setFirstSamplePreviewUrl("");
          setCameraTemplateInfo(null);
          return;
        }

        const sample = parsed[0] as SampleItem & {
          cameraCompareUrl?: string;
          compareUrl?: string;
          thumbUrl?: string;
        };
        const src = sample.cameraCompareUrl || sample.compareUrl || sample.thumbUrl || "";
        if (!src) {
          setFirstSamplePreviewUrl("");
          setCameraTemplateInfo(null);
          return;
        }

        setFirstSamplePreviewUrl(src);

        const img = await dataUrlToImage(src);
        if (cancelled) return;

        setCameraTemplateInfo({
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      } catch {
        if (!cancelled) {
          setFirstSamplePreviewUrl("");
          setCameraTemplateInfo(null);
        }
      }
    };

    void loadCameraTemplatePreview();

    const handleFocus = () => {
      void loadCameraTemplatePreview();
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleFocus);
    };
  }, [configVersion]);

  useEffect(() => {
    let cancelled = false;

    const loadLiveTemplate = async () => {
      try {
        const raw = localStorage.getItem(SAMPLES_KEY);
        if (!raw) {
          liveTemplateRef.current = null;
          setLiveTemplateSourceType("none");
          setLiveBoxes([]);
          setLiveSearchRoiRect(null);
          setLiveGuideActive(false);
          return;
        }

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          liveTemplateRef.current = null;
          setLiveTemplateSourceType("none");
          setLiveBoxes([]);
          setLiveSearchRoiRect(null);
          setLiveGuideActive(false);
          return;
        }

        const sortedSamples = (parsed as SampleItem[])
          .map((sample, index) => ({
            ...sample,
            order: typeof sample.order === "number" ? sample.order : index + 1,
          }))
          .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));

        const sample =
          sortedSamples.find((item) => !!item.cameraCompareUrl) ||
          sortedSamples.find((item) => !!(item.compareUrl || item.thumbUrl));

        if (!sample) {
          liveTemplateRef.current = null;
          setLiveTemplateSourceType("none");
          setLiveBoxes([]);
          setLiveSearchRoiRect(null);
          setLiveGuideActive(false);
          return;
        }

        const sourceType: "live" | "review" | "thumb" = sample.cameraCompareUrl
          ? "live"
          : sample.compareUrl
          ? "review"
          : "thumb";
        const src = sourceType === "live"
          ? sample.cameraCompareUrl
          : sourceType === "review"
          ? sample.compareUrl
          : sample.thumbUrl;
        if (!src) {
          liveTemplateRef.current = null;
          setLiveTemplateSourceType("none");
          setLiveBoxes([]);
          setLiveSearchRoiRect(null);
          setLiveGuideActive(false);
          return;
        }

        const img = await dataUrlToImage(src);
        if (cancelled) return;

        const baseLongSide = Math.max(img.naturalWidth, img.naturalHeight);
        const baseScale = Math.min(1, LIVE_TEMPLATE_LONG_SIDE / Math.max(1, baseLongSide));
        const baseWidth = Math.max(16, Math.round(img.naturalWidth * baseScale));
        const baseHeight = Math.max(16, Math.round(img.naturalHeight * baseScale));

        const variants = liveTemplateScaleFactors.map((factor) => {
          const width = Math.max(16, Math.round(baseWidth * factor));
          const height = Math.max(16, Math.round(baseHeight * factor));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            throw new Error('テンプレート描画に失敗しました');
          }
          ctx.drawImage(img, 0, 0, width, height);
          const gray = edgeNormalize(toGrayArray(ctx, width, height), width, height);
          return {
            scale: factor,
            gray,
            width,
            height,
            rawWidth: img.naturalWidth * factor,
            rawHeight: img.naturalHeight * factor,
          };
        });

        liveTemplateRef.current = { sample, variants, baseWidth, baseHeight, baseRawWidth: img.naturalWidth, baseRawHeight: img.naturalHeight, sourceType };
        setLiveGuideActive(true);
      } catch (error) {
        console.error('ライブ簡易検査の見本読み込みに失敗しました', error);
        liveTemplateRef.current = null;
        setLiveTemplateSourceType("none");
        setLiveSearchRoiRect(null);
        setLiveGuideActive(false);
      }
    };

    void loadLiveTemplate();
    const handleStorage = () => { void loadLiveTemplate(); };
    window.addEventListener('storage', handleStorage);
    window.addEventListener('focus', handleStorage);

    return () => {
      cancelled = true;
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', handleStorage);
    };
  }, [liveTemplateScaleFactors]);

  const runLiveCheck = useCallback(async () => {
    if (liveRunningRef.current || isCapturing || !isReady) return;
    const video = videoRef.current;
    const tpl = liveTemplateRef.current;
    if (!video || !tpl) {
      setLiveBoxes([]);
      setLiveSearchRoiRect(null);
      liveBoxesHoldUntilRef.current = 0;
      distanceGuideStreakRef.current = { hint: "", count: 0 };
      distanceGuideShownAtRef.current = 0;
      distanceGuideCurrentHintRef.current = "";
      distanceGuideDeltaHistoryRef.current = [];
      setLiveDistanceGuide("");
      setLiveDistanceDebug("");
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    liveRunningRef.current = true;
    try {
      const longSide = Math.max(vw, vh);
      const scale = Math.min(1, LIVE_PROCESS_LONG_SIDE / Math.max(1, longSide));
      const pw = Math.max(160, Math.round(vw * scale));
      const ph = Math.max(120, Math.round(vh * scale));

      const canvas = document.createElement('canvas');
      canvas.width = pw;
      canvas.height = ph;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, pw, ph);

      const maxTplWidth = Math.max(...tpl.variants.map((v) => v.width));
      const maxTplHeight = Math.max(...tpl.variants.map((v) => v.height));
      const roiW = Math.min(pw, Math.max(maxTplWidth + 4, Math.round(pw * liveRoiWidthRatio)));
      const roiH = Math.min(ph, Math.max(maxTplHeight + 4, Math.round(ph * liveRoiHeightRatio)));
      const roiX = Math.round((pw - roiW) / 2);
      const roiY = Math.round((ph - roiH) / 2);
      setLiveSearchRoiRect({
        left: roiX / pw,
        top: roiY / ph,
        width: roiW / pw,
        height: roiH / ph,
      });

      const gray = edgeNormalize(toGrayArray(ctx, pw, ph), pw, ph);

      const distanceGuideCenterRoiW = roiW;
      const distanceGuideCenterRoiH = roiH;
      const distanceGuideCenterRoiX = roiX;
      const distanceGuideCenterRoiY = roiY;

      setLiveProcessInfo(
        `${pw}x${ph} / tpl ${tpl.baseWidth}x${tpl.baseHeight} (${tpl.sourceType}) / scale ±${liveScaleOptions.join("/")}% / roi ${Math.round((roiW / pw) * 100)}x${Math.round((roiH / ph) * 100)}% / d-roi linked`
      );
      let bestBox: LiveBox | null = null;
      let bestDistanceGuideBox: LiveBox | null = null;
      const matchThreshold = sampleSensitivityThreshold(tpl.sample);
      const highThreshold = clamp(Number((matchThreshold + liveGuideThresholdOffset).toFixed(2)), 0.35, 0.95);

      for (const variant of tpl.variants) {
        for (let y = roiY; y <= roiY + roiH - variant.height; y += LIVE_SEARCH_STEP) {
          for (let x = roiX; x <= roiX + roiW - variant.width; x += LIVE_SEARCH_STEP) {
            const score = computeNcc(gray, pw, variant.gray, variant.width, variant.height, x, y);
            if (score < highThreshold) continue;

            const rawWNorm = variant.rawWidth / pw;
            const rawHNorm = variant.rawHeight / ph;
            const matchWNorm = variant.width / pw;
            const matchHNorm = variant.height / ph;
            const offsetXNorm = Math.max(0, (rawWNorm - matchWNorm) / 2);
            const offsetYNorm = Math.max(0, (rawHNorm - matchHNorm) / 2);

            const sampleWidthPct = (variant.rawWidth / Math.max(1, tpl.baseRawWidth)) * 100;
            const sampleHeightPct = (variant.rawHeight / Math.max(1, tpl.baseRawHeight)) * 100;
            const scaleDeltaPct = sampleWidthPct - 100;

            const rawHint: "near" | "far" | "neutral" =
              Math.abs(scaleDeltaPct) <= DISTANCE_GUIDE_BLUE_TOLERANCE_PCT
                ? "neutral"
                : scaleDeltaPct > 0
                ? "near"
                : "far";

            const centerDistanceNorm = normalizedDistanceToCenter(
              x,
              y,
              variant.width,
              variant.height,
              roiX,
              roiY,
              roiW,
              roiH
            );
            const priorityScore =
              score
              - centerDistanceNorm * 0.12
              - Math.abs(scaleDeltaPct) * 0.0025;

            const inDistanceGuideCenterRoi = intersectsRect(
              x,
              y,
              variant.width,
              variant.height,
              distanceGuideCenterRoiX,
              distanceGuideCenterRoiY,
              distanceGuideCenterRoiW,
              distanceGuideCenterRoiH
            );
            const distanceGuidePriority =
              (inDistanceGuideCenterRoi ? 1 : -1)
              - Math.abs(scaleDeltaPct) * DISTANCE_GUIDE_SCALE_WEIGHT
              - centerDistanceNorm * 0.04
              + score * DISTANCE_GUIDE_SCORE_WEIGHT;

            const box: LiveBox = {
              x: Math.max(0, x / pw - offsetXNorm),
              y: Math.max(0, y / ph - offsetYNorm),
              w: rawWNorm,
              h: rawHNorm,
              matchW: matchWNorm,
              matchH: matchHNorm,
              score,
              sampleWidthPct,
              sampleHeightPct,
              rawHint,
              scaleDeltaPct,
              centerDistanceNorm,
              priorityScore,
              distanceGuidePriority,
              inDistanceGuideCenterRoi,
            };

            if (
              !bestBox ||
              box.priorityScore > bestBox.priorityScore ||
              (
                Math.abs(box.priorityScore - bestBox.priorityScore) < 0.0001 &&
                box.score > bestBox.score
              )
            ) {
              bestBox = box;
            }

            if (
              !bestDistanceGuideBox ||
              box.distanceGuidePriority > bestDistanceGuideBox.distanceGuidePriority ||
              (
                Math.abs(box.distanceGuidePriority - bestDistanceGuideBox.distanceGuidePriority) < 0.0001 &&
                Math.abs(box.scaleDeltaPct) < Math.abs(bestDistanceGuideBox.scaleDeltaPct)
              )
            ) {
              bestDistanceGuideBox = box;
            }
          }
        }
      }

      const nextResults = bestBox ? [bestBox] : [];
      const best = bestBox;
      const bestDistance = bestDistanceGuideBox;

      const rawLabel = bestDistance ? bestDistance.rawHint : "none";
      const scoreText = best ? best.score.toFixed(3) : "--";
      const priorityText = best ? best.priorityScore.toFixed(3) : "--";
      const guidePriorityText = bestDistance ? bestDistance.distanceGuidePriority.toFixed(3) : "--";
      const centerText = bestDistance ? bestDistance.centerDistanceNorm.toFixed(2) : "--";
      const thresholdText = highThreshold.toFixed(3);
      const widthPctText = bestDistance ? `${bestDistance.sampleWidthPct.toFixed(0)}%` : "--";
      const heightPctText = bestDistance ? `${bestDistance.sampleHeightPct.toFixed(0)}%` : "--";
      const guideCenterText = bestDistance
        ? bestDistance.inDistanceGuideCenterRoi ? "in" : "out"
        : "--";

      const deltaRaw = bestDistance ? bestDistance.scaleDeltaPct + liveDistanceScaleOffsetPct : 0;

      if (bestDistance && bestDistance.inDistanceGuideCenterRoi) {
        const nextHistory = [...distanceGuideDeltaHistoryRef.current, deltaRaw].slice(-liveDistanceMedianWindow);
        distanceGuideDeltaHistoryRef.current = nextHistory;
      } else {
        distanceGuideDeltaHistoryRef.current = [];
      }

      const delta = distanceGuideDeltaHistoryRef.current.length > 0
        ? median(distanceGuideDeltaHistoryRef.current)
        : deltaRaw;

      const blueDeltaRaw = best ? best.scaleDeltaPct + liveDistanceScaleOffsetPct : 0;
      const blueDelta = blueDeltaRaw - liveBlueBandCenterOffsetPct;
      const blueAccepted =
        !!best && Math.abs(blueDelta) <= liveBlueBandTolerancePct;

       const nextHint =
        !bestDistance || !bestDistance.inDistanceGuideCenterRoi
          ? ""
          : nextDistanceGuideHintWithHysteresis(distanceGuideCurrentHintRef.current, delta);

      setLiveDistanceDebug(
        `hint:${nextHint || "-"} blue:${blueAccepted ? "yes" : "no"} roiHit:${guideCenterText} src:${tpl.sourceType}\n` +
        `Δ:${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% offset:${liveDistanceScaleOffsetPct >= 0 ? "+" : ""}${liveDistanceScaleOffsetPct}%\n` +
        `blueΔ:${blueDeltaRaw >= 0 ? "+" : ""}${blueDeltaRaw.toFixed(0)}% score:${scoreText}`
      );

      const streak = nextDistanceGuideState(distanceGuideStreakRef.current, nextHint);
      distanceGuideStreakRef.current = streak;
      const nextConfirmedHint =
        streak.count >= liveDistanceHintConfirmCount ? streak.hint : "";

      const now = performance.now();
      const prevHint = distanceGuideCurrentHintRef.current;
      let visibleHint = prevHint;

      if (nextConfirmedHint) {
        if (prevHint !== nextConfirmedHint) {
          distanceGuideShownAtRef.current = now;
        }
        distanceGuideCurrentHintRef.current = nextConfirmedHint;
        visibleHint = nextConfirmedHint;
      } else if (prevHint) {
        const keepVisibleUntil = distanceGuideShownAtRef.current + 2000;
        if (now >= keepVisibleUntil) {
          distanceGuideCurrentHintRef.current = "";
          visibleHint = "";
        } else {
          visibleHint = prevHint;
        }
      } else {
        distanceGuideCurrentHintRef.current = "";
        visibleHint = "";
      }

      setLiveDistanceGuide(visibleHint);

      if (visibleHint) {
        setLiveBoxes([]);
        liveBoxesHoldUntilRef.current = 0;
       } else if (nextResults.length > 0 && blueAccepted) {
        setLiveBoxes(nextResults);
        liveBoxesHoldUntilRef.current = now + Math.max(220, liveGuideIntervalMs * 1.2);
      } else if (now > liveBoxesHoldUntilRef.current) {
        setLiveBoxes([]);
      }

    } catch (error) {
      console.error('ライブ簡易検査エラー', error);
    } finally {
      liveRunningRef.current = false;
    }
  
  }, [
    isCapturing,
    isReady,
    liveGuideThresholdOffset,
    liveDistanceScaleOffsetPct,
    liveDistanceMedianWindow,
    liveDistanceHintConfirmCount,
    liveBlueBandTolerancePct,
    liveBlueBandCenterOffsetPct,
    liveScaleOptions,
    liveRoiWidthRatio,
    liveRoiHeightRatio,
  ]);

  useEffect(() => {
    if (liveTimerRef.current !== null) {
      window.clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }

    if (!isReady) return;

    liveTimerRef.current = window.setInterval(() => {
      void runLiveCheck();
    }, liveGuideIntervalMs);

    void runLiveCheck();

    return () => {
      if (liveTimerRef.current !== null) {
        window.clearInterval(liveTimerRef.current);
        liveTimerRef.current = null;
      }
    };
  }, [isReady, runLiveCheck, liveGuideIntervalMs]);

  useEffect(() => {
    const handleResize = () => updateVideoDisplayRect();
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    handleResize();
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, [updateVideoDisplayRect, isLandscape, isReady]);

  useEffect(() => {
    if (!mountedRef.current) return;

    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
    }

    restartTimerRef.current = window.setTimeout(() => {
      void startCamera();
    }, 250);

    return () => {
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
      }
    };
  }, [isLandscape, startCamera]);

  const failSave = useCallback(
    (message: string, detail?: unknown) => {
      console.error(message, detail);
      setSaveStep("error");
      setErrorMsg(message);
      setIsCapturing(false);
    },
    []
  );

  const saveToSessionStorageSafely = useCallback(
    (sourceCanvas: HTMLCanvasElement) => {
      const attempts = [
        { maxSide: 2400, quality: 0.9 },
        { maxSide: 2000, quality: 0.88 },
        { maxSide: 1600, quality: 0.85 },
        { maxSide: 1280, quality: 0.82 },
        { maxSide: 1024, quality: 0.8 },
      ];

      for (const attempt of attempts) {
        const srcW = sourceCanvas.width;
        const srcH = sourceCanvas.height;
        const longSide = Math.max(srcW, srcH);
        const scale = Math.min(1, attempt.maxSide / longSide);

        const outW = Math.max(1, Math.round(srcW * scale));
        const outH = Math.max(1, Math.round(srcH * scale));

        const outCanvas = document.createElement("canvas");
        outCanvas.width = outW;
        outCanvas.height = outH;

        const outCtx = outCanvas.getContext("2d");
        if (!outCtx) {
          continue;
        }

        outCtx.drawImage(sourceCanvas, 0, 0, srcW, srcH, 0, 0, outW, outH);

        let dataUrl = "";
        try {
          dataUrl = outCanvas.toDataURL("image/jpeg", attempt.quality);
        } catch (err) {
          console.error(err);
          continue;
        }

        if (!dataUrl || !dataUrl.startsWith("data:image/")) {
          continue;
        }

        try {
          sessionStorage.setItem("capturedImage", dataUrl);
          const debugInfo: CaptureDebugInfo = {
            sourceType: "camera",
            originalWidth: srcW,
            originalHeight: srcH,
            storedWidth: outW,
            storedHeight: outH,
            quality: attempt.quality,
            dataUrlLength: dataUrl.length,
          };
          sessionStorage.setItem("captureDebugInfo", JSON.stringify(debugInfo));
          return {
            ok: true as const,
            width: outW,
            height: outH,
            quality: attempt.quality,
            length: dataUrl.length,
          };
        } catch (err) {
          console.error(err);
        }
      }

      return { ok: false as const };
    },
    []
  );


  const saveLiveFrameAtCapture = useCallback((sourceCanvas: HTMLCanvasElement) => {
    try {
      sessionStorage.removeItem(CAPTURED_LIVE_FRAME_KEY);
      const dataUrl = sourceCanvas.toDataURL("image/jpeg", 0.9);
      if (dataUrl && dataUrl.startsWith("data:image/")) {
        sessionStorage.setItem(CAPTURED_LIVE_FRAME_KEY, dataUrl);
      }
    } catch (error) {
      console.error("ライブビュー画像の保存に失敗しました", error);
    }
  }, []);

  const savePendingSharedProfile = useCallback(() => {
    try {
      if (!sharedProfile) {
        sessionStorage.removeItem(PENDING_SHARED_PROFILE_KEY);
        return;
      }

      sessionStorage.setItem(PENDING_SHARED_PROFILE_KEY, JSON.stringify(sharedProfile));
    } catch (error) {
      console.error("共有設定の受け渡し保存に失敗しました", error);
    }
  }, [sharedProfile]);

  const handleCapture = async () => {
    if (!videoRef.current || isCapturing || !isReady) return;

    resetSaveState();

    const video = videoRef.current;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (!vw || !vh) {
      failSave("保存失敗: 撮影サイズ取得");
      return;
    }

    try {
      setIsCapturing(true);
      setErrorMsg("");

      setSaveStep("capture_start");

      setSaveStep("canvas_create");
      const canvas = document.createElement("canvas");
      canvas.width = vw;
      canvas.height = vh;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        failSave("保存失敗: canvas context 作成");
        return;
      }

      setSaveStep("canvas_draw");
      ctx.drawImage(video, 0, 0, vw, vh);
      saveLiveFrameAtCapture(canvas);

      setSaveStep("image_resize");

      setSaveStep("sessionstorage_save");
      const saved = saveToSessionStorageSafely(canvas);

      if (!saved.ok) {
        failSave("保存失敗: sessionStorage保存");
        return;
      }


      savePendingSharedProfile();

      setSaveStep("navigate_review");
      setSaveStep("done");

      router.push("/debug/review");
    } catch (err) {
      failSave("保存失敗: 想定外エラー", err);
    }
  };

  const handlePickImage = async () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    resetSaveState();

    try {
      setErrorMsg("");
      setIsCapturing(true);
      setSaveStep("capture_start");

      const reader = new FileReader();

      reader.onload = () => {
        const result = reader.result;

        if (typeof result !== "string" || !result.startsWith("data:image/")) {
          failSave("画像の読み込みに失敗しました");
          return;
        }

        const img = new Image();
        img.onload = () => {
          try {
            setSaveStep("canvas_create");
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;

            const ctx = canvas.getContext("2d");
            if (!ctx) {
              failSave("保存失敗: canvas context 作成");
              return;
            }

            setSaveStep("canvas_draw");
            ctx.drawImage(img, 0, 0);

            setSaveStep("image_resize");
            const saved = saveToSessionStorageSafely(canvas);

            if (!saved.ok) {
              failSave("保存失敗: sessionStorage保存");
              return;
            }

            try {
              const debugInfo: CaptureDebugInfo = {
                sourceType: "file",
                originalWidth: img.naturalWidth,
                originalHeight: img.naturalHeight,
                storedWidth: saved.width,
                storedHeight: saved.height,
                quality: saved.quality,
                dataUrlLength: saved.length,
              };
              sessionStorage.setItem("captureDebugInfo", JSON.stringify(debugInfo));
            } catch {}


            savePendingSharedProfile();

            setSaveStep("navigate_review");
            setSaveStep("done");

            router.push("/debug/review");
          } catch (err) {
            failSave("画像の読み込みに失敗しました", err);
          }
        };

        img.onerror = () => {
          failSave("画像の読み込みに失敗しました");
        };

        setSaveStep("dataurl_create");
        img.src = result;
      };

      reader.onerror = () => {
        failSave("画像の読み込みに失敗しました");
      };

      setSaveStep("dataurl_create");
      reader.readAsDataURL(file);
    } catch (err) {
      failSave("画像の読み込みに失敗しました", err);
    } finally {
      e.target.value = "";
    }
  };


  const adjustLiveGuideThresholdOffset = (delta: number) => {
    setLiveGuideThresholdOffset((prev) => clamp(Number((prev + delta).toFixed(2)), -0.40, 0.40));
  };

  const adjustLiveGuideInterval = (deltaMs: number) => {
    setLiveGuideIntervalMs((prev) => clamp(prev + deltaMs, 100, 1000));
  };

    useEffect(() => {
    try {
      if (typeof sharedProfile?.liveGuideThresholdOffset === "number") {
        setLiveGuideThresholdOffset(
          clamp(Number(sharedProfile.liveGuideThresholdOffset.toFixed(2)), -0.40, 0.40)
        );
      } else {
        setLiveGuideThresholdOffset(DEFAULT_LIVE_GUIDE_THRESHOLD_OFFSET);
      }

      if (typeof sharedProfile?.liveGuideIntervalMs === "number") {
        setLiveGuideIntervalMs(clamp(Math.round(sharedProfile.liveGuideIntervalMs), 100, 1000));
      } else {
        setLiveGuideIntervalMs(DEFAULT_LIVE_GUIDE_INTERVAL_MS);
      }

      setLiveScaleOptions(sanitizeLiveScaleOptions(sharedProfile?.liveScaleOptions));
      setLiveRoiWidthRatio(sanitizeLiveRoiWidthRatio(sharedProfile?.liveRoiWidthRatio));
      setLiveRoiHeightRatio(sanitizeLiveRoiHeightRatio(sharedProfile?.liveRoiHeightRatio));
    } catch (error) {
      console.error("ライブ簡易検査設定の読み込みに失敗しました", error);
    }
  }, [sharedProfile]);

  const saveLiveGuideSettings = async () => {
    if (liveGuideSaving) return;

    const clearOverlayLater = (ms = 1800) => {
      window.setTimeout(() => setLiveGuideOverlayMsg(""), ms);
    };

    try {
      setLiveGuideSaving(true);
      setLiveGuideSavedMsg("保存中…");
      setLiveGuideOverlayMsg("保存中…");

      const baseProfile = sharedProfile ?? {
        profileName: "default",
        version: configVersion !== "--" ? configVersion : "live-guide-update",
        baseThreshold: 0.48,
        missingCandidateThreshold: 0.31,
        rotationRange: 3,
        scaleRange: 5,
        shearRange: 0,
        compareResolution: 1600,
        hitLimit: 100,
        liveGuideThresholdOffset: DEFAULT_LIVE_GUIDE_THRESHOLD_OFFSET,
        liveGuideIntervalMs: DEFAULT_LIVE_GUIDE_INTERVAL_MS,
        liveDistanceScaleOffsetPct: 7,
        liveScaleOptions: [...DEFAULT_LIVE_SCALE_OPTIONS],
        liveRoiWidthRatio: 0.5,
        liveRoiHeightRatio: 0.3,
      };

      const nextProfile = {
        ...baseProfile,
        liveGuideThresholdOffset: clamp(Number(liveGuideThresholdOffset.toFixed(2)), -0.40, 0.40),
        liveGuideIntervalMs: clamp(Math.round(liveGuideIntervalMs), 100, 1000),
        liveDistanceScaleOffsetPct: sanitizeLiveDistanceScaleOffsetPct(liveDistanceScaleOffsetPct),
        liveDistanceMedianWindow: sanitizeMedianWindow(liveDistanceMedianWindow),
        liveDistanceHintConfirmCount: sanitizeGuideConfirmCount(liveDistanceHintConfirmCount),
        liveBlueBandTolerancePct: sanitizeBlueBandTolerancePct(liveBlueBandTolerancePct),
        liveBlueBandCenterOffsetPct: sanitizeBlueBandCenterOffsetPct(liveBlueBandCenterOffsetPct),
        liveScaleOptions: sanitizeLiveScaleOptions(liveScaleOptions),
        liveRoiWidthRatio: sanitizeLiveRoiWidthRatio(liveRoiWidthRatio),
        liveRoiHeightRatio: sanitizeLiveRoiHeightRatio(liveRoiHeightRatio),
      };

      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 12000);

      const response = await fetch("/api/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(nextProfile),
        signal: controller.signal,
      }).finally(() => {
        window.clearTimeout(timer);
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          typeof data?.message === "string" ? data.message : "共有設定の保存に失敗しました。"
        );
      }

      if (data?.profile) {
        setSharedProfile(data.profile);
        if (typeof data.profile.version === "string" && data.profile.version.trim()) {
          setConfigVersion(data.profile.version.trim());
        }
        setLiveDistanceScaleOffsetPct(sanitizeLiveDistanceScaleOffsetPct(data.profile.liveDistanceScaleOffsetPct));
        setLiveDistanceMedianWindow(sanitizeMedianWindow(data.profile.liveDistanceMedianWindow));
        setLiveDistanceHintConfirmCount(sanitizeGuideConfirmCount(data.profile.liveDistanceHintConfirmCount));
        setLiveBlueBandTolerancePct(sanitizeBlueBandTolerancePct(data.profile.liveBlueBandTolerancePct));
        setLiveBlueBandCenterOffsetPct(sanitizeBlueBandCenterOffsetPct(data.profile.liveBlueBandCenterOffsetPct));
        setLiveScaleOptions(sanitizeLiveScaleOptions(data.profile.liveScaleOptions));
        setLiveRoiWidthRatio(sanitizeLiveRoiWidthRatio(data.profile.liveRoiWidthRatio));
        setLiveRoiHeightRatio(sanitizeLiveRoiHeightRatio(data.profile.liveRoiHeightRatio));
      }

      setLiveGuideSavedMsg("出力しました");
      setLiveGuideOverlayMsg("出力しました");
      window.setTimeout(() => setLiveGuideSavedMsg(""), 1600);
      clearOverlayLater(1600);
    } catch (error) {
      console.error("ライブ簡易検査設定の保存に失敗しました", error);
      const msg =
        error instanceof Error && error.name === "AbortError"
          ? "保存タイムアウト"
          : "保存失敗";
      setLiveGuideSavedMsg(msg);
      setLiveGuideOverlayMsg(msg);
      window.setTimeout(() => setLiveGuideSavedMsg(""), 2200);
      clearOverlayLater(2200);
    } finally {
      setLiveGuideSaving(false);
    }
  };

  const CameraDebugPanel = (
    <div className="rounded-2xl border border-white/10 bg-zinc-950/95 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">カメラ情報</div>
          <div className="mt-1 text-xs text-zinc-400">距離補助に使えそうな値の確認用</div>
        </div>
        <button
          type="button"
          onClick={() => setCameraDebugOpen((prev) => !prev)}
          className="rounded-xl border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-zinc-200"
        >
          {cameraDebugOpen ? "閉じる" : "詳細"}
        </button>
      </div>

      <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-zinc-200 leading-relaxed tabular-nums whitespace-pre-line">
        {cameraDebugSummary}
      </div>

      {cameraDebugOpen ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void collectCameraDebugInfo()}
              className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-zinc-200"
            >
              再取得
            </button>
            <button
              type="button"
              onClick={() => void copyCameraDebugInfo()}
              className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-200"
            >
              コピー
            </button>
            {cameraDebugCopiedMsg ? (
              <span className="text-xs text-cyan-300">{cameraDebugCopiedMsg}</span>
            ) : null}
          </div>

          <pre className="max-h-64 overflow-auto rounded-xl border border-white/10 bg-black/40 p-3 text-[10px] leading-relaxed text-zinc-300 whitespace-pre-wrap break-words">
            {cameraDebugSnapshot ? JSON.stringify(cameraDebugSnapshot, null, 2) : "未取得"}
          </pre>
        </div>
      ) : null}
    </div>
  );

  const DebugGuideControls = (
    <div className="rounded-2xl border border-white/10 bg-zinc-950/95 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">簡易検査調整</div>
        <button
          onClick={saveLiveGuideSettings}
          disabled={liveGuideSaving}
          className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-sm text-cyan-200 disabled:opacity-50"
        >
          {liveGuideSaving ? "保存中…" : "出力"}
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <div>しきい値補正</div>
          <div className="tabular-nums">
            {liveGuideThresholdOffset >= 0 ? "+" : ""}
            {liveGuideThresholdOffset.toFixed(2)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => adjustLiveGuideThresholdOffset(-0.01)}
            className="w-10 h-10 rounded-xl border border-white/15 bg-white/5 text-lg"
            aria-label="しきい値補正を下げる"
          >
            −
          </button>
          <input
            type="range"
            min={-0.40}
            max={0.40}
            step={0.01}
            value={liveGuideThresholdOffset}
            onChange={(e) => setLiveGuideThresholdOffset(clamp(Number(e.target.value), -0.40, 0.40))}
            className="flex-1"
          />
          <button
            onClick={() => adjustLiveGuideThresholdOffset(0.01)}
            className="w-10 h-10 rounded-xl border border-white/15 bg-white/5 text-lg"
            aria-label="しきい値補正を上げる"
          >
            +
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <div>検知間隔</div>
          <div className="tabular-nums">{(liveGuideIntervalMs / 1000).toFixed(1)}秒</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => adjustLiveGuideInterval(-100)}
            className="w-10 h-10 rounded-xl border border-white/15 bg-white/5 text-lg"
            aria-label="検知間隔を短くする"
          >
            −
          </button>
          <input
            type="range"
            min={100}
            max={1000}
            step={100}
            value={liveGuideIntervalMs}
            onChange={(e) => setLiveGuideIntervalMs(clamp(Number(e.target.value), 100, 1000))}
            className="flex-1"
          />
          <button
            onClick={() => adjustLiveGuideInterval(100)}
            className="w-10 h-10 rounded-xl border border-white/15 bg-white/5 text-lg"
            aria-label="検知間隔を長くする"
          >
            +
          </button>
        </div>
      </div>

            <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <div>距離scale補正</div>
          <div className="tabular-nums">{liveDistanceScaleOffsetPct >= 0 ? "+" : ""}{liveDistanceScaleOffsetPct}%</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLiveDistanceScaleOffsetPct((prev) => Math.max(-20, prev - 1))}
            className="w-10 h-10 rounded-xl border border-white/15 bg-white/5 text-lg"
            aria-label="距離scale補正を下げる"
          >
            −
          </button>
          <input
            type="range"
            min={-20}
            max={20}
            step={1}
            value={liveDistanceScaleOffsetPct}
            onChange={(e) => setLiveDistanceScaleOffsetPct(sanitizeLiveDistanceScaleOffsetPct(Number(e.target.value)))}
            className="flex-1"
          />
          <button
            onClick={() => setLiveDistanceScaleOffsetPct((prev) => Math.min(20, prev + 1))}
            className="w-10 h-10 rounded-xl border border-white/15 bg-white/5 text-lg"
            aria-label="距離scale補正を上げる"
          >
            +
          </button>
        </div>
      </div>

            <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <div>中央値履歴数</div>
          <div className="tabular-nums">{liveDistanceMedianWindow}</div>
        </div>
        <div className="flex items-center gap-2">
          {[9, 11, 13, 15].map((option) => (
            <button
              key={`median-${option}`}
              type="button"
              onClick={() => setLiveDistanceMedianWindow(sanitizeMedianWindow(option))}
              className={`px-3 py-2 rounded-xl border text-sm transition-colors ${
                liveDistanceMedianWindow === option
                  ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                  : "border-white/10 bg-white/5 text-zinc-300"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <div>案内切替回数</div>
          <div className="tabular-nums">{liveDistanceHintConfirmCount}</div>
        </div>
        <div className="flex items-center gap-2">
          {[1, 2, 3].map((option) => (
            <button
              key={`confirm-${option}`}
              type="button"
              onClick={() => setLiveDistanceHintConfirmCount(sanitizeGuideConfirmCount(option))}
              className={`px-3 py-2 rounded-xl border text-sm transition-colors ${
                liveDistanceHintConfirmCount === option
                  ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                  : "border-white/10 bg-white/5 text-zinc-300"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <div>距離検知ROI 横</div>
          <div className="tabular-nums">{Math.round(liveRoiWidthRatio * 100)}%</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLiveRoiWidthRatio((prev) => Math.max(0.1, Number((prev - 0.05).toFixed(2))))}
            className="w-10 h-10 rounded-xl border border-white/15 bg-white/5 text-lg"
            aria-label="距離検知ROI横幅を狭くする"
          >
            −
          </button>
          <input
            type="range"
            min={0.1}
            max={0.6}
            step={0.01}
            value={liveRoiWidthRatio}
            onChange={(e) => setLiveRoiWidthRatio(Math.min(0.6, Math.max(0.1, Number(e.target.value))))}
            className="flex-1"
          />
          <button
            onClick={() => setLiveRoiWidthRatio((prev) => Math.min(0.6, Number((prev + 0.05).toFixed(2))))}
            className="w-10 h-10 rounded-xl border border-white/15 bg-white/5 text-lg"
            aria-label="距離検知ROI横幅を広くする"
          >
            +
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <div>距離検知ROI 縦</div>
          <div className="tabular-nums">{Math.round(liveRoiHeightRatio * 100)}%</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLiveRoiHeightRatio((prev) => Math.max(0.1, Number((prev - 0.05).toFixed(2))))}
            className="w-10 h-10 rounded-xl border border-white/15 bg-white/5 text-lg"
            aria-label="距離検知ROI縦幅を狭くする"
          >
            −
          </button>
          <input
            type="range"
            min={0.1}
            max={0.4}
            step={0.01}
            value={liveRoiHeightRatio}
            onChange={(e) => setLiveRoiHeightRatio(Math.min(0.4, Math.max(0.1, Number(e.target.value))))}
            className="flex-1"
          />
          <button
            onClick={() => setLiveRoiHeightRatio((prev) => Math.min(0.4, Number((prev + 0.05).toFixed(2))))}
            className="w-10 h-10 rounded-xl border border-white/15 bg-white/5 text-lg"
            aria-label="距離検知ROI縦幅を広くする"
          >
            +
          </button>
        </div>
      </div>

      <div className="text-xs text-zinc-400 space-y-1">
        <div>内部処理解像度: 長辺 {LIVE_PROCESS_LONG_SIDE}</div>
        <div>現在: {liveProcessInfo || "待機中"}</div>
      </div>

      <div className="rounded-xl border border-white/10 bg-black/30 p-3 space-y-2">
        <div className="text-sm font-medium">camera用見本の確認</div>
        {firstSamplePreviewUrl ? (
          <>
            <div className="h-24 rounded-lg border border-white/10 bg-zinc-900 flex items-center justify-center overflow-hidden">
              <img
                src={firstSamplePreviewUrl}
                alt="camera用見本"
                className="max-w-full max-h-full object-contain"
              />
            </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <div>scale許容</div>
                      <div className="tabular-nums">±{liveScaleOptions.join(" / ")}%</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {LIVE_SCALE_OPTIONS.map((option) => {
                        const active = liveScaleOptions.includes(option);
                        return (
                          <button
                            key={option}
                            type="button"
                            onClick={() => setLiveScaleOptions((prev) => toggleScaleOption(prev, option))}
                            className={`px-3 py-2 rounded-xl border text-sm transition-colors ${
                              active
                                ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                                : "border-white/10 bg-white/5 text-zinc-300"
                            }`}
                          >
                            ±{option}%
                          </button>
                        );
                      })}
                    </div>
                  </div>

            <div className="text-xs text-zinc-400 space-y-1">
              <div>
                {cameraTemplateInfo
                  ? `${cameraTemplateInfo.width} × ${cameraTemplateInfo.height}`
                  : "サイズ取得中…"}
              </div>
              <div>
                使用元: {liveTemplateSourceType === "live"
                  ? "liveFrame由来"
                  : liveTemplateSourceType === "review"
                  ? "撮影画像由来"
                  : liveTemplateSourceType === "thumb"
                  ? "サムネイル由来"
                  : "未読込"}
              </div>
            </div>
          </>
        ) : (
          <div className="text-xs text-zinc-500">見本1のcamera用見本はまだありません</div>
        )}
      </div>

      {liveGuideSavedMsg ? (
        <div className="text-xs text-cyan-300">{liveGuideSavedMsg}</div>
      ) : null}
    </div>
  );

  const IconPhoto = (
    <svg
      viewBox="0 0 24 24"
      className="w-7 h-7 text-white"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );

  const IconMenu = (
    <span className="flex flex-col items-center justify-center gap-1">
      <span className="block w-5 h-0.5 bg-white rounded" />
      <span className="block w-5 h-0.5 bg-white rounded" />
      <span className="block w-5 h-0.5 bg-white rounded" />
    </span>
  );

  const ShutterButton = (
    <button
      onClick={handleCapture}
      disabled={!isReady || isCapturing}
      className={`w-20 h-20 rounded-full border-4 shadow-lg shrink-0 ${
        !isReady || isCapturing
          ? "border-zinc-600 bg-zinc-700"
          : "border-white bg-white"
      }`}
      aria-label="撮影"
      title="撮影"
    />
  );

  const PhotoButton = (
    <button
      onClick={handlePickImage}
      className="w-14 h-14 rounded-2xl border border-white/15 bg-white/5 flex items-center justify-center shadow-lg active:scale-[0.98] shrink-0"
      aria-label="写真を選択"
      title="写真を選択"
    >
      {IconPhoto}
    </button>
  );

  const SettingsButton = (
    <button
      onClick={() => router.push("/debug/settings")}
      className="w-14 h-14 rounded-2xl border border-white/15 bg-white/5 flex items-center justify-center shadow-lg active:scale-[0.98] shrink-0"
      aria-label="設定"
      title="設定"
    >
      {IconMenu}
    </button>
  );

  const BackButton = (
    <button
      onClick={() => router.push("/")}
      className="w-14 h-14 rounded-2xl border border-white/15 bg-white/5 flex items-center justify-center shadow-lg active:scale-[0.98] shrink-0 text-sm text-zinc-300"
      aria-label="戻る"
      title="戻る"
    >
      戻る
    </button>
  );

  const TopBar = (
    <div className="h-20 shrink-0 flex items-center justify-between px-4 border-b border-zinc-800 bg-zinc-950">
      <div className="text-base font-medium">デバッグカメラ</div>
      <button
        onClick={() => router.push("/")}
        className="text-sm text-zinc-300"
      >
        戻る
      </button>
    </div>
  );

  const PreviewArea = (
    <div ref={previewFrameRef} className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden">
      <video
        ref={videoRef}
        className="w-full h-full object-contain bg-black"
        playsInline
        muted
        autoPlay
        onLoadedMetadata={updateVideoDisplayRect}
        onCanPlay={updateVideoDisplayRect}
      />

      <div className="absolute inset-0 pointer-events-none">
        {videoDisplayRect.width > 0 && videoDisplayRect.height > 0 ? (() => {
          const roiRect = liveSearchRoiRect ?? {
            left: (1 - Math.max(0.05, Math.min(1, liveRoiWidthRatio))) / 2,
            top: (1 - Math.max(0.05, Math.min(1, liveRoiHeightRatio))) / 2,
            width: Math.max(0.05, Math.min(1, liveRoiWidthRatio)),
            height: Math.max(0.05, Math.min(1, liveRoiHeightRatio)),
          };
          const roiLeft = videoDisplayRect.left + videoDisplayRect.width * roiRect.left;
          const roiTop = videoDisplayRect.top + videoDisplayRect.height * roiRect.top;
          const roiWidth = videoDisplayRect.width * roiRect.width;
          const roiHeight = videoDisplayRect.height * roiRect.height;

          return (
            <>
              <div
                className="absolute border-2 border-white/75 rounded-md"
                style={{
                  width: roiWidth,
                  height: roiHeight,
                  left: roiLeft,
                  top: roiTop,
                }}
              />
              <div
                className="absolute bg-white/45"
                style={{
                  width: "1px",
                  height: roiHeight,
                  left: roiLeft + roiWidth / 2,
                  top: roiTop,
                  transform: "translateX(-0.5px)",
                }}
              />
              <div
                className="absolute bg-white/45"
                style={{
                  height: "1px",
                  width: roiWidth,
                  left: roiLeft,
                  top: roiTop + roiHeight / 2,
                  transform: "translateY(-0.5px)",
                }}
              />
            </>
          );
        })() : null}


        {liveBoxes.map((box, index) => (
          <div
            key={`live-box-${index}-${box.x}-${box.y}`}
            className="absolute rounded-md border-[3px] border-sky-400 transition-opacity duration-200"
            style={{
              left: videoDisplayRect.left + videoDisplayRect.width * box.x,
              top: videoDisplayRect.top + videoDisplayRect.height * box.y,
              width: videoDisplayRect.width * box.w,
              height: videoDisplayRect.height * box.h,
            }}
          />
        ))}
      </div>

      {!isReady && !errorMsg ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="px-5 py-3 rounded-2xl border border-white/15 bg-black/70 text-center">
            <div className="text-lg font-semibold">カメラ起動中…</div>
            <div className="mt-1 text-sm text-zinc-300">しばらくお待ちください</div>
          </div>
        </div>
      ) : null}

      {isCapturing ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/45">
          <div className="px-5 py-3 rounded-2xl border border-white/15 bg-black/70 text-center min-w-[260px]">
            <div className="text-lg font-semibold">処理中…</div>
            <div className="mt-1 text-sm text-zinc-300">
              {saveStep === "capture_start" && "撮影開始"}
              {saveStep === "canvas_create" && "保存準備中"}
              {saveStep === "canvas_draw" && "画像描画中"}
              {saveStep === "image_resize" && "保存用に縮小中"}
              {saveStep === "dataurl_create" && "画像変換中"}
              {saveStep === "sessionstorage_save" && "一時保存中"}
              {saveStep === "navigate_review" && "画面移動中"}
              {saveStep === "done" && "完了"}
              {saveStep === "error" && "エラー"}
              {saveStep === "idle" && "待機中"}
            </div>
          </div>
        </div>
      ) : null}

      <div
        className={`absolute left-1/2 top-20 -translate-x-1/2 px-4 py-2 rounded-xl border border-amber-300/30 bg-black/70 text-amber-200 text-sm transition-opacity duration-300 ${
        liveDistanceGuide ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        {liveDistanceGuide || "距離誘導"}
      </div>

      <div
        className={`absolute right-2 top-2 px-2 py-1 rounded-lg border border-white/10 bg-black/75 text-zinc-200 text-[10px] leading-tight tabular-nums whitespace-pre-line text-left max-w-[38vw] transition-opacity duration-300 ${
          liveDistanceDebug ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        {liveDistanceDebug || "score:--"}
      </div>

      <div className="absolute left-2 top-2 px-2 py-1 rounded-lg border border-cyan-400/20 bg-black/75 text-cyan-100 text-[10px] leading-tight tabular-nums whitespace-pre-line text-left max-w-[34vw]">
        {cameraDebugSummary}
      </div>

      {liveGuideOverlayMsg ? (
        <div className={`absolute right-4 top-6 px-4 py-2 rounded-xl border text-sm ${
          liveGuideOverlayMsg.includes("失敗") || liveGuideOverlayMsg.includes("タイムアウト")
            ? "border-rose-400/30 bg-black/75 text-rose-200"
            : "border-cyan-400/30 bg-black/75 text-cyan-200"
        }`}>
          {liveGuideOverlayMsg}
        </div>
      ) : null}

      {errorMsg ? (
        <div className="absolute left-1/2 top-6 -translate-x-1/2 px-4 py-2 rounded-xl border border-rose-400/30 bg-black/70 text-rose-300 text-sm">
          {errorMsg}
        </div>
      ) : null}
    </div>
  );

  return (
    <main className="h-[100dvh] bg-black text-white flex flex-col overflow-hidden">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {!isLandscape ? TopBar : null}

      {isLandscape ? (
        <div className="flex-1 min-h-0 flex bg-black overflow-hidden">
          <div className="w-72 shrink-0 p-3 flex flex-col gap-3 bg-black">
            <div className="flex items-start justify-between">
              {BackButton}
              {SettingsButton}
            </div>
            <div className="flex-1 min-h-0 overflow-auto space-y-3">
              {CameraDebugPanel}
              {DebugGuideControls}
            </div>
            <div className="flex items-center justify-between gap-3">
              {PhotoButton}
              {ShutterButton}
            </div>
          </div>

          <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
            {PreviewArea}
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 relative bg-black overflow-hidden" style={{ minHeight: "36vh" }}>
            {PreviewArea}
          </div>

          <div className="shrink-0 bg-black px-4 pt-2 pb-3 max-h-[34vh] overflow-auto space-y-3">
            {CameraDebugPanel}
            {DebugGuideControls}
          </div>

          <div className="shrink-0 bg-black px-5 pt-3 pb-8">
            <div className="flex items-center justify-between">
              {PhotoButton}
              {ShutterButton}
              {SettingsButton}
            </div>
          </div>

        </>
      )}
    </main>
  );
}