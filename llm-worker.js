// ローカル LLM 要約用の Web Worker（transformers.js + WebGPU）
// 文字起こしはこの Worker の中だけで処理し、外部には送らない。外部通信はライブラリとモデル重みの取得のみ。
import { AutoTokenizer, AutoModelForCausalLM, TextStreamer, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm';

env.allowLocalModels = false;
env.useBrowserCache = true;

let tok, model;
const files = {};
const onProgress = (p) => {
  if (p.status !== 'progress' || !p.total) return;
  files[p.file] = [p.loaded, p.total];
  let l = 0, t = 0;
  for (const [a, b] of Object.values(files)) { l += a; t += b; }
  postMessage({ type: 'progress', loaded: l, total: t });
};

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      tok = await AutoTokenizer.from_pretrained(data.id, { progress_callback: onProgress });
      postMessage({ type: 'phase', phase: 'init' });
      model = await AutoModelForCausalLM.from_pretrained(data.id, { dtype: 'q4f16', device: 'webgpu', progress_callback: onProgress });
      postMessage({ type: 'ready' });
    } else if (data.type === 'run') {
      const inputs = tok.apply_chat_template(data.messages, { add_generation_prompt: true, return_dict: true, enable_thinking: false });
      let text = '';
      const streamer = new TextStreamer(tok, {
        skip_prompt: true, skip_special_tokens: true,
        callback_function: (t) => { text += t; postMessage({ type: 'token', text }); },
      });
      await model.generate({ ...inputs, max_new_tokens: 200, do_sample: false, streamer });
      postMessage({ type: 'done', text });
    }
  } catch (e) {
    postMessage({ type: 'error', message: String((e && e.message) || e) });
  }
};
