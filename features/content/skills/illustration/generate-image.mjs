// generate-image.mjs - render an on-brand illustration via the Gemini image API
// (nano-banana / nano-banana-pro). Used by the `illustration` skill.
//
// Zero-dependency: calls the Gemini REST endpoint directly via fetch and writes the
// returned image bytes as-is. The output extension follows the response mime type
// (the API may return JPEG even when you ask for a .png path).
//
// Auth: GEMINI_API_KEY (or GOOGLE_API_KEY). From the Box checkout root, `pnpm image`
// loads it from `.env` via Node's --env-file-if-exists. From a plugin install,
// run the script directly with the env var set.
//
// Usage:
//   pnpm image -- --prompt "<text>" --out data/docs/content/<initiative>/illustration.png
//   pnpm image -- --prompt-file path/to.txt --model flash --aspect 16:9 --size 2K

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const MODEL_ALIASES = {
  pro: "gemini-3-pro-image",
  "nano-banana-pro": "gemini-3-pro-image",
  flash: "gemini-2.5-flash-image",
  "nano-banana": "gemini-2.5-flash-image",
  "flash-2": "gemini-3.1-flash-image",
};

const VALID_ASPECTS = new Set([
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1",
]);
const VALID_SIZES = new Set(["512", "1K", "2K", "4K"]);
const EXT_BY_MIME = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = "true";
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function slugFromPrompt(prompt) {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "illustration"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing GEMINI_API_KEY (or GOOGLE_API_KEY). Add it to the repo-root .env, " +
        "or run via `pnpm image` which loads .env automatically.",
    );
    process.exit(1);
  }

  let prompt = args.prompt;
  if (args["prompt-file"]) {
    prompt = (await readFile(resolve(args["prompt-file"]), "utf-8")).trim();
  }
  if (!prompt || prompt === "true") {
    console.error('A prompt is required: --prompt "<text>" or --prompt-file <path>.');
    process.exit(1);
  }

  const model = MODEL_ALIASES[args.model ?? "pro"] ?? args.model ?? "gemini-3-pro-image";
  const aspect = args.aspect ?? "16:9";
  const size = args.size ?? "2K";
  if (!VALID_ASPECTS.has(aspect)) {
    console.error(`Unsupported aspect "${aspect}". Valid: ${[...VALID_ASPECTS].join(", ")}`);
    process.exit(1);
  }
  if (!VALID_SIZES.has(size)) {
    console.error(`Unsupported size "${size}". Valid: ${[...VALID_SIZES].join(", ")}`);
    process.exit(1);
  }

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: aspect, imageSize: size },
    },
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error(`Gemini API ${res.status} ${res.statusText}\n${await res.text()}`);
    process.exit(1);
  }

  const json = await res.json();
  if (json.promptFeedback?.blockReason) {
    console.error(`Prompt blocked: ${json.promptFeedback.blockReason}`);
    process.exit(1);
  }

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData?.data) {
    const note = parts.map((p) => p.text).filter(Boolean).join(" ");
    console.error(`No image in response.${note ? ` Model said: ${note}` : ""}`);
    process.exit(1);
  }

  let out = resolve(args.out ?? `${slugFromPrompt(prompt)}.png`);
  const ext = EXT_BY_MIME[imagePart.inlineData.mimeType ?? "image/png"];
  if (ext && !out.endsWith(ext)) out = out.replace(/(\.[a-z0-9]+)?$/i, ext);

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(imagePart.inlineData.data, "base64"));
  console.log(out);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
