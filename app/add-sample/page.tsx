"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";

declare global {
  interface Window {
    cv?: any;
  }
}

const SAMPLES_KEY = "inspection:samples";
const RESOLUTION_KEY = "inspection:compareResolution";
const RECTIFY_KEY = "inspection:rectifyMode";

const MAX_SAMPLES = 6;
const REVIEW_VERSION = "add-sample-fix-04";

const MIN_BOX_W = 0.12;
const MAX_BOX_W = 0.8;
const MIN_BOX_H = 0.1;
const MAX_BOX_H = 0.6;

type RectifyMode = "OFF" | "ON";
type CompareResolutionMode = 1200 | 1600 | 2000 | 2400;

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

function matToDataUrl(cv: any, mat: any): string {
  const canvas = document.createElement("canvas");
  cv.imshow(canvas, mat);
  return canvas.toDataURL("image/png");
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
  const [processedPreviewUrl, setProcessedPreviewUrl] = useState("");
  const [processingBasis, setProcessingBasis] = useState({ width: 0, height: 0 });
  const [compareResolution, setCompareResolution] =
    useState<CompareResolutionMode>(1200);
  const [rectifyMode, setRectifyMode] = useState<RectifyMode>("OFF");

  const [cvReady, setCvReady] = useState(false);

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
        if ([1200, 1600, 2000, 2400].includes(n)) setCompareResolution(n);
      }
      const savedRect = localStorage.getItem(RECTIFY_KEY);
      if (savedRect === "OFF" || savedRect === "ON") {
        setRectifyMode(savedRect);
      }
    } catch {}
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function buildPreview() {
      if (!capturedImage || !cvReady) return;
      const cv = window.cv;
      if (!cv) return;

      let src: any = null;
      let work: any = null;

      try {
        const loaded = await imageSrcToMat(cv, capturedImage, compareResolution);
        if (!loaded) return;

        src = loaded.srcMat;
        work = rectifyMode === "ON" ? rectifySceneApprox(cv, src) : src.clone();

        if (!cancelled) {
          setProcessedPreviewUrl(matToDataUrl(cv, work));
          setProcessingBasis({ width: work.cols, height: work.rows });
          setImageScale(1);
          setImagePanX(0);
          setImagePanY(0);
        }
      } finally {
        try {
          src?.delete?.();
          work?.delete?.();
        } catch {}
      }
    }

    buildPreview();
    return () => {
      cancelled = true;
    };
  }, [capturedImage, cvReady, compareResolution, rectifyMode]);

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
      const nextScale = clamp(rawScale, 1, 4);
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
    if (!processedPreviewUrl || !processingBasis.width || !processingBasis.height) return;

    const processedImg = await loadImage(processedPreviewUrl);

    const scaledWidthOnScreen = baseRect.width * imageScale;
    const scaledHeightOnScreen = baseRect.height * imageScale;

    const imageLeft =
      baseRect.left + imagePanX - (scaledWidthOnScreen - baseRect.width) / 2;
    const imageTop =
      baseRect.top + imagePanY - (scaledHeightOnScreen - baseRect.height) / 2;

    const cropLeftOnScreen = displayBox.left - imageLeft;
    const cropTopOnScreen = displayBox.top - imageTop;

    let srcX = (cropLeftOnScreen / scaledWidthOnScreen) * processingBasis.width;
    let srcY = (cropTopOnScreen / scaledHeightOnScreen) * processingBasis.height;
    let srcW = (displayBox.width / scaledWidthOnScreen) * processingBasis.width;
    let srcH = (displayBox.height / scaledHeightOnScreen) * processingBasis.height;

    if (srcX < 0) {
      srcW += srcX;
      srcX = 0;
    }
    if (srcY < 0) {
      srcH += srcY;
      srcY = 0;
    }
    if (srcX + srcW > processingBasis.width) {
      srcW = processingBasis.width - srcX;
    }
    if (srcY + srcH > processingBasis.height) {
      srcH = processingBasis.height - srcY;
    }

    srcX = Math.round(srcX);
    srcY = Math.round(srcY);
    srcW = Math.round(srcW);
    srcH = Math.round(srcH);

    if (srcW <= 1 || srcH <= 1) return;

    const cropNorm: CropNorm = {
      x: srcX / processingBasis.width,
      y: srcY / processingBasis.height,
      w: srcW / processingBasis.width,
      h: srcH / processingBasis.height,
    };

    const compareCanvas = document.createElement("canvas");
    compareCanvas.width = srcW;
    compareCanvas.height = srcH;
    const compareCtx = compareCanvas.getContext("2d");
    if (!compareCtx) return;

    compareCtx.drawImage(
      processedImg,
      srcX,
      srcY,
      srcW,
      srcH,
      0,
      0,
      srcW,
      srcH
    );

    const compareUrl = compareCanvas.toDataURL("image/png");

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
    thumbCtx.drawImage(compareCanvas, 0, 0, srcW, srcH, 0, 0, thumbW, thumbH);
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
      sourceImageUrl: capturedImage,
      cropNorm,
      savedRectifyMode: rectifyMode,
    };

    localStorage.setItem(SAMPLES_KEY, JSON.stringify([...existing, nextItem]));
    router.push("/review");
  };

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <Script src="/opencv/opencv.js" strategy="afterInteractive" onLoad={() => setCvReady(true)} />

      <div className="fixed right-2 bottom-2 z-[9999] text-[10px] px-2 py-1 rounded bg-black/70 text-zinc-300 border border-white/10 pointer-events-none">
        {REVIEW_VERSION}
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
        {`解像度 ${compareResolution} / RECT ${rectifyMode}`}
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
          {processedPreviewUrl ? (
            <>
              <img
                ref={imgRef}
                src={processedPreviewUrl}
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
            <div className="text-zinc-400">準備中...</div>
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
              min={10}
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