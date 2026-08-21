import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const outDir = path.join(root, "public", "brand");
const sizes = [48, 96, 144, 192, 256, 384, 512];

const sources = {
  usa: path.join(root, "src/assets/hybrid-ai-records-eagle.jpg"),
  lithuania: path.join(root, "src/assets/hybrid-ai-records-lithuania.jpg"),
  nigeria: path.join(root, "src/assets/hybrid-ai-records-nigeria.jpg"),
  jester: path.join(root, "src/assets/hybrid-ai-records-jester.jpg"),
};

fs.mkdirSync(outDir, { recursive: true });

function isPaperWhite(r, g, b, a) {
  if (a === 0) return true;
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  // JPEG "white" is noisy; keep flag whites that sit inside a gold border.
  return min >= 236 && max - min <= 18;
}

/** Knock out the outer paper field so the lockup sits on the page, not in a white tile. */
async function transparentMaster(inputPath) {
  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const px = data;
  const visited = new Uint8Array(width * height);
  const stack = [];

  const idx = (x, y) => (y * width + x) * 4;
  const pidx = (x, y) => y * width + x;
  const paperAt = (i) => isPaperWhite(px[i], px[i + 1], px[i + 2], px[i + 3]);

  const seed = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = pidx(x, y);
    if (visited[p] || !paperAt(idx(x, y))) return;
    visited[p] = 1;
    stack.push(x, y);
  };

  for (let x = 0; x < width; x++) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    seed(0, y);
    seed(width - 1, y);
  }

  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    px[idx(x, y) + 3] = 0;
    seed(x + 1, y);
    seed(x - 1, y);
    seed(x, y + 1);
    seed(x, y - 1);
  }

  // Eat the JPEG fringe so a 1px dirty halo doesn't read as a box.
  for (let pass = 0; pass < 2; pass++) {
    const fringe = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y);
        if (px[i + 3] === 0 || !paperAt(i)) continue;
        const hit =
          (x > 0 && px[idx(x - 1, y) + 3] === 0) ||
          (x + 1 < width && px[idx(x + 1, y) + 3] === 0) ||
          (y > 0 && px[idx(x, y - 1) + 3] === 0) ||
          (y + 1 < height && px[idx(x, y + 1) + 3] === 0);
        if (hit) fringe.push(i);
      }
    }
    for (const i of fringe) px[i + 3] = 0;
  }

  return sharp(px, { raw: { width, height, channels: 4 } }).png();
}

for (const [name, src] of Object.entries(sources)) {
  const master = await transparentMaster(src);
  const masterBuf = await master.toBuffer();
  const masterPath = path.join(outDir, `lockup-${name}.png`);
  fs.writeFileSync(masterPath, masterBuf);
  console.log(`${path.relative(root, masterPath)}  ${masterBuf.length} bytes`);

  for (const size of sizes) {
    const dest = path.join(outDir, `lockup-${name}-${size}.png`);
    await sharp(masterBuf)
      .resize(size, size, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        kernel: sharp.kernel.lanczos3,
      })
      .sharpen({ sigma: 0.55, m1: 0.7, m2: 0.35 })
      .png({ compressionLevel: 6 })
      .toFile(dest);
    const { size: bytes } = fs.statSync(dest);
    console.log(`${path.relative(root, dest)}  ${bytes} bytes`);
  }
}
