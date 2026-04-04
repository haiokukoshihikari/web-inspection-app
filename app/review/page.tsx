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

type Box = {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
};

const DEFAULT_SAMPLES: SampleItem[] = [
  { id: "1", count: 12, color: "border-sky-400 bg-sky-500/20", aspectRatio: 1 },
  { id: "2", count: 8, color: "border-emerald-400 bg-emerald-500/20", aspectRatio: 1 },
  { id: "3", count: 5, color: "border-amber-400 bg-amber-500/20", aspectRatio: 1 },
  { id: "4", count: 3, color: "border-fuchsia-400 bg-fuchsia-500/20", aspectRatio: 1 },
];

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

  const displayBoxH = 0.12;
  const displayBoxW =
    imageRect.width > 0 && imageRect.height > 0
      ? (imageRect.height / imageRect.width) * displayBoxH
      : 0.12;

  const normalBoxes: Box[] = [
    { x: 0.12, y: 0.18, w: displayBoxW, h: displayBoxH, color: "#38bdf8" },
    { x: 0.30, y: 0.18, w: displayBoxW, h: displayBoxH, color: "#38bdf8" },
    { x: 0.12, y: 0.36, w: displayBoxW, h: displayBoxH, color: "#34d399" },
    { x: 0.30, y: 0.36, w: displayBoxW, h: displayBoxH, color: "#34d399" },
  ];

  const missingBoxes: Box[] = missingOn
    ? [{ x: 0.48, y: 0.18, w: displayBoxW, h: displayBoxH, color: "#f43f5e" }]
    : [];

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

              {normalBoxes.map((box, index) => (
                <div
                  key={`normal-${index}`}
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

              {missingBoxes.map((box, index) => (
                <div
                  key={`missing-${index}`}
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
            const ratio = sample.aspectRatio && sample.aspectRatio > 0 ? sample.aspectRatio : 1;
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

                  <div className="text-lg font-semibold truncate">{sample.count}</div>
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