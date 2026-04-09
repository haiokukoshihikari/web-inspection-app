"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const SAMPLES_KEY = "inspection:samples";
const RESOLUTION_KEY = "inspection:compareResolution";

const MAX_SAMPLES = 6;
const PAGE_VERSION = "add-sample-stable-05";

const MIN_BOX_W = 0.08;
const MAX_BOX_W = 0.8;
const MIN_BOX_H = 0.06;
const MAX_BOX_H = 0.6;
const MAX_IMAGE_SCALE = 2.5;

type CompareResolutionMode = 1200 | 1600 | 2000 | 2400;

type SampleItem = {
  id: string;
  count: number;
  color: string;
  thumbUrl?: string;
  compareUrl?: string;
  aspectRatio?: number;
  savedResolution?: CompareResolutionMode;
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

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

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
  const [compareResolution, setCompareResolution] =
    useState<CompareResolutionMode>(1200);

  const [compareBasis, setCompareBasis] = useState({ width: 0, height: 0 });

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

      const savedRes = localStorage.getItem(RESOLUTION_KEY);
      if (savedRes) {
        const n = Number(savedRes) as CompareResolutionMode;
        if ([1200, 1600, 2000, 2400].includes(n)) {
          setCompareResolution(n);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!capturedImage) return;

    loadImage(capturedImage).then((img) => {
      const compareScale = Math.min(1, compareResolution / img.naturalWidth);
      setCompareBasis({
        width: Math.max(1, Math.round(img.naturalWidth * compareScale)),
        height: Math.max(1, Math.round(img.naturalHeight * compareScale)),
      });
    });
  }, [capturedImage, compareResolution]);

  const safeBoxWidthRatio = clamp(boxWidthRatio, MIN_BOX_W, MAX_BOX_W);
  const safeBoxHeightRatio = clamp(boxHeightRatio, MIN_BOX_H, MAX_BOX_H);

  const updateBaseRect = () => {
    if (!frameRef.current || !imgRef.current) return;

    const frame = frameRef.current;
    const img = imgRef.current;

    const frameWidth = frame.clientWidth;
    const frameHeight = frame.clientHeight;
    const naturalWidth = img.naturalWidth;
    const naturalHeight = img.naturalHeight;

    if (!frameWidth || !frameHeight || !naturalWidth || !naturalHeight) return;

    const fitScale = Math.min(frameWidth / naturalWidth, frameHeight / naturalHeight);
    const width = naturalWidth * fitScale;
    const height = naturalHeight * fitScale;
    const left = (frameWidth - width) / 2;
    const top = (frameHeight - height) / 2;

    setBaseRect({ left, top, width, height });
  };

  useEffect(() => {
    const onResize = () => updateBaseRect();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 見た目の枠は常に中央固定
  const displayBox = useMemo(() => {
    const maxWidth = Math.max(0, baseRect.width);
    const maxHeight = Math.max(0, baseRect.height);

    const rawWidth = maxWidth * safeBoxWidthRatio;
    const rawHeight = maxHeight * safeBoxHeightRatio;

    const width = Math.min(rawWidth, maxWidth);
    const height = Math.min(rawHeight, maxHeight);

    return {
      left: baseRect.left + (baseRect.width - width) / 2,
      top: baseRect.top + (baseRect.height - height) / 2,
      width,
      height,
    };
  }, [baseRect, safeBoxWidthRatio, safeBoxHeightRatio]);

  // 固定枠が今どの画像座標を見ているかを毎回計算
  const cropRectImage = useMemo(() => {
    if (!compareBasis.width || !compareBasis.height || !baseRect.width || !baseRect.height) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    const scaledWidth = baseRect.width * imageScale;
    const scaledHeight = baseRect.height * imageScale;

    const imageLeft =
      baseRect.left + imagePanX - (scaledWidth - baseRect.width) / 2;
    const imageTop =
      baseRect.top + imagePanY - (scaledHeight - baseRect.height) / 2;

    const cropLeftOnScreen = displayBox.left - imageLeft;
    const cropTopOnScreen = displayBox.top - imageTop;

    let x = Math.round((cropLeftOnScreen / scaledWidth) * compareBasis.width);
    let y = Math.round((cropTopOnScreen / scaledHeight) * compareBasis.height);
    let width = Math.round((displayBox.width / scaledWidth) * compareBasis.width);
    let height = Math.round((displayBox.height / scaledHeight) * compareBasis.height);

    x = clamp(x, 0, Math.max(0, compareBasis.width - 1));
    y = clamp(y, 0, Math.max(0, compareBasis.height - 1));
    width = clamp(width, 1, compareBasis.width - x);
    height = clamp(height, 1, compareBasis.height - y);

    return { x, y, width, height };
  }, [
    compareBasis.width,
    compareBasis.height,
    baseRect,
    displayBox,
    imageScale,
    imagePanX,
    imagePanY,
  ]);

  const getDistance = (
    a: { x: number; y: number },
    b: { x: number; y: number }
  ) => Math.hypot(a.x - b.x, a.y - b.y);

  // 枠は固定なので、画像が枠から外れない範囲でだけ移動・拡大できる
  const clampPan = (
    nextPanX: number,
    nextPanY: number,
    nextScale = imageScale
  ) => {
    const scaledWidth = baseRect.width * nextScale;
    const scaledHeight = baseRect.height * nextScale;

    let correctedPanX = nextPanX;
    let correctedPanY = nextPanY;

    const imageLeft =
      baseRect.left + correctedPanX - (scaledWidth - baseRect.width) / 2;
    const imageTop =
      baseRect.top + correctedPanY - (scaledHeight - baseRect.height) / 2;
    const imageRight = imageLeft + scaledWidth;
    const imageBottom = imageTop + scaledHeight;

    const boxLeft = displayBox.left;
    const boxTop = displayBox.top;
    const boxRight = displayBox.left + displayBox.width;
    const boxBottom = displayBox.top + displayBox.height;

    if (imageLeft > boxLeft) correctedPanX -= imageLeft - boxLeft;
    if (imageRight < boxRight) correctedPanX += boxRight - imageRight;
    if (imageTop > boxTop) correctedPanY -= imageTop - boxTop;
    if (imageBottom < boxBottom) correctedPanY += boxBottom - imageBottom;

    return { x: correctedPanX, y: correctedPanY };
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

      const nextScale = clamp(rawScale, 1, MAX_IMAGE_SCALE);
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

  const handleSave = async () => {
    if (!capturedImage || !compareBasis.width || !compareBasis.height) return;

    const sourceImg = await loadImage(capturedImage);
    const naturalWidth = sourceImg.naturalWidth;
    const naturalHeight = sourceImg.naturalHeight;
    if (!naturalWidth || !naturalHeight) return;

    const compareScale = Math.min(1, compareResolution / naturalWidth);
    const compareWidth = Math.max(1, Math.round(naturalWidth * compareScale));
    const compareHeight = Math.max(1, Math.round(naturalHeight * compareScale));

    const compareCanvas = document.createElement("canvas");
    compareCanvas.width = compareWidth;
    compareCanvas.height = compareHeight;
    const compareCtx = compareCanvas.getContext("2d");
    if (!compareCtx) return;

    compareCtx.drawImage(sourceImg, 0, 0, compareWidth, compareHeight);

    const srcX = clamp(cropRectImage.x, 0, compareWidth - 1);
    const srcY = clamp(cropRectImage.y, 0, compareHeight - 1);
    const srcW = clamp(cropRectImage.width, 1, compareWidth - srcX);
    const srcH = clamp(cropRectImage.height, 1, compareHeight - srcY);

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = srcW;
    cropCanvas.height = srcH;
    const cropCtx = cropCanvas.getContext("2d");
    if (!cropCtx) return;

    cropCtx.drawImage(
      compareCanvas,
      srcX,
      srcY,
      srcW,
      srcH,
      0,
      0,
      srcW,
      srcH
    );

    const compareUrl = cropCanvas.toDataURL("image/png");

    const thumbCanvas = document.createElement("canvas");
    const thumbBase = 140;
    const thumbW = Math.max(1, Math.round(thumbBase * safeBoxWidthRatio * 2.2));
    const thumbH = Math.max(1, Math.round(thumbBase * safeBoxHeightRatio * 2.2));
    thumbCanvas.width = thumbW;
    thumbCanvas.height = thumbH;
    const thumbCtx = thumbCanvas.getContext("2d");
    if (!thumbCtx) return;

    thumbCtx.fillStyle = "#111";
    thumbCtx.fillRect(0, 0, thumbW, thumbH);
    thumbCtx.drawImage(cropCanvas, 0, 0, srcW, srcH, 0, 0, thumbW, thumbH);

    const thumbUrl = thumbCanvas.toDataURL("image/jpeg", 0.92);

    let existing: SampleItem[] = [];
    try {
      const raw = localStorage.getItem(SAMPLES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) existing = parsed;
      }
    } catch {}

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
      compareUrl,
      aspectRatio: srcW / srcH,
      savedResolution: compareResolution,
    };

    localStorage.setItem(SAMPLES_KEY, JSON.stringify([...existing, nextItem]));
    router.push("/review");
  };

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <div className="fixed right-2 bottom-2 z-[9999] text-[10px] px-2 py-1 rounded bg-black/70 text-zinc-300 border border-white/10 pointer-events-none">
        {PAGE_VERSION}
      </div>

      <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800 bg-zinc-950">
        <div className="text-base font-medium">見本にしたい部分を囲って下さい</div>
        <button
          onClick={() => router.push("/review")}
          className="text-sm text-zinc-300"
        >
          戻る
        </button>
      </div>

      <div className="px-4 pt-3 text-xs text-zinc-400">
        {`解像度 ${compareResolution}`}
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
                  updateBaseRect();
                  window.setTimeout(() => updateBaseRect(), 120);
                }}
                draggable={false}
              />

              <div
                className="absolute border border-white rounded-md bg-white/5 pointer-events-none"
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
              min={8}
              max={80}
              value={Math.round(safeBoxWidthRatio * 100)}
              onChange={(e) =>
                setBoxWidthRatio(clamp(Number(e.target.value) / 100, MIN_BOX_W, MAX_BOX_W))
              }
              className="flex-1"
            />
            <div className="w-10 text-right text-sm text-zinc-400">
              {Math.round(safeBoxWidthRatio * 100)}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-14 text-sm text-zinc-300 shrink-0">縦サイズ</div>
            <input
              type="range"
              min={6}
              max={60}
              value={Math.round(safeBoxHeightRatio * 100)}
              onChange={(e) =>
                setBoxHeightRatio(clamp(Number(e.target.value) / 100, MIN_BOX_H, MAX_BOX_H))
              }
              className="flex-1"
            />
            <div className="w-10 text-right text-sm text-zinc-400">
              {Math.round(safeBoxHeightRatio * 100)}
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