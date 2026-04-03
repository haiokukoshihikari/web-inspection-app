"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const SAMPLES_KEY = "inspection:samples";
const MAX_SAMPLES = 6;

type SampleItem = {
  id: string;
  count: number;
  color: string;
  thumbUrl?: string;
};

const SAMPLE_COLORS = [
  "border-sky-400 bg-sky-500/20",
  "border-emerald-400 bg-emerald-500/20",
  "border-amber-400 bg-amber-500/20",
  "border-fuchsia-400 bg-fuchsia-500/20",
  "border-cyan-400 bg-cyan-500/20",
  "border-rose-400 bg-rose-500/20",
];

type PointerMap = Record<number, { x: number; y: number }>;

export default function AddSamplePage() {
  const router = useRouter();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const pointersRef = useRef<PointerMap>({});
  const dragRef = useRef<{
    mode: "none" | "box-drag" | "pan" | "pinch";
    pointerId: number | null;
    startClientX: number;
    startClientY: number;
    startCenterX: number;
    startCenterY: number;
    startPanX: number;
    startPanY: number;
    startScale: number;
    startDistance: number;
    startImageCenterX: number;
    startImageCenterY: number;
  }>({
    mode: "none",
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    startCenterX: 0,
    startCenterY: 0,
    startPanX: 0,
    startPanY: 0,
    startScale: 1,
    startDistance: 0,
    startImageCenterX: 0,
    startImageCenterY: 0,
  });

  const [capturedImage, setCapturedImage] = useState("");
  const [imageRect, setImageRect] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });

  const [naturalSize, setNaturalSize] = useState({
    width: 0,
    height: 0,
  });

  const [boxSize, setBoxSize] = useState(0.22);
  const [centerX, setCenterX] = useState(0.5);
  const [centerY, setCenterY] = useState(0.5);

  // 画像表示操作
  const [imageScale, setImageScale] = useState(1);
  const [imagePanX, setImagePanX] = useState(0);
  const [imagePanY, setImagePanY] = useState(0);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("capturedImage");
      if (stored && stored.startsWith("data:image/")) {
        setCapturedImage(stored);
      }
    } catch (e) {
      console.error("capturedImage load error:", e);
    }
  }, []);

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

  const clampCenter = (
    nextCenterX: number,
    nextCenterY: number,
    nextBoxSize: number = boxSize
  ) => {
    const half = nextBoxSize / 2;
    return {
      x: Math.max(half, Math.min(nextCenterX, 1 - half)),
      y: Math.max(half, Math.min(nextCenterY, 1 - half)),
    };
  };

  const displayBox = useMemo(() => {
    const width = imageRect.width * boxSize;
    const height = imageRect.height * boxSize;

    const rawLeft = imageRect.left + imageRect.width * centerX - width / 2;
    const rawTop = imageRect.top + imageRect.height * centerY - height / 2;

    const minLeft = imageRect.left;
    const maxLeft = imageRect.left + imageRect.width - width;
    const minTop = imageRect.top;
    const maxTop = imageRect.top + imageRect.height - height;

    const left = Math.max(minLeft, Math.min(rawLeft, maxLeft));
    const top = Math.max(minTop, Math.min(rawTop, maxTop));

    return {
      left,
      top,
      width,
      height,
    };
  }, [imageRect, boxSize, centerX, centerY]);

  const getDistance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  const getMidpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });

  const handleSmaller = () => {
    const nextSize = Math.max(0.12, boxSize - 0.03);
    setBoxSize(nextSize);
    const next = clampCenter(centerX, centerY, nextSize);
    setCenterX(next.x);
    setCenterY(next.y);
  };

  const handleLarger = () => {
    const nextSize = Math.min(0.5, boxSize + 0.03);
    setBoxSize(nextSize);
    const next = clampCenter(centerX, centerY, nextSize);
    setCenterX(next.x);
    setCenterY(next.y);
  };

  const onBoxPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!imageRect.width || !imageRect.height) return;

    pointersRef.current[e.pointerId] = { x: e.clientX, y: e.clientY };

    dragRef.current = {
      ...dragRef.current,
      mode: "box-drag",
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startCenterX: centerX,
      startCenterY: centerY,
    };

    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onBoxPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current[e.pointerId] = { x: e.clientX, y: e.clientY };

    if (dragRef.current.mode !== "box-drag") return;
    if (dragRef.current.pointerId !== e.pointerId) return;
    if (!imageRect.width || !imageRect.height) return;

    const dx = e.clientX - dragRef.current.startClientX;
    const dy = e.clientY - dragRef.current.startClientY;

    const nextCenterX = dragRef.current.startCenterX + dx / imageRect.width;
    const nextCenterY = dragRef.current.startCenterY + dy / imageRect.height;

    const next = clampCenter(nextCenterX, nextCenterY);
    setCenterX(next.x);
    setCenterY(next.y);
  };

  const onBoxPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    delete pointersRef.current[e.pointerId];
    if (dragRef.current.pointerId === e.pointerId) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {}
      dragRef.current.mode = "none";
      dragRef.current.pointerId = null;
    }
  };

  const onFramePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current[e.pointerId] = { x: e.clientX, y: e.clientY };

    const keys = Object.keys(pointersRef.current).map(Number);

    if (keys.length === 2) {
      const p1 = pointersRef.current[keys[0]];
      const p2 = pointersRef.current[keys[1]];
      const dist = getDistance(p1, p2);
      const mid = getMidpoint(p1, p2);

      dragRef.current = {
        ...dragRef.current,
        mode: "pinch",
        pointerId: null,
        startDistance: dist,
        startScale: imageScale,
        startPanX: imagePanX,
        startPanY: imagePanY,
        startImageCenterX: mid.x,
        startImageCenterY: mid.y,
      };
      return;
    }

    if (keys.length === 1) {
      dragRef.current = {
        ...dragRef.current,
        mode: "pan",
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPanX: imagePanX,
        startPanY: imagePanY,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onFramePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current[e.pointerId] = { x: e.clientX, y: e.clientY };

    if (dragRef.current.mode === "pan" && dragRef.current.pointerId === e.pointerId) {
      const dx = e.clientX - dragRef.current.startClientX;
      const dy = e.clientY - dragRef.current.startClientY;
      setImagePanX(dragRef.current.startPanX + dx);
      setImagePanY(dragRef.current.startPanY + dy);
      return;
    }

    if (dragRef.current.mode === "pinch") {
      const keys = Object.keys(pointersRef.current).map(Number);
      if (keys.length < 2) return;

      const p1 = pointersRef.current[keys[0]];
      const p2 = pointersRef.current[keys[1]];
      const dist = getDistance(p1, p2);

      if (dragRef.current.startDistance <= 0) return;

      const nextScale = Math.max(
        1,
        Math.min(4, dragRef.current.startScale * (dist / dragRef.current.startDistance))
      );
      setImageScale(nextScale);
    }
  };

  const onFramePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    delete pointersRef.current[e.pointerId];

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}

    const keys = Object.keys(pointersRef.current).map(Number);

    if (keys.length === 0) {
      dragRef.current.mode = "none";
      dragRef.current.pointerId = null;
    } else if (keys.length === 1) {
      const remainId = keys[0];
      const remain = pointersRef.current[remainId];
      dragRef.current = {
        ...dragRef.current,
        mode: "pan",
        pointerId: remainId,
        startClientX: remain.x,
        startClientY: remain.y,
        startPanX: imagePanX,
        startPanY: imagePanY,
      };
    }
  };

  const handleSave = () => {
    if (!capturedImage || !imgRef.current) return;

    const imgEl = imgRef.current;
    const naturalWidth = imgEl.naturalWidth;
    const naturalHeight = imgEl.naturalHeight;

    if (!naturalWidth || !naturalHeight || !imageRect.width || !imageRect.height) {
      return;
    }

    const scaleX = naturalWidth / imageRect.width;
    const scaleY = naturalHeight / imageRect.height;

    const cropX = (displayBox.left - imageRect.left) * scaleX;
    const cropY = (displayBox.top - imageRect.top) * scaleY;
    const cropW = displayBox.width * scaleX;
    const cropH = displayBox.height * scaleY;

    const sourceImg = new Image();
    sourceImg.onload = () => {
      const canvas = document.createElement("canvas");
      const thumbSize = 120;
      canvas.width = thumbSize;
      canvas.height = thumbSize;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, thumbSize, thumbSize);

      ctx.drawImage(
        sourceImg,
        cropX,
        cropY,
        cropW,
        cropH,
        0,
        0,
        thumbSize,
        thumbSize
      );

      const thumbUrl = canvas.toDataURL("image/jpeg", 0.9);

      let existing: SampleItem[] = [];
      try {
        const raw = localStorage.getItem(SAMPLES_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) existing = parsed;
        }
      } catch (e) {
        console.error("sample load error:", e);
      }

      if (existing.length >= MAX_SAMPLES) {
        alert("見本は最大6件までです。");
        return;
      }

      const nextColor = SAMPLE_COLORS[existing.length % SAMPLE_COLORS.length];

      const nextItem: SampleItem = {
        id: String(Date.now()),
        count: 0,
        color: nextColor,
        thumbUrl,
      };

      const nextSamples = [...existing, nextItem];
      localStorage.setItem(SAMPLES_KEY, JSON.stringify(nextSamples));

      router.push("/review");
    };

    sourceImg.src = capturedImage;
  };

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800 bg-zinc-950">
        <div className="text-base font-medium">見本にしたい部分を囲って下さい</div>
        <button
          onClick={() => router.push("/review")}
          className="text-sm text-zinc-300"
        >
          戻る
        </button>
      </div>

      <div className="flex-1 p-4">
        <div
          ref={frameRef}
          className="w-full max-h-[58vh] rounded-[1.5rem] border border-zinc-800 bg-zinc-900 relative overflow-hidden aspect-[3/4] mx-auto flex items-center justify-center"
          style={{ touchAction: "none" }}
          onPointerDown={onFramePointerDown}
          onPointerMove={onFramePointerMove}
          onPointerUp={onFramePointerUp}
          onPointerCancel={onFramePointerUp}
        >
          {capturedImage ? (
            <>
              <img
                ref={imgRef}
                src={capturedImage}
                alt="撮影画像"
                className="max-w-full max-h-full object-contain block select-none"
                style={{
                  transform: `translate(${imagePanX}px, ${imagePanY}px) scale(${imageScale})`,
                  transformOrigin: "center center",
                }}
                onLoad={() => {
                  if (imgRef.current) {
                    setNaturalSize({
                      width: imgRef.current.naturalWidth,
                      height: imgRef.current.naturalHeight,
                    });
                  }
                  updateImageRect();
                }}
                draggable={false}
              />

              <div
                className="absolute border-[3px] border-white rounded-md bg-white/5"
                style={{
                  left: displayBox.left,
                  top: displayBox.top,
                  width: displayBox.width,
                  height: displayBox.height,
                  cursor: "grab",
                }}
                onPointerDown={onBoxPointerDown}
                onPointerMove={onBoxPointerMove}
                onPointerUp={onBoxPointerUp}
                onPointerCancel={onBoxPointerUp}
              />
            </>
          ) : (
            <div className="text-zinc-400">撮影画像がありません</div>
          )}
        </div>
      </div>

      <div className="px-4 pb-4 space-y-3">
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={handleSmaller}
            className="px-4 py-2 rounded-2xl border border-zinc-700 bg-zinc-900"
          >
            小さく
          </button>
          <button
            onClick={handleLarger}
            className="px-4 py-2 rounded-2xl border border-zinc-700 bg-zinc-900"
          >
            大きく
          </button>
        </div>

        <div className="text-center text-xs text-zinc-400">
          1本指で画像移動 / 2本指で拡大縮小 / 枠ドラッグで位置調整
        </div>

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => router.push("/review")}
            className="px-6 py-3 rounded-2xl border border-zinc-700 bg-zinc-900"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            className="px-6 py-3 rounded-2xl bg-white text-black font-semibold"
          >
            登録
          </button>
        </div>
      </div>
    </main>
  );
}