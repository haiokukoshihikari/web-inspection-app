"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function CameraPage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [error, setError] = useState("");
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isPickingImage, setIsPickingImage] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function startCamera() {
      try {
        setError("");
        setIsCameraReady(false);

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
          },
          audio: false,
        });

        if (!mounted) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          const video = videoRef.current;
          video.srcObject = stream;

          const handleLoadedMetadata = async () => {
            try {
              await video.play();
            } catch (e) {
              console.error("video play error:", e);
            }

            if (!mounted) return;

            if (video.videoWidth > 0 && video.videoHeight > 0) {
              setIsCameraReady(true);
              setError("");
            }
          };

          video.onloadedmetadata = handleLoadedMetadata;
        }
      } catch (err) {
        console.error(err);
        setError("カメラを起動できませんでした。権限設定を確認してください。");
      }
    }

    startCamera();

    return () => {
      mounted = false;
      if (videoRef.current) {
        videoRef.current.onloadedmetadata = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, []);

  const handleCapture = () => {
    const video = videoRef.current;
    if (!video) return;

    if (
      !isCameraReady ||
      video.readyState < 1 ||
      !video.videoWidth ||
      !video.videoHeight
    ) {
      setError("まだ撮影できる状態ではありません。少し待ってください。");
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;

    const maxWidth = 1280;
    const scale = Math.min(1, maxWidth / width);
    const targetWidth = Math.round(width * scale);
    const targetHeight = Math.round(height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("画像処理の初期化に失敗しました。");
      return;
    }

    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

    const imageDataUrl = canvas.toDataURL("image/jpeg", 0.85);

    try {
      sessionStorage.setItem("capturedImage", imageDataUrl);
    } catch (e) {
      console.error("sessionStorage save error:", e);
      setError("撮影画像の保存に失敗しました。");
      return;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    router.push("/review");
  };

  const handlePickImageClick = () => {
    if (isPickingImage) return;
    setError("");
    fileInputRef.current?.click();
  };

  const handleFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsPickingImage(true);

    try {
      const reader = new FileReader();

      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string" || !result.startsWith("data:image/")) {
          setError("画像の読み込みに失敗しました。");
          setIsPickingImage(false);
          return;
        }

        try {
          sessionStorage.setItem("capturedImage", result);
        } catch (err) {
          console.error("sessionStorage save error:", err);
          setError("画像の保存に失敗しました。");
          setIsPickingImage(false);
          return;
        }

        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }

        router.push("/review");
      };

      reader.onerror = () => {
        setError("画像の読み込みに失敗しました。");
        setIsPickingImage(false);
      };

      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
      setError("画像の選択に失敗しました。");
      setIsPickingImage(false);
    } finally {
      e.target.value = "";
    }
  };

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />

      <div className="relative flex-1 bg-black overflow-hidden flex items-center justify-center">
        {error && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 text-xs bg-red-500/20 text-red-200 px-3 py-2 rounded-full border border-red-300/20 max-w-[90%] text-center">
            {error}
          </div>
        )}

        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-contain bg-black"
          playsInline
          muted
          autoPlay
        />

        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute left-4 top-4 text-xs bg-black/40 px-2 py-1 rounded-full border border-white/10">
            ライブ簡易反応 2〜3fps
          </div>
        </div>
      </div>

      <div className="bg-black px-5 pt-3 pb-6">
        <div className="flex items-center justify-between">
          <button
            onClick={handlePickImageClick}
            disabled={isPickingImage}
            className={`w-11 h-11 rounded-2xl border border-white/15 bg-white/5 flex items-center justify-center ${
              isPickingImage ? "opacity-60" : ""
            }`}
            aria-label="写真を選ぶ"
            title="写真を選ぶ"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6 text-white"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="8.5" cy="10" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </button>

          <button
            onClick={handleCapture}
            disabled={!isCameraReady}
            className={`w-20 h-20 rounded-full flex items-center justify-center shadow-xl transition ${
              isCameraReady
                ? "bg-white active:scale-[0.98]"
                : "bg-zinc-500 cursor-not-allowed opacity-60"
            }`}
            aria-label="撮影"
          >
            <span className="w-16 h-16 rounded-full border-[5px] border-black/80 block" />
          </button>

          <button
            onClick={() => router.push("/settings")}
            className="w-11 h-11 rounded-2xl border border-white/15 bg-white/5 flex items-center justify-center"
            aria-label="設定"
            title="設定"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6 text-white"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01A1.65 1.65 0 0 0 10.09 3H10a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>

        <div className="mt-3 text-center text-xs text-zinc-400">
          左: 写真を選ぶ / 中央: 撮影 / 右: 設定
        </div>
      </div>
    </main>
  );
}