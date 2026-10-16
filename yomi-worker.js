// 読み検索用の Web Worker（kuromoji.js + IPADIC）
// 本文を「読み（カタカナ）」に変換して返すだけ。正規化はメインスレッドの norm() で行う。
// 外部通信はライブラリと辞書の取得のみで、どちらも Cache Storage に保存して2回目以降はオフラインで動く。
const BASE = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2';
const LIB_URL = `${BASE}/build/kuromoji.js`;
const DIC_URL = `${BASE}/dict/`;
const CACHE = 'yomi-dict-v1';
const FILES = 13; // ライブラリ1 + 辞書12

let done = 0;
const cache = caches.open(CACHE);
const get = async (url) => {
  const c = await cache;
  let res = await c.match(url);
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    await c.put(url, res.clone());
  }
  postMessage({ type: 'progress', done: ++done, total: FILES });
  return res;
};

// kuromoji は辞書を XMLHttpRequest で読み、URL を path.join で作る（https:// が https:/ に潰れる）。
// Cache Storage を通すため、辞書の読み込みだけを受け持つ最小限の XHR に差し替える
self.XMLHttpRequest = class {
  open(_method, url) { this.url = url.replace(/^(https?:)\/(?!\/)/, '$1//'); }
  send() {
    get(this.url).then((r) => r.arrayBuffer()).then(
      (buf) => { this.status = 200; this.response = buf; this.onload(); },
      (e) => this.onerror(e),
    );
  }
};

const ready = (async () => {
  const src = await (await get(LIB_URL)).blob();
  const url = URL.createObjectURL(src);
  importScripts(url);
  URL.revokeObjectURL(url);
  return new Promise((res, rej) => kuromoji.builder({ dicPath: DIC_URL }).build((e, t) => (e ? rej(e) : res(t))));
})();
ready.then(() => postMessage({ type: 'ready' }), (e) => postMessage({ type: 'error', message: String((e && e.message) || e) }));

self.onmessage = async ({ data: { id, text } }) => {
  try {
    const tokenizer = await ready;
    // 未知語は reading が返らないので、表記のまま連結する
    const yomi = tokenizer.tokenize(text)
      .map((t) => (t.reading && t.reading !== '*' ? t.reading : t.surface_form))
      .join('');
    postMessage({ type: 'yomi', id, yomi });
  } catch (e) {
    postMessage({ type: 'yomi', id, yomi: null, message: String((e && e.message) || e) });
  }
};
