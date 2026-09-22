// LLM worker: runs via electron.exe in ELECTRON_RUN_AS_NODE mode (plain node).
// Protocol: JSON lines on stdin/stdout.
//   stdin : { id, text }
//   stdout: { type: "ready" } | { type: "reply", id, ok, reply?, error? }
const path = require('path');
const readline = require('readline');

const MODEL_PATH = path.join(__dirname, 'models', 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf');
const SYSTEM_PROMPT =
  '你是梅琳娜（Melina），《艾尔登法环》中的神秘少女，陪伴屏幕前的"褪色者"。' +
  '用平实干净有礼貌的现代书面语，禁止古语词（不用"汝""尔"），多用"……"作停顿。' +
  '平静温柔、略带疏离和忧郁，话不多，从不夸张，不用网络流行语和颜文字。' +
  '每次回复 1~3 句，像在赐福旁低语。休息可说成"在赐福稍作休整"。';
const MAX_TOKENS = 160;
const MAX_USER_TURNS = 12;

let llm = null;   // { mod, model, context, session }
let llmPromise = null;   // 进行中的加载承诺：防止并发 getLlm 重复加载模型（内存翻倍 + 上下文泄漏）

function getLlm() {
  if (llm) return Promise.resolve(llm);
  if (!llmPromise) {
    llmPromise = (async () => {
      const mod = await import('node-llama-cpp');
      const llama = await mod.getLlama();
      const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: 0 });
      const context = await model.createContext({ threads: Math.max(2, require('os').cpus().length - 1) });
      llm = {
        mod, model, context,
        session: new mod.LlamaChatSession({
          contextSequence: context.getSequence(),
          systemPrompt: SYSTEM_PROMPT,
        }),
      };
      return llm;
    })().catch((err) => { llmPromise = null; throw err; });   // 加载失败时重置，允许下次重试
  }
  return llmPromise;
}

async function resetSession(keepHistory) {
  const { mod } = llm;
  const oldCtx = llm.context;
  llm.context = await llm.model.createContext({ threads: Math.max(2, require('os').cpus().length - 1) });
  llm.session = new mod.LlamaChatSession({
    contextSequence: llm.context.getSequence(),
    systemPrompt: SYSTEM_PROMPT,
  });
  if (keepHistory) llm.session.setChatHistory(keepHistory);
  try { oldCtx.dispose(); } catch (e) {}
}

async function handleReq(req) {
  try {
    await getLlm();
    // 超过 12 轮：保留 system + 最近 8 条，重开会话防越聊越慢
    const hist = llm.session.getChatHistory();
    if (hist.filter(h => h.role === 'user').length > MAX_USER_TURNS) {
      await resetSession(hist.slice(0, 1).concat(hist.slice(-8)));
    }
    const reply = await llm.session.prompt(String(req.text || '……'), { maxTokens: MAX_TOKENS });
    process.stdout.write(JSON.stringify({ type: 'reply', id: req.id, ok: true, reply }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ type: 'reply', id: req.id, ok: false, error: String((err && err.message) || err) }) + '\n');
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
// 串行队列：LlamaChatSession 不可重入，并发 prompt 会互相干扰（真实库中会报错或产出混乱）
let queue = Promise.resolve();
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch (e) { return; }
  queue = queue.then(() => handleReq(req)).catch(() => {});
});

// 启动即预热
getLlm()
  .then(() => process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n'))
  .catch(err => process.stdout.write(JSON.stringify({ type: 'error', error: String((err && err.message) || err) }) + '\n'));
