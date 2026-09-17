/**
 * Derive a dominant OKLCH hue from an image (cover art) with a tiny canvas
 * sample — no colour library needed. Returns null when the image is too grey
 * (low chroma) so the caller keeps the previous accent instead of flashing.
 */
export async function dominantHueFromImage(src: string, opts: { size?: number; minChroma?: number } = {}): Promise<number | null> {
  if (typeof document === "undefined") return null;
  const size = opts.size ?? 24;
  const minChroma = opts.minChroma ?? 0.06;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null; // tainted canvas
  }
  // 36 hue bins weighted by chroma × alpha
  const bins = new Float64Array(36);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    if (a < 0.5) continue;
    const { l, c, h } = srgbToOklch(data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255);
    if (c < minChroma || l < 0.15 || l > 0.95) continue;
    const bin = Math.floor(h / 10) % 36;
    bins[bin] = (bins[bin] ?? 0) + c * a;
  }
  let best = -1;
  let bestW = 0;
  for (let b = 0; b < 36; b++) if (bins[b]! > bestW) (bestW = bins[b]!), (best = b);
  if (best < 0 || bestW === 0) return null;
  return best * 10 + 5;
}

export function srgbToOklch(r: number, g: number, b: number): { l: number; c: number; h: number } {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const R = lin(r), G = lin(g), B = lin(b);
  const l_ = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m_ = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s_ = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.hypot(a, bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}
