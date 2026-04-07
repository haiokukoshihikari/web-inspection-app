"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";

declare global {
  interface Window {
    cv?: any;
  }
}

const REVIEW_VERSION = "v2026-04-06-03";

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

type DebugViewMode =
  | "ORIGINAL"
  | "GRAY"
  | "EQUALIZE"
  | "CLAHE"
  | "BIN50"
  | "BIN80"
  | "EDGE";

const DEBUG_MODES: DebugViewMode[] = [
  "ORIGINAL",
  "GRAY",
  "EQUALIZE",
  "CLAHE",
  "BIN50",
  "BIN80",
  "EDGE",
];

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

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
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

function buildDebugImageFromSrcMat(
  cv: any,
  srcMat: any,
  mode: DebugViewMode
): string {
  let gray: any = null;
  let work1: any = null;
  let work2: any = null;
  let out: any = null;

  try {
    if (mode === "ORIGINAL") {
      return matToDataUrl(cv, srcMat);
    }

    gray = new cv.Mat();
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);

    if (mode === "GRAY") {
      out = new cv.Mat();
      cv.cvtColor(gray, out, cv.COLOR_GRAY2RGBA);
      return matToDataUrl(cv, out);
    }

    if (mode === "EQUALIZE") {
      work1 = new cv.Mat();
      cv.equalizeHist(gray, work1);
      out = new cv.Mat();
      cv.cvtColor(work1, out, cv.COLOR_GRAY2RGBA);
      return matToDataUrl(cv, out);
    }

    if (mode === "CLAHE") {
      const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
      work1 = new cv.Mat();
      clahe.apply(gray, work1);
      out = new cv.Mat();
      cv.cvtColor(work1, out, cv.COLOR_GRAY2RGBA);
      clahe.delete();
      return matToDataUrl(cv, out);
    }

    if (mode === "BIN50" || mode === "BIN80") {
      const thresholdValue = mode === "BIN50" ? 50 : 80;
      work1 = new cv.Mat();
      cv.GaussianBlur(gray, work1, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
      work2 = new cv.Mat();
      cv.threshold(work1, work2, thresholdValue, 255, cv.THRESH_BINARY);
      out = new cv.Mat();
      cv.cvtColor(work2, out, cv.COLOR_GRAY2RGBA);
      return matToDataUrl(cv, out);
    }

    if (mode === "EDGE") {
      work1 = new cv.Mat();
      cv.GaussianBlur(gray, work1, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
      work2 = new cv.Mat();
      cv.Canny(work1, work2, 60, 180);
      out = new cv.Mat();
      cv.cvtColor(work2, out, cv.COLOR_GRAY2RGBA);
      return matToDataUrl(cv, out);
    }

    return "";
  } finally {
    try {
      gray?.delete?.();
      work1?.delete?.();
      work2?.delete?.();
      out?.delete?.();
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

  const [samples, setSamples] = useState<SampleItem[]>(DEFAULT_SAMPLES);

  const [cvReady, setCvReady] = useState(false);
  const [cvError, setCvError] = useState("");
  const [cvStatus, setCvStatus] = useState("OpenCV 未読込");

  const [debugMode, setDebugMode] = useState<DebugViewMode>("ORIGINAL");
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);

  const [mainPreviewUrl, setMainPreviewUrl] = useState("");
  const [samplePreviewUrl, setSamplePreviewUrl] = useState("");
  const [buildingPreview, setBuildingPreview] = useState(false);

  useEffect(() => {
    try {
      const storedImage = sessionStorage.getItem("capturedImage");
      if (storedImage && storedImage.startsWith("data:image/")) {
        setCapturedImage(storedImage);
        setMainPreviewUrl(storedImage);
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
    const stopDragging = () => {};

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
    if (draftSensitivity === appliedSensitivity) return;

    const timer = window.setTimeout(() => {
      setAppliedSensitivity(draftSensitivity);
      localStorage.setItem(SENSITIVITY_KEY, String(draftSensitivity));
    }, 120);

    return () => window.clearTimeout(timer);
  }, [draftSensitivity, appliedSensitivity]);

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

  useEffect(() => {
    let cancelled = false;

    async function buildPreviews() {
      if (!cvReady || !capturedImage) return;

      const cv = window.cv;
      if (!cv) return;

      setBuildingPreview(true);

      try {
        if (debugMode === "ORIGINAL") {
          if (!cancelled) setMainPreviewUrl(capturedImage);
        } else {
          const scene = await imageSrcToMat(cv, capturedImage, 1200);
          if (scene) {
            const url = buildDebugImageFromSrcMat(cv, scene.srcMat, debugMode);
            scene.srcMat.delete();
            if (!cancelled) setMainPreviewUrl(url);
          }
        }

        const selectedSample = samples.find((s) => s.id === selectedSampleId && !!s.thumbUrl);
        if (!selectedSample?.thumbUrl) {
          if (!cancelled) setSamplePreviewUrl("");
        } else {
          if (debugMode === "ORIGINAL") {
            if (!cancelled) setSamplePreviewUrl(selectedSample.thumbUrl);
          } else {
            const smp = await imageSrcToMat(cv, selectedSample.thumbUrl, 240);
            if (smp) {
              const url = buildDebugImageFromSrcMat(cv, smp.srcMat, debugMode);
              smp.srcMat.delete();
              if (!cancelled) setSamplePreviewUrl(url);
            }
          }
        }
      } catch (e) {
        console.error("build preview error:", e);
      } finally {
        if (!cancelled) setBuildingPreview(false);
      }
    }

    buildPreviews();

    return () => {
      cancelled = true;
    };
  }, [cvReady, capturedImage, debugMode, selectedSampleId, samples]);

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
        onLoad={() => {
          setCvStatus("script.onload 発火");
        }}
        onError={() => {
          setCvReady(false);
          setCvError("OpenCVの読み込みに失敗しました");
          setCvStatus("script.onerror 発火");
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
            className={`flex-1 ${!cvReady ? "opacity-50 cursor-not-allowed" : ""}`}
            disabled={!cvReady}
          />
          <div className={`text-sm w-9 text-right ${!cvReady ? "text-zinc-500" : "text-zinc-300"}`}>
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

      <div className="px-4 pt-3">
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
      </div>

      <div className="flex-1 p-4 space-y-4">
        <div
          ref={frameRef}
          className="w-full max-h-[46vh] rounded-[1.5rem] border border-zinc-800 bg-zinc-900 relative overflow-hidden aspect-[3/4] mx-auto flex items-center justify-center"
        >
          {mainPreviewUrl ? (
            <>
              <img
                ref={imgRef}
                src={mainPreviewUrl}
                alt="撮影画像"
                className="max-w-full max-h-full object-contain block"
              />
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
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-zinc-400">
              まだ撮影画像がありません
            </div>
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
                    selected
                      ? "border-white bg-zinc-800"
                      : "border-zinc-800 bg-zinc-900"
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
                    <div className={`w-10 h-10 rounded-lg border shrink-0 ${sample.color}`} />
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
                  <div
                    className="absolute top-10 right-1 z-50"
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
                          if (selectedSampleId === sample.id) {
                            setSelectedSampleId(null);
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