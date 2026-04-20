"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
};

const PENDING_SHARED_PROFILE_KEY = "inspection:pendingSharedProfile";

const SAMPLES_KEY = "inspection:samples";
const DEFAULT_LIVE_GUIDE_THRESHOLD_OFFSET = 0.12;
const DEFAULT_LIVE_GUIDE_INTERVAL_MS = 1500;
const LIVE_MAX_BOXES = 2;
const LIVE_ROI_WIDTH_RATIO = 0.5;
const LIVE_ROI_HEIGHT_RATIO = 0.3;
const LIVE_PROCESS_LONG_SIDE = 640;
const LIVE_TEMPLATE_LONG_SIDE = 64;
const LIVE_SEARCH_STEP = 4;
const LIVE_TEMPLATE_SCALE_FACTORS = [0.95, 1.0, 1.05] as const;

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
};

type LiveBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  matchW: number;
  matchH: number;
  score: number;
};

type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

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
  const [liveGuideActive, setLiveGuideActive] = useState(false);
  const [liveGuideThresholdOffset, setLiveGuideThresholdOffset] = useState(DEFAULT_LIVE_GUIDE_THRESHOLD_OFFSET);
  const [liveGuideIntervalMs, setLiveGuideIntervalMs] = useState(DEFAULT_LIVE_GUIDE_INTERVAL_MS);
  const [liveProcessInfo, setLiveProcessInfo] = useState("");
  const [liveGuideSavedMsg, setLiveGuideSavedMsg] = useState("");
  const [liveGuideSaving, setLiveGuideSaving] = useState(false);
  const [liveGuideOverlayMsg, setLiveGuideOverlayMsg] = useState("");
  const [firstSamplePreviewUrl, setFirstSamplePreviewUrl] = useState("");
  const [cameraTemplateInfo, setCameraTemplateInfo] = useState<{ width: number; height: number } | null>(null);
  const [videoDisplayRect, setVideoDisplayRect] = useState<Rect>({ left: 0, top: 0, width: 0, height: 0 });
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
  } | null>(null);
  const liveRunningRef = useRef(false);
  const liveTimerRef = useRef<number | null>(null);
  const liveBoxesHoldUntilRef = useRef(0);


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

    return () => {
      cancelled = true;
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
          setLiveBoxes([]);
          setLiveGuideActive(false);
          return;
        }

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          liveTemplateRef.current = null;
          setLiveBoxes([]);
          setLiveGuideActive(false);
          return;
        }

        const sample = parsed[0] as SampleItem;
        const src = sample.cameraCompareUrl || sample.compareUrl || sample.thumbUrl;
        if (!src) {
          liveTemplateRef.current = null;
          setLiveBoxes([]);
          setLiveGuideActive(false);
          return;
        }

        const img = await dataUrlToImage(src);
        if (cancelled) return;

        const baseLongSide = Math.max(img.naturalWidth, img.naturalHeight);
        const baseScale = Math.min(1, LIVE_TEMPLATE_LONG_SIDE / Math.max(1, baseLongSide));
        const baseWidth = Math.max(16, Math.round(img.naturalWidth * baseScale));
        const baseHeight = Math.max(16, Math.round(img.naturalHeight * baseScale));

        const variants = LIVE_TEMPLATE_SCALE_FACTORS.map((factor) => {
          const variantWidth = Math.max(16, Math.round(baseWidth * factor));
          const variantHeight = Math.max(16, Math.round(baseHeight * factor));
          const canvas = document.createElement('canvas');
          canvas.width = variantWidth;
          canvas.height = variantHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            throw new Error("テンプレート描画に失敗しました。");
          }
          ctx.drawImage(img, 0, 0, variantWidth, variantHeight);
          return {
            scale: factor,
            gray: edgeNormalize(toGrayArray(ctx, variantWidth, variantHeight), variantWidth, variantHeight),
            width: variantWidth,
            height: variantHeight,
            rawWidth: img.naturalWidth * factor,
            rawHeight: img.naturalHeight * factor,
          };
        });

        liveTemplateRef.current = { sample, variants, baseWidth, baseHeight };
        setLiveGuideActive(true);
      } catch (error) {
        console.error('ライブ簡易検査の見本読み込みに失敗しました', error);
        liveTemplateRef.current = null;
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
  }, []);

  const runLiveCheck = useCallback(async () => {
    if (liveRunningRef.current || isCapturing || !isReady) return;
    const video = videoRef.current;
    const tpl = liveTemplateRef.current;
    if (!video || !tpl) {
      setLiveBoxes([]);
      liveBoxesHoldUntilRef.current = 0;
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
      const roiW = Math.max(maxTplWidth + 4, Math.round(pw * LIVE_ROI_WIDTH_RATIO));
      const roiH = Math.max(maxTplHeight + 4, Math.round(ph * LIVE_ROI_HEIGHT_RATIO));
      const roiX = Math.round((pw - roiW) / 2);
      const roiY = Math.round((ph - roiH) / 2);

      const gray = edgeNormalize(toGrayArray(ctx, pw, ph), pw, ph);
      setLiveProcessInfo(`${pw}x${ph} / tpl ${tpl.baseWidth}x${tpl.baseHeight} / scale ±5%`);
      const results: LiveBox[] = [];
      const matchThreshold = sampleSensitivityThreshold(tpl.sample);
      const highThreshold = clamp(Number((matchThreshold + liveGuideThresholdOffset).toFixed(2)), 0.35, 0.95);
      const earlyThreshold = clamp(Number((highThreshold + 0.06).toFixed(2)), 0.4, 0.99);

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

            const box: LiveBox = {
              x: Math.max(0, x / pw - offsetXNorm),
              y: Math.max(0, y / ph - offsetYNorm),
              w: rawWNorm,
              h: rawHNorm,
              matchW: matchWNorm,
              matchH: matchHNorm,
              score,
            };

            const overlaps = results.some((r) => {
              const x1 = Math.max(r.x, box.x);
              const y1 = Math.max(r.y, box.y);
              const x2 = Math.min(r.x + r.matchW, box.x + box.matchW);
              const y2 = Math.min(r.y + r.matchH, box.y + box.matchH);
              const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
              const union = r.matchW * r.matchH + box.matchW * box.matchH - inter;
              return union > 0 && inter / union > 0.35;
            });
            if (!overlaps) results.push(box);
            if (results.length >= LIVE_MAX_BOXES && score >= earlyThreshold) break;
          }
          if (results.length >= LIVE_MAX_BOXES) break;
        }
        if (results.length >= LIVE_MAX_BOXES) break;
      }

}