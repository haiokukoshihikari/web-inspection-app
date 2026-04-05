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
  aspectRatio?: number;
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
    mode: "none" | "pan" | "pinch";
    pointerId: number | null;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
    startScale: number;
    startDistance: number;
  }>({
    mode: "none",
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    startScale: 1,
    startDistance: 0,
  });

  const [capturedImage, setCapturedImage] = useState("");
  const [baseRect, setBaseRect] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });

  const [boxWidthRatio, setBoxWidthRatio] = useState(0.32);
  const [boxHeightRatio, setBoxHeightRatio] = useState(0.18);

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

  const updateBaseRect = () => {
    if (!frameRef.current || !imgRef.current) return;

    const frame = frameRef.current.getBoundingClientRect();
    const img = imgRef.current.getBoundingClientRect();

    setBaseRect({
      left: img.left - frame.left,
      top: img.top - frame.top,
      width: img.width,
      height: img.height,
    });
  };

  useEffect(() => {
    const onResize = () => updateBaseRect();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const displayBox = useMemo(() => {
    const width = baseRect.width * boxWidthRatio;
    const height = baseRect.height * boxHeightRatio;

    return {
      left: baseRect.left + (baseRect.width - width) / 2,
      top: baseRect.top + (baseRect.height - height) / 2,
      width,
      height,
    };
  }, [baseRect, boxWidthRatio, boxHeightRatio]);

  const getDistance = (
    a: { x: number; y: number },
    b: { x: number; y: number }
  ) => Math.hypot(a.x - b.x, a.y - b.y);

  const clampPan = (
    nextPanX: number,
    nextPanY: number,
    nextScale = imageScale
  ) => {
    const scaledWidth = baseRect.width * nextScale;
    const scaledHeight = baseRect.height * nextScale;

    const imageLeft =
      baseRect.left + nextPanX - (scaledWidth - baseRect.width) / 2;
    const imageTop =
      baseRect.top + nextPanY - (scaledHeight - baseRect.height) / 2;

    const imageRight = imageLeft + scaledWidth;
    const imageBottom = imageTop + scaledHeight;

    let correctedPanX = nextPanX;
    let correctedPanY = nextPanY;

    const boxLeft = displayBox.left;
    const boxTop = displayBox.top;
    const boxRight = displayBox.left + displayBox.width;
    const boxBottom = displayBox.top + displayBox.height;

    if (imageLeft > boxLeft) correctedPanX -= imageLeft - boxLeft;
    if (imageRight < boxRight) correctedPanX += boxRight - imageRight;
    if (imageTop > boxTop) correctedPanY -= imageTop - boxTop;
    if (imageBottom < boxBottom) correctedPanY += boxBottom - imageBottom;

    return {
      x: correctedPanX,
      y: correctedPanY,
    };
  };

  const onFramePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current[e.pointerId] = { x: e.clientX, y: e.clientY };
    const keys = Object.keys(pointersRef.current).map(Number);

    if (keys.length === 2) {
      const p1 = pointersRef.current[keys[0]];
      const p2 = pointersRef.current[keys[1]];
      dragRef.current = {
        ...dragRef.current,
        mode: "pinch",
        pointerId: null,
        startDistance: getDistance(p1, p2),
        startScale: imageScale,
        startPanX: imagePanX,
        startPanY: imagePanY,
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
        startScale: imageScale,
        startDistance: 0,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onFramePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current[e.pointerId] = { x: e.clientX, y: e.clientY };

    if (
      dragRef.current.mode === "pan" &&
      dragRef.current.pointerId === e.pointerId
    ) {
      const dx = e.clientX - dragRef.current.startClientX;
      const dy = e.clientY - dragRef.current.startClientY;
      const next = clampPan(
        dragRef.current.startPanX + dx,
        dragRef.current.startPanY + dy
      );
      setImagePanX(next.x);
      setImagePanY(next.y);
      return;
    }

    if (dragRef.current.mode === "pinch") {
      const keys = Object.keys(pointersRef.current).map(Number);
      if (keys.length < 2) return;

      const p1 = pointersRef.current[keys[0]];
      const p2 = pointersRef.current[keys[1]];
      const dist = getDistance(p1, p2);
      if (dragRef.current.startDistance <= 0) return;

      const rawScale =
        dragRef.current.startScale * (dist / dragRef.current.startDistance);
      const nextScale = Math.max(1, Math.min(4, rawScale));
      setImageScale(nextScale);

      const next = clampPan(imagePanX, imagePanY, nextScale);
      setImagePanX(next.x);
      setImagePanY(next.y);
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
    if (!capturedImage || !imgRef.current || !frameRef.current) return;

    const imgEl = imgRef.current;
    const naturalWidth = imgEl.naturalWidth;
    const naturalHeight = imgEl.naturalHeight;

    if (!naturalWidth || !naturalHeight || !baseRect.width || !baseRect.height) {
      return;
    }

    const sourceImg = new Image();
    sourceImg.onload = () => {
      const frameW = frameRef.current!.clientWidth;
      const frameH = frameRef.current!.clientHeight;

      const previewCanvas = document.createElement("canvas");
      previewCanvas.width = frameW;
      previewCanvas.height = frameH;

      const previewCtx = previewCanvas.getContext("2d");
      if (!previewCtx) return;

      previewCtx.clearRect(0, 0, frameW, frameH);
      previewCtx.fillStyle = "#111";
      previewCtx.fillRect(0, 0, frameW, frameH);

      previewCtx.save();

      const cx = baseRect.left + baseRect.width / 2 + imagePanX;
      const cy = baseRect.top + baseRect.height / 2 + imagePanY;

      previewCtx.translate(cx, cy);
      previewCtx.scale(imageScale, imageScale);

      previewCtx.drawImage(
        sourceImg,
        -baseRect.width / 2,
        -baseRect.height / 2,
        baseRect.width,
        baseRect.height
      );

      previewCtx.restore();

      const cropCanvas = document.createElement("canvas");
      const thumbBase = 140;
      const thumbW = Math.max(1, Math.round(thumbBase * boxWidthRatio * 2.2));
      const thumbH = Math.max(1, Math.round(thumbBase * boxHeightRatio * 2.2));

      cropCanvas.width = thumbW;
      cropCanvas.height = thumbH;

      const cropCtx = cropCanvas.getContext("2d");
      if (!cropCtx) return;

      cropCtx.fillStyle = "#111";
      cropCtx.fillRect(0, 0, thumbW, thumbH);

      cropCtx.drawImage(
        previewCanvas,
        displayBox.left,
        displayBox.top,
        displayBox.width,
        displayBox.height,
        0,
        0,
        thumbW,
        thumbH
      );

      const thumbUrl = cropCanvas.toDataURL("image/jpeg", 0.9);

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
        aspectRatio: thumbW / thumbH,
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
                onLoad={updateBaseRect}
                draggable={false}
              />

              <div
                className="absolute border-[3px] border-white rounded-md bg-white/5 pointer-events-none"
                style={{
                  left: displayBox.left,
                  top: displayBox.top,
                  width: displayBox.width,
                  height: displayBox.height,
                }}
              />
            </>
          ) : (
            <div className="text-zinc-400">撮影画像がありません</div>
          )}
        </div>
      </div>

      <div className="px-4 pb-4 space-y-4">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="w-14 text-sm text-zinc-300 shrink-0">横サイズ</div>
            <input
              type="range"
              min={12}
              max={80}
              value={Math.round(boxWidthRatio * 100)}
              onChange={(e) => setBoxWidthRatio(Number(e.target.value) / 100)}
              className="flex-1"
            />
            <div className="w-10 text-right text-sm text-zinc-400">
              {Math.round(boxWidthRatio * 100)}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-14 text-sm text-zinc-300 shrink-0">縦サイズ</div>
            <input
              type="range"
              min={10}
              max={60}
              value={Math.round(boxHeightRatio * 100)}
              onChange={(e) => setBoxHeightRatio(Number(e.target.value) / 100)}
              className="flex-1"
            />
            <div className="w-10 text-right text-sm text-zinc-400">
              {Math.round(boxHeightRatio * 100)}
            </div>
          </div>
        </div>

        <div className="text-center text-xs text-zinc-400">
          1本指で画像移動 / 2本指で拡大縮小 / 枠は中央固定
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