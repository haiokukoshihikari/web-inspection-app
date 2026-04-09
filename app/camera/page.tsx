"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const PAGE_VERSION = "camera-stable-02";

export default function CameraPage() {
  const router = useRouter();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [isCapturing, setIsCapturing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function startCamera() {
      try {
        setErrorMsg("");
        setIsReady(false);

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 4032 },
            height: { ideal: 3024 },
          },
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        if (!cancelled) {
          setIsReady(true);
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setErrorMsg("カメラを起動できませんでした");
          setIsReady(false);
        }
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, []);

  const handleCapture = async () => {
    if (!videoRef.current || isCapturing) return;

    const video = videoRef.current;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (!vw || !vh) {
      setErrorMsg("撮影画像の取得に失敗しました");
      return;
    }

    try {
      setIsCapturing(true);
      setErrorMsg("");

      const canvas = document.createElement("canvas");
      canvas.width = vw;
      canvas.height = vh;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("canvas context unavailable");
      }

      ctx.drawImage(video, 0, 0, vw, vh);

      const captured = canvas.toDataURL("image/jpeg", 0.98);
      sessionStorage.setItem("capturedImage", captured);

      router.push("/review");
    } catch (err) {
      console.error(err);
      setErrorMsg("画像の保存に失敗しました");
      setIsCapturing(false);
    }
  };

  const handlePickImage = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setErrorMsg("");
      setIsCapturing(true);

      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string" && result.startsWith("data:image/")) {
          sessionStorage.setItem("capturedImage", result);
          router.push("/review");
        } else {
          setErrorMsg("画像の読み込みに失敗しました");
          setIsCapturing(false);
        }
      };
      reader.onerror = () => {
        setErrorMsg("画像の読み込みに失敗しました");
        setIsCapturing(false);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
      setErrorMsg("画像の読み込みに失敗しました");
      setIsCapturing(false);
    } finally {
      e.target.value = "";
    }
  };

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <div className="fixed right-2 bottom-2 z-[9999] text-[10px] px-2 py-1 rounded bg-black/70 text-zinc-300 border border-white/10 pointer-events-none">
        {PAGE_VERSION}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800 bg-zinc-950">
        <div className="text-base font-medium">カメラ</div>
        <button
          onClick={() => router.push("/")}
          className="text-sm text-zinc-300"
        >
          戻る
        </button>
      </div>

      <div className="flex-1 relative bg-black overflow-hidden">
        {/* プレビュー領域 */}
        <div className="absolute inset-0 flex items-center justify-center bg-black">
          <video
            ref={videoRef}
            className="w-full h-full object-contain bg-black"
            playsInline
            muted
            autoPlay
          />
        </div>

        {/* ガイドオーバーレイ */}
        <div className="absolute inset-0 pointer-events-none">
          {/* 80%枠 */}
          <div
            className="absolute border border-white/70 rounded-md"
            style={{
              width: "80%",
              height: "80%",
              left: "10%",
              top: "10%",
            }}
          />

          {/* 中心縦線 */}
          <div
            className="absolute bg-white/45"
            style={{
              width: "1px",
              height: "80%",
              left: "50%",
              top: "10%",
              transform: "translateX(-0.5px)",
            }}
          />

          {/* 中心横線 */}
          <div
            className="absolute bg-white/45"
            style={{
              height: "1px",
              width: "80%",
              left: "10%",
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
            <div className="px-5 py-3 rounded-2xl border border-white/15 bg-black/70 text-center">
              <div className="text-lg font-semibold">処理中…</div>
              <div className="mt-1 text-sm text-zinc-300">画像を準備しています</div>
            </div>
          </div>
        ) : null}

        {errorMsg ? (
          <div className="absolute left-1/2 top-6 -translate-x-1/2 px-4 py-2 rounded-xl border border-rose-400/30 bg-black/70 text-rose-300 text-sm">
            {errorMsg}
          </div>
        ) : null}
      </div>

      {/* 下部UI: iPhone標準カメラ風 */}
      <div className="bg-black px-5 pt-4 pb-8">
        <div className="flex items-center justify-between">
          {/* 左: 写真選択 */}
          <button
            onClick={handlePickImage}
            className="w-14 h-14 rounded-2xl border border-white/15 bg-white/5 flex items-center justify-center shadow-lg active:scale-[0.98]"
            aria-label="写真を選択"
            title="写真を選択"
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
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="8.5" cy="10.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </button>

          {/* 中央: シャッター */}
          <button
            onClick={handleCapture}
            disabled={!isReady || isCapturing}
            className={`w-20 h-20 rounded-full border-4 shadow-lg ${
              !isReady || isCapturing
                ? "border-zinc-600 bg-zinc-700"
                : "border-white bg-white"
            }`}
            aria-label="撮影"
            title="撮影"
          />

          {/* 右: 設定 */}
          <button
            onClick={() => router.push("/settings")}
            className="w-14 h-14 rounded-2xl border border-white/15 bg-white/5 flex items-center justify-center shadow-lg active:scale-[0.98]"
            aria-label="設定"
            title="設定"
          >
            <span className="flex flex-col items-center justify-center gap-1">
              <span className="block w-5 h-0.5 bg-white rounded" />
              <span className="block w-5 h-0.5 bg-white rounded" />
              <span className="block w-5 h-0.5 bg-white rounded" />
            </span>
          </button>
        </div>
      </div>
    </main>
  );
}