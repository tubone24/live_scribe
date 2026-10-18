// 意味検索用の Web Worker（transformers.js + ruri-v3-30m）
// 文章をベクトルにするだけで、外部には送らない。外部通信はライブラリとモデル重みの取得のみ（ブラウザにキャッシュ）。
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm';

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL = 'sirasagi62/ruri-v3-30m-ONNX';
// ruri-v3 は用途ごとに接頭辞を付ける
const PREFIX = { query: '検索クエリ: ', doc: '検索文書: ' };

const files = {};
const onProgress = (p) => {
  if (p.status !== 'progress' || !p.total) return;
  files[p.file] = [p.loaded, p.total];
  let l = 0, t = 0;
  for (const [a, b] of Object.values(files)) { l += a; t += b; }
  postMessage({ type: 'progress', loaded: l, total: t });
};

let embedP = null;
// LLM が WebGPU を使うので、こちらは WASM で動かす（小さいモデルなので十分速い）
const init = () => (embedP ??= pipeline('feature-extraction', MODEL, { dtype: 'q8', device: 'wasm', progress_callback: onProgress })
  .catch((e) => { embedP = null; throw e; }));

self.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    const embed = await init();
    if (data.type === 'load') return postMessage({ type: 'ready', id });
    const t0 = performance.now();
    const out = await embed(data.texts.map((t) => PREFIX[data.kind === 'query' ? 'query' : 'doc'] + t), { pooling: 'mean', normalize: true });
    const [n, dim] = out.dims;
    const flat = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
    const vectors = Array.from({ length: n }, (_, i) => flat.slice(i * dim, (i + 1) * dim));
    postMessage({ type: 'vectors', id, vectors, ms: Math.round(performance.now() - t0) }, vectors.map((v) => v.buffer));
  } catch (e) {
    postMessage({ type: 'error', id, message: String((e && e.message) || e) });
  }
};
