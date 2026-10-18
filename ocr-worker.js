// 写真の文字認識（OCR）用の Web Worker（PaddleOCR.js + ONNX Runtime Web）
// 画像はこの Worker の中だけで処理し、外部には送らない。外部通信はライブラリとモデルの取得のみ。
// モデル（.tar）は Cache Storage に保存して、2回目以降はダウンロードしない。
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';
const CACHE = 'ocr-models-v1';
const MODELS = {
  'v6-small': { det: 'PP-OCRv6_small_det', rec: 'PP-OCRv6_small_rec' },
  'v5-mobile': { det: 'PP-OCRv5_mobile_det', rec: 'PP-OCRv5_mobile_rec' },
};

// SDK と OpenCV.js は画像の読み込みに document.createElement('canvas') と instanceof HTMLImageElement を使う。
// Worker には DOM がないので、OffscreenCanvas を返す最小限の代用品を置く
self.HTMLImageElement ??= class {};
self.HTMLCanvasElement ??= class {};
self.document ??= { createElement: () => new OffscreenCanvas(1, 1), currentScript: null };

// モデルの .tar だけを Cache Storage に通す（進捗も送る）
const files = {};
const progress = () => {
  let l = 0, t = 0;
  for (const [a, b] of Object.values(files)) { l += a; t += b; }
  postMessage({ type: 'progress', loaded: l, total: t });
};
const cachedFetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!/\.tar(\?|$)/.test(url)) return fetch(input, init);
  const c = await caches.open(CACHE);
  const hit = await c.match(url);
  if (hit) return hit;
  const res = await fetch(url, init);
  if (!res.ok || !res.body) return res;
  const total = +res.headers.get('content-length') || 0;
  const chunks = [];
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); loaded += value.length;
    files[url] = [loaded, total || loaded]; progress();
  }
  const blob = new Blob(chunks);
  // 容量不足などで保存できなくても、今回の OCR は続ける（次回また取得する）
  try { await c.put(url, new Response(blob, { headers: { 'content-type': 'application/x-tar', 'content-length': String(blob.size) } })); } catch {}
  return new Response(blob);
};

// 行を読む順に並べる：横書きは上→下・左→右、縦長の行が過半数なら縦書きとして右→左・上→下
const box = (poly) => {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
};
const order = (items) => {
  const rows = items.map((it) => ({ ...it, b: box(it.poly) }));
  const vertical = rows.filter((r) => r.b.h > r.b.w * 1.5).length * 2 > rows.length;
  // 主軸（横書きなら y）の差が行の太さの半分以下なら同じ行
  const main = vertical ? (r) => -r.b.cx : (r) => r.b.cy;
  const sub = vertical ? (r) => r.b.cy : (r) => r.b.cx;
  const size = vertical ? (r) => r.b.w : (r) => r.b.h;
  rows.sort((a, b) => main(a) - main(b));
  const lines = [];
  for (const r of rows) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(main(r) - last.m) <= Math.max(size(r), last.s) / 2) { last.items.push(r); }
    else lines.push({ m: main(r), s: size(r), items: [r] });
  }
  const sorted = lines.flatMap((l) => l.items.sort((a, b) => sub(a) - sub(b)));
  return {
    vertical,
    // 同じ行の断片は空白でつなぎ、行ごとに改行する
    text: lines.map((l) => l.items.map((r) => r.text).join(' ')).join('\n'),
    lines: sorted.map((r) => ({ text: r.text, score: Math.round(r.score * 1000) / 1000, poly: r.poly.map(([x, y]) => [Math.round(x), Math.round(y)]) })),
  };
};

let ocrP = null, modelKey = null;
const init = (key) => {
  if (ocrP && modelKey === key) return ocrP;
  modelKey = key;
  ocrP = (async () => {
    const { PaddleOCR } = await import(SDK_URL);
    const m = MODELS[key] || MODELS['v6-small'];
    return PaddleOCR.create({
      textDetectionModelName: m.det,
      textRecognitionModelName: m.rec,
      worker: false, // すでに Worker の中なので入れ子にしない
      fetch: cachedFetch,
      // COOP/COEP を付けられない GitHub Pages ではスレッドなしの WASM になる。WebGPU があれば使う
      // wasm の取得元は、SDK の ESM が読む onnxruntime-web と同じ版に固定する
      ortOptions: { backend: 'auto', numThreads: 1, wasmPaths: ORT_WASM },
    });
  })();
  ocrP.catch(() => { ocrP = null; });
  return ocrP;
};

self.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    if (data.type === 'load') {
      await init(data.model);
      postMessage({ type: 'ready', id });
    } else if (data.type === 'ocr') {
      const ocr = await init(data.model);
      const t0 = performance.now();
      const bitmap = await createImageBitmap(data.blob);
      const [res] = await ocr.predict(bitmap, { textRecScoreThresh: data.minScore ?? 0.5 });
      bitmap.close?.();
      const items = (res?.items || []).filter((it) => it.text?.trim());
      const out = order(items);
      const avg = out.lines.length ? out.lines.reduce((n, l) => n + l.score, 0) / out.lines.length : 0;
      postMessage({ type: 'ocr', id, ...out, score: Math.round(avg * 1000) / 1000, ms: Math.round(performance.now() - t0), backend: res?.runtime?.backend ?? null });
    }
  } catch (e) {
    postMessage({ type: 'error', id, message: String((e && e.message) || e) });
  }
};
