"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const AUTO_SAVE_KEY = "inspection:autoSave";

export default function SettingsPage() {
  const router = useRouter();
  const [autoSave, setAutoSave] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(AUTO_SAVE_KEY);
    if (saved !== null) {
      setAutoSave(saved === "true");
    }
  }, []);

  const toggleAutoSave = () => {
    const next = !autoSave;
    setAutoSave(next);
    localStorage.setItem(AUTO_SAVE_KEY, String(next));
  };

  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-zinc-950">
        <div className="text-lg font-semibold">設定</div>
        <button onClick={() => router.back()} className="text-sm text-zinc-300">
          戻る
        </button>
      </div>

      <div className="flex-1 p-5 bg-zinc-950">
        <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-4 flex items-center justify-between">
          <div>
            <div className="font-medium">画像自動保存</div>
            <div className="text-sm text-zinc-400 mt-1">
              ON時は元画像と結果画像を保存
            </div>
          </div>

          <button
            onClick={toggleAutoSave}
            className={`w-16 h-9 rounded-full transition ${
              autoSave ? "bg-emerald-500" : "bg-zinc-700"
            }`}
          >
            <span
              className={`block w-7 h-7 bg-white rounded-full transition translate-y-1 ${
                autoSave ? "translate-x-8" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </div>
    </main>
  );
}