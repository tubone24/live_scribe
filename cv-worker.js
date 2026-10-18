// 写真の台形補正用の Web Worker（OpenCV.js）
// 画像はこの Worker の中だけで処理し、外部には送らない。外部通信はライブラリの取得のみ（Cache Storage に保存）。
const LIB_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const CACHE = 'cv-lib-v1';
const DETECT_SIDE = 1024; // 検出は縮小画像で行う
const MAX_SIDE = 2048;    // 補正後の長辺の上限

const loadLib = async () => {
  const c = await caches.open(CACHE);
  let res = await c.match(LIB_URL);
  if (!res) {
    res = await fetch(LIB_URL);
    if (!res.ok) throw new Error(`${res.status} ${LIB_URL}`);
    try { await c.put(LIB_URL, res.clone()); } catch {}
  }
  const url = URL.createObjectURL(await res.blob());
  importScripts(url);
  URL.revokeObjectURL(url);
  // cv は then を持つ（Emscripten の Module）。await したり async 関数から返したりすると解決が終わらないので、
  // cv.Mat ができる（WASM の初期化が終わる）のを待ち、{ cv } に包んで返す
  const m = self.cv;
  if (!m.Mat) {
    await new Promise((resolve) => {
      const prev = m.onRuntimeInitialized;
      m.onRuntimeInitialized = () => { prev?.(); resolve(); };
      const t = setInterval(() => { if (m.Mat) { clearInterval(t); resolve(); } }, 50);
    });
  }
  return { cv: m };
};
let cvP = null;
const getCv = () => (cvP ??= loadLib().catch((e) => { cvP = null; throw e; }));

const readMat = async (cv, blob, maxSide = Infinity) => {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const can = new OffscreenCanvas(w, h);
  const ctx = can.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const W = bmp.width, H = bmp.height;
  bmp.close?.();
  return { mat: cv.matFromImageData(ctx.getImageData(0, 0, w, h)), k, W, H };
};
const toBlob = async (cv, mat, type, quality) => {
  const rgba = new cv.Mat();
  mat.copyTo(rgba);
  const can = new OffscreenCanvas(rgba.cols, rgba.rows);
  can.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows), 0, 0);
  rgba.delete();
  return can.convertToBlob({ type, quality });
};

// 左上・右上・右下・左下の順に並べる
const orderQuad = (pts) => {
  const s = pts.map(([x, y]) => x + y), d = pts.map(([x, y]) => y - x);
  return [pts[s.indexOf(Math.min(...s))], pts[d.indexOf(Math.min(...d))], pts[s.indexOf(Math.max(...s))], pts[d.indexOf(Math.max(...d))]];
};
const angleOk = (q) => q.every((p, i) => {
  const a = q[(i + 3) % 4], b = q[(i + 1) % 4];
  const v1 = [a[0] - p[0], a[1] - p[1]], v2 = [b[0] - p[0], b[1] - p[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
  const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  return deg >= 45 && deg <= 135;
});
const polyArea = (q) => Math.abs(q.reduce((n, p, i) => { const r = q[(i + 1) % 4]; return n + p[0] * r[1] - r[0] * p[1]; }, 0)) / 2;

// 四隅の自動検出。見つからなければ画像全体の四隅と confidence 0 を返す
const detect = async (blob) => {
  const { cv } = await getCv();
  const { mat, k, W, H } = await readMat(cv, blob, DETECT_SIDE);
  const gray = new cv.Mat(), edges = new cv.Mat(), contours = new cv.MatVector(), hier = new cv.Mat();
  try {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    // Canny のしきい値は中央値から決める（0.66〜1.33 倍）
    const hist = new Uint32Array(256);
    for (const v of gray.data) hist[v]++;
    let acc = 0, med = 0;
    for (; med < 256; med++) { acc += hist[med]; if (acc * 2 >= gray.data.length) break; }
    cv.Canny(gray, edges, Math.max(0, 0.66 * med), Math.min(255, 1.33 * med));
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel); kernel.delete();
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const imgArea = mat.cols * mat.rows;
    const list = [];
    for (let i = 0; i < contours.size(); i++) { const c = contours.get(i); list.push({ c, a: cv.contourArea(c) }); }
    list.sort((a, b) => b.a - a.a);
    let best = null;
    for (const { c, a } of list.slice(0, 12)) {
      if (a < imgArea * 0.2) break;
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const pts = [];
        for (let j = 0; j < 4; j++) pts.push([approx.data32S[j * 2], approx.data32S[j * 2 + 1]]);
        const q = orderQuad(pts);
        if (angleOk(q)) best = q;
      }
      approx.delete();
      if (best) break;
    }
    for (const { c } of list) c.delete();
    if (!best) return { quad: [[0, 0], [W, 0], [W, H], [0, H]], confidence: 0 };
    const quad = best.map(([x, y]) => [Math.round(x / k), Math.round(y / k)]);
    // 面積が大きく、ほぼ長方形に近いほど確からしい
    const ratio = polyArea(best) / imgArea;
    return { quad, confidence: Math.round(Math.min(1, 0.5 + ratio * 0.6) * 100) / 100 };
  } finally {
    mat.delete(); gray.delete(); edges.delete(); contours.delete(); hier.delete();
  }
};

// 四角形を長方形に引き伸ばし、自然な色の JPEG を返す
const warp = async (blob, quad) => {
  const { cv } = await getCv();
  const { mat } = await readMat(cv, blob);
  const q = orderQuad(quad);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let w = Math.max(d(q[0], q[1]), d(q[3], q[2])), h = Math.max(d(q[0], q[3]), d(q[1], q[2]));
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, q.flat());
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const M = cv.getPerspectiveTransform(src, dst);
  const out = new cv.Mat();
  try {
    cv.warpPerspective(mat, out, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    return { blob: await toBlob(cv, out, 'image/jpeg', 0.88), w, h };
  } finally {
    mat.delete(); src.delete(); dst.delete(); M.delete(); out.delete();
  }
};

self.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    if (data.type === 'detect') postMessage({ type: 'detected', id, ...(await detect(data.blob)) });
    else if (data.type === 'warp') postMessage({ type: 'warped', id, ...(await warp(data.blob, data.quad)) });
    else if (data.type === 'auto') {
      // 検出と補正をまとめて行う（撮影直後の自動処理）
      const det = await detect(data.blob);
      const out = det.confidence > 0 ? await warp(data.blob, det.quad) : null;
      postMessage({ type: 'auto', id, ...det, ...(out || {}) });
    }
  } catch (e) {
    postMessage({ type: 'error', id, message: String((e && e.message) || e) });
  }
};
