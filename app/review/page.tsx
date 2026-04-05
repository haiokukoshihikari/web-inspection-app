"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";

declare global {
  interface Window {
    cv?: any;
  }
}

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

function colorFromSample(sample: SampleItem) {
  if (sample.color.includes("sky")) return "#38bdf8";
  if (sample.color.includes("emerald")) return "#34d399";
  if (sample.color.includes("amber")) return "#f59e0b";
  if (sample.color.includes("fuchsia")) return "#d946ef";
  if (sample.color.includes("cyan")) return "#06b6d4";
  return "#f43f5e";
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function bboxFromPoints(points: { x: number; y: number }[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

function expandBox(
  box: { x: number; y: number; w: number; h: number },
  padRatio: number,
  maxW: number,
  maxH: number
) {
  const padX = box.w * padRatio;
  const padY = box.h * padRatio;

  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  const r = Math.min(maxW, box.x + box.w + padX);
  const b = Math.min(maxH, box.y + box.h + padY);

  return {
    x,
    y,
    w: Math.max(1, r - x),
    h: Math.max(1, b - y),
  };
}

function isCvReady() {
  return !!(
    window.cv &&
    !(window.cv instanceof Promise) &&
    typeof window.cv.getBuildInformation === "function"
  );
}

async function imageSrcToGrayMat(
  cv: any,
  src: string,
  maxWidth: number
): Promise<{ gray: any; width: number; height: number } | null> {
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

  let srcMat: any = null;
  let gray: any = null;

  try {
    srcMat = cv.imread(canvas);
    gray = new cv.Mat();
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    return { gray, width, height };
  } finally {
    try {
      srcMat?.delete?.();
    } catch {}
  }
}

function runOrbSingleMatch(params: {
  cv: any;
  sceneGray: any;
  sceneWidth: number;
  sceneHeight: number;
  sampleGray: any;
  sampleId: string;
  color: string;
  sensitivity: number;
}): DetectionBox | null {
  const {
    cv,
    sceneGray,
    sceneWidth,
    sceneHeight,
    sampleGray,
    sampleId,
    color,
    sensitivity,
  } = params;

  let orb: any = null;
  let kpScene: any = null;
  let desScene: any = null;
  let kpSample: any = null;
  let desSample: any = null;
  let matcher: any = null;
  let knnMatches: any = null;
  let srcPts: any = null;
  let dstPts: any = null;
  let H: any = null;
  let corners: any = null;
  let transformed: any = null;
  let mask: any = null;

  try {
    orb = new cv.ORB(900);

    kpScene = new cv.KeyPointVector();
    desScene = new cv.Mat();
    orb.detectAndCompute(sceneGray, new cv.Mat(), kpScene, desScene);

    kpSample = new cv.KeyPointVector();
    desSample = new cv.Mat();
    orb.detectAndCompute(sampleGray, new cv.Mat(), kpSample, desSample);

    if (
      desScene.empty() ||
      desSample.empty() ||
      kpScene.size() < 10 ||
      kpSample.size() < 10
    ) {
      return null;
    }

    matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
    knnMatches = new cv.DMatchVectorVector();
    matcher.knnMatch(desSample, desScene, knnMatches, 2);

    const ratioThreshold = 0.72 + (sensitivity / 100) * 0.16;
    const good: any[] = [];

    for (let i = 0; i < knnMatches.size(); i++) {
      const m = knnMatches.get(i);
      if (m.size() >= 2) {
        const m1 = m.get(0);
        const m2 = m.get(1);
        if (m1.distance < ratioThreshold * m2.distance) {
          good.push(m1);
        }
      }
      m.delete();
    }

    if (good.length < 8) return null;

    srcPts = new cv.Mat(good.length, 1, cv.CV_32FC2);
    dstPts = new cv.Mat(good.length, 1, cv.CV_32FC2);

    for (let i = 0; i < good.length; i++) {
      const gm = good[i];
      const sp = kpSample.get(gm.queryIdx).pt;
      const dp = kpScene.get(gm.trainIdx).pt;

      srcPts.data32F[i * 2] = sp.x;
      srcPts.data32F[i * 2 + 1] = sp.y;
      dstPts.data32F[i * 2] = dp.x;
      dstPts.data32F[i * 2 + 1] = dp.y;
    }

    mask = new cv.Mat();
    H = cv.findHomography(srcPts, dstPts, cv.RANSAC, 5, mask);

    if (!H || H.empty()) return null;

    const inlierCount = cv.countNonZero(mask);
    if (inlierCount < 6) return null;

    const sw = sampleGray.cols;
    const sh = sampleGray.rows;

    corners = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      sw, 0,
      sw, sh,
      0, sh,
    ]);
    transformed = new cv.Mat();
    cv.perspectiveTransform(corners, transformed, H);

    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < 4; i++) {
      pts.push({
        x: transformed.data32F[i * 2],
        y: transformed.data32F[i * 2 + 1],
      });
    }

    const rawBox = bboxFromPoints(pts);
    const padded = expandBox(rawBox, 0.12, sceneWidth, sceneHeight);

    const normX = clamp01(padded.x / sceneWidth);
    const normY = clamp01(padded.y / sceneHeight);
    const normW = clamp01(padded.w / sceneWidth);
    const normH = clamp01(padded.h / sceneHeight);

    if (normW < 0.02 || normH < 0.02) return null;

    return {
      x: normX,
      y: normY,
      w: normW,
      h: normH,
      color,
      sampleId,
      score: inlierCount + good.length * 0.1,
    };
  } catch (e) {
    console.error("runOrbSingleMatch error:", e);
    return null;
  } finally {
    try {
      orb?.delete?.();
      kpScene?.delete?.();
      desScene?.delete?.();
      kpSample?.delete?.();
      desSample?.delete?.();
      matcher?.delete?.();
      knnMatches?.delete?.();
      srcPts?.delete?.();
      dstPts?.delete?.();
      H?.delete?.();
      corners?.delete?.();
      transformed?.delete?.();
      mask?.delete?.();
    } catch {}
  }
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

  const [cvReady, setCvReady] = useState(false);
  const [cvError, setCvError] = useState("");
  const [cvStatus, setCvStatus] = useState("OpenCV 未読込");

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
    const stopDragging = () => setIsSliderDragging(false);

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
          setCvStatus("cv は Promise / await 開始");
          cvObj = await cvObj;
          if (cancelled) return;
          window.cv = cvObj;
          setCvStatus("cv Promise 解決完了");
        }

        if (cvObj && typeof cvObj.getBuildInformation === "function") {
          markReady(cvObj);
          return;
        }

        setCvStatus("cv あり / getBuildInformation待ち");
      } catch (e: any) {
        markError(`失敗: ${String(e?.message ?? e)}`);
      }
    };

    setCvReady(false);
    setCvError("");
    setCvStatus("OpenCV 読込確認開始");

    timeoutId = window.setTimeout(() => {
      markError("OpenCV load timeout");
    }, 20000);

    pollId = window.setInterval(() => {
      tryResolve();
    }, 300);

    tryResolve();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

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
      if (!cvReady || !capturedImage || visibleSamples.length === 0) {
        setDetections([]);
        return;
      }

      const cv = window.cv;
      if (!cv) {
        setDetections([]);
        return;
      }

      setDetections([]);
      setPrepareDetecting(true);

      await new Promise((resolve) => setTimeout(resolve, 180));
      if (cancelled) return;

      setPrepareDetecting(false);
      setDetecting(true);

      let sceneGray: any = null;

      try {
        const sceneResult = await imageSrcToGrayMat(cv, capturedImage, 900);
        if (!sceneResult) {
          setDetections([]);
          return;
        }

        sceneGray = sceneResult.gray;
        const sceneWidth = sceneResult.width;
        const sceneHeight = sceneResult.height;

        const nextDetections: DetectionBox[] = [];

        for (const sample of visibleSamples) {
          if (cancelled) return;
          if (!sample.thumbUrl) continue;

          const sampleResult = await imageSrcToGrayMat(cv, sample.thumbUrl, 320);
          if (!sampleResult) continue;

          const sampleGray = sampleResult.gray;

          const box = runOrbSingleMatch({
            cv,
            sceneGray,
            sceneWidth,
            sceneHeight,
            sampleGray,
            sampleId: sample.id,
            color: colorFromSample(sample),
            sensitivity: appliedSensitivity,
          });

          sampleGray.delete();

          if (box) nextDetections.push(box);

          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        if (!cancelled) setDetections(nextDetections);
      } catch (e) {
        console.error("ORB detection error:", e);
        if (!cancelled) setDetections([]);
      } finally {
        try {
          sceneGray?.delete?.();
        } catch {}
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
  }, [cvReady, capturedImage, visibleSamples, appliedSensitivity]);

  const overlayMuted = isAdjustingSensitivity || prepareDetecting || detecting || !cvReady;
  const overlayMessage = !cvReady
    ? "OpenCV 読込中..."
    : isAdjustingSensitivity
      ? "調整中..."
      : prepareDetecting
        ? "準備中..."
        : detecting
          ? "検知中..."
          : "";

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <Script
        src="/opencv/opencv.js"
        strategy="afterInteractive"
        onLoad={() => {
          setCvStatus("script.onload 発火");
        }}
        onError={() => {
          setCvReady(false);
          setCvError("OpenCVの読み込みに失敗しました");
          setCvStatus("script.onerror 発火");
        }}
      />

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
            disabled={detecting || prepareDetecting || !cvReady}
            className={`flex-1 ${(detecting || prepareDetecting || !cvReady) ? "opacity-50 cursor-not-allowed" : ""}`}
          />
          <div className={`text-sm w-9 text-right ${(detecting || prepareDetecting || !cvReady) ? "text-zinc-500" : "text-zinc-300"}`}>
            {draftSensitivity}
          </div>
        </div>

        <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-sm">欠落候補</div>
          <button
            onClick={handleMissingToggle}
            className={`w-14 h-8 rounded-full transition ${missingOn ? "bg-rose-500" : "bg-zinc-700"}`}
          >
            <span
              className={`block w-6 h-6 bg-white rounded-full transition translate-y-1 ${missingOn ? "translate-x-7" : "translate-x-1"}`}
            />
          </button>
        </div>

        <div className="text-xs text-zinc-400">{cvStatus}</div>
        {cvError ? <div className="text-xs text-rose-400">{cvError}</div> : null}
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