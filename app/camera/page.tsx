"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const PAGE_VERSION = "camera-stable-01";

export default function CameraPage() {
  const router = useRouter();

  const videoRef = useRef<HTMLVideoElement | null>(null);
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

      // 元の動画解像度でそのまま保存
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

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <div className="fixed right-2 bottom-2 z-[9999] text-[10px] px-2 py-1 rounded bg-black/70 text-zinc-300 border border-white/10 pointer-events-none">
        {PAGE_VERSION}
      </div>

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
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
          autoPlay
        />

        {/* ガイドオーバーレイ */}
        <div className="absolute inset-0 pointer-events-none">
          {/* 70%枠 */}
          <div
            className="absolute border border-white/70 rounded-md"
            style={{
              width: "70%",
              height: "70%",
              left: "15%",
              top: "15%",
            }}
          />

          {/* 中心縦線 */}
          <div
            className="absolute bg-white/50"
            style={{
              width: "1px",
              height: "70%",
              left: "50%",
              top: "15%",
              transform: "translateX(-0.5px)",
            }}
          />

          {/* 中心横線 */}
          <div
            className="absolute bg-white/50"
            style={{
              height: "1px",
              width: "70%",
              left: "15%",
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
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="px-5 py-3 rounded-2xl border border-white/15 bg-black/70 text-center">
              <div className="text-lg font-semibold">保存中…</div>
              <div className="mt-1 text-sm text-zinc-300">画像を処理しています</div>
            </div>
          </div>
        ) : null}

        {errorMsg ? (
          <div className="absolute left-1/2 top-6 -translate-x-1/2 px-4 py-2 rounded-xl border border-rose-400/30 bg-black/70 text-rose-300 text-sm">
            {errorMsg}
          </div>
        ) : null}
      </div>

      <div className="bg-black px-5 pt-3 pb-6">
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

          <div className="w-11 h-11" />
        </div>
      </div>
    </main>
  );
}