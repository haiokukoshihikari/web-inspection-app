import { get, put } from "@vercel/blob";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

const BLOB_PATHNAME = "config/inspection-profile.json";

const DEFAULT_PROFILE: InspectionProfile = {
  profileName: "default",
  version: "20260412-001",
  baseThreshold: 0.48,
  missingCandidateThreshold: 0.31,
  rotationRange: 3,
  scaleRange: 5,
  shearRange: 0,
  compareResolution: 1600,
  hitLimit: 100,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateProfile(input: unknown): InspectionProfile {
  if (!input || typeof input !== "object") {
    throw new Error("設定データが不正です。");
  }

  const data = input as Record<string, unknown>;

  if (typeof data.profileName !== "string" || data.profileName.trim() === "") {
    throw new Error("profileName は空でない文字列にしてください。");
  }

  if (typeof data.version !== "string" || data.version.trim() === "") {
    throw new Error("version は空でない文字列にしてください。");
  }

  if (!isFiniteNumber(data.baseThreshold)) {
    throw new Error("baseThreshold は数値にしてください。");
  }

  if (!isFiniteNumber(data.missingCandidateThreshold)) {
    throw new Error("missingCandidateThreshold は数値にしてください。");
  }

  if (!isFiniteNumber(data.rotationRange)) {
    throw new Error("rotationRange は数値にしてください。");
  }

  if (!isFiniteNumber(data.scaleRange)) {
    throw new Error("scaleRange は数値にしてください。");
  }

  if (!isFiniteNumber(data.shearRange)) {
    throw new Error("shearRange は数値にしてください。");
  }

  if (!isFiniteNumber(data.compareResolution)) {
    throw new Error("compareResolution は数値にしてください。");
  }

  if (!isFiniteNumber(data.hitLimit)) {
    throw new Error("hitLimit は数値にしてください。");
  }

  return {
    profileName: data.profileName.trim(),
    version: data.version.trim(),
    baseThreshold: data.baseThreshold,
    missingCandidateThreshold: data.missingCandidateThreshold,
    rotationRange: data.rotationRange,
    scaleRange: data.scaleRange,
    shearRange: data.shearRange,
    compareResolution: data.compareResolution,
    hitLimit: data.hitLimit,
  };
}

async function streamToText(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);

  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(merged);
}

async function readConfig(): Promise<InspectionProfile> {
  const result = await get(BLOB_PATHNAME, { access: "private" });

  if (!result || result.statusCode !== 200 || !result.stream) {
    return DEFAULT_PROFILE;
  }

  const raw = await streamToText(result.stream);
  const parsed = JSON.parse(raw);

  return validateProfile(parsed);
}

async function writeConfig(profile: InspectionProfile) {
  await put(BLOB_PATHNAME, JSON.stringify(profile, null, 2), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
}

export async function GET() {
  try {
    const profile = await readConfig();
    return NextResponse.json(profile, { status: 200 });
  } catch (error) {
    console.error("[GET /api/config] failed:", error);

    return NextResponse.json(
      { message: "共有設定の読み込みに失敗しました。" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const profile = validateProfile(body);

    await writeConfig(profile);

    return NextResponse.json(
      {
        message: "共有設定を保存しました。",
        profile,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[POST /api/config] failed:", error);

    const message =
      error instanceof Error
        ? error.message
        : "共有設定の保存に失敗しました。";

    return NextResponse.json({ message }, { status: 400 });
  }
}