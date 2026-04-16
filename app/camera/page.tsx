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
};

const PENDING_SHARED_PROFILE_KEY = "inspection:pendingSharedProfile";

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

export default function CameraPage() {
  const router = useRouter();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

      router.push("/review");
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

            router.push("/review");
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
      onClick={() => router.push("/settings")}
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
      <div className="text-base font-medium">カメラ</div>
      <button
        onClick={() => router.push("/")}
        className="text-sm text-zinc-300"
      >
        戻る
      </button>
    </div>
  );

  const PreviewArea = (
    <div className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden">
      <video
        ref={videoRef}
        className="w-full h-full object-contain bg-black"
        playsInline
        muted
        autoPlay
      />

      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute border border-white/70 rounded-md"
          style={{
            width: "75%",
            height: "75%",
            left: "12.5%",
            top: "12.5%",
          }}
        />
        <div
          className="absolute bg-white/45"
          style={{
            width: "1px",
            height: "75%",
            left: "50%",
            top: "12.5%",
            transform: "translateX(-0.5px)",
          }}
        />
        <div
          className="absolute bg-white/45"
          style={{
            height: "1px",
            width: "75%",
            left: "12.5%",
            top: "50%",
            transform: "translateY(-0.5px)",
          }}
        />
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
          <div className="w-20 shrink-0 relative">
            <div className="absolute left-1/2 top-4 -translate-x-1/2">
              {BackButton}
            </div>

            <div className="absolute left-1/2 bottom-4 -translate-x-1/2">
              {PhotoButton}
            </div>
          </div>

          <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
            {PreviewArea}
          </div>

          <div className="w-24 shrink-0 relative">
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
              {ShutterButton}
            </div>

            <div className="absolute left-1/2 bottom-4 -translate-x-1/2">
              {SettingsButton}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 relative bg-black overflow-hidden">
            {PreviewArea}
          </div>

          <div className="shrink-0 bg-black px-5 pt-4 pb-8">
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