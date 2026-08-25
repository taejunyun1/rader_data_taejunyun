export const VISUAL_HASH_METHOD = "IMAGES_RGBA_DHASH_V1" as const;

function luminance(r: number, g: number, b: number): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

export function dHashFromRgba(rgba: Uint8Array, width = 9, height = 8): string {
  const expectedLength = width * height * 4;
  if (rgba.length < expectedLength) throw new Error("visual_rgba_too_short");
  let hash = 0n;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = (y * width + x) * 4;
      const right = (y * width + x + 1) * 4;
      const leftLuma = luminance(rgba[left]!, rgba[left + 1]!, rgba[left + 2]!);
      const rightLuma = luminance(rgba[right]!, rgba[right + 1]!, rgba[right + 2]!);
      hash = (hash << 1n) | BigInt(leftLuma > rightLuma ? 1 : 0);
    }
  }
  return hash.toString(16).padStart(16, "0");
}

export async function imageDHash(env: Env, bytes: ArrayBuffer): Promise<string> {
  const transformed = await env.IMAGES
    .input(new Response(bytes).body!)
    .transform({ width: 9, height: 8, fit: "squeeze" })
    .output({ format: "rgba" });
  const rgba = new Uint8Array(await new Response(transformed.image()).arrayBuffer());
  return dHashFromRgba(rgba);
}
