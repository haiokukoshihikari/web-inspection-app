"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const AUTO_SAVE_KEY = "inspection:autoSaveOn";
const PAGE_VERSION = "settings-stable-01";

export default function SettingsPage() {
  const router = useRouter();
  const [autoSaveOn, setAutoSaveOn] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(AUTO_SAVE_KEY);
      if (saved !== null) {
        setAutoSaveOn(saved === "true");
      }
    } catch {}
  }, []);

  const handleToggleAutoSave = () => {
    const next = !autoSaveOn;
    setAutoSaveOn(next);
    try {
      localStorage.setItem(AUTO_SAVE_KEY, String(next));
    } catch {}
  };

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <div className="fixed right-2 bottom-2 z-[9999] text-[10px] px-2 py-1 rounded bg-black/70 text-zinc-300 border border-white/10 pointer-events-none">
        {PAGE_VERSION}
      </div>

      <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800 bg-zinc-950">
        <div className="text-base font-medium">設定</div>
        <button
          onClick={() => router.back()}
          className="text-sm text-zinc-300"
        >
          戻る
        </button>
      </div>

      <div className="p-5">
        <div className="rounded-[1.75rem] border border-zinc-800 bg-zinc-900 px-5 py-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[18px] text-white">画像自動保存</div>
            <div className="mt-2 text-[15px] text-zinc-400">
              ON時は元画像と結果画像を保存
            </div>
          </div>

          <button
            onClick={handleToggleAutoSave}
            className={`relative w-16 h-9 rounded-full transition shrink-0 ${
              autoSaveOn ? "bg-emerald-500" : "bg-zinc-700"
            }`}
            aria-label="画像自動保存"
            title="画像自動保存"
          >
            <span
              className={`absolute top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white transition ${
                autoSaveOn ? "left-8" : "left-1"
              }`}
            />
          </button>
        </div>
      </div>
    </main>
  );
}