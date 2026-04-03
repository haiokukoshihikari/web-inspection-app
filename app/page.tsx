"use client";

import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center p-4">
      <button
        onClick={() => router.push("/camera")}
        className="px-8 py-5 rounded-3xl bg-white text-black text-xl font-semibold shadow-lg active:scale-[0.98]"
      >
        カメラ起動
      </button>
    </main>
  );
}