/**
 * 评估本地翻译模型：质量与速度。
 * 这是决定要不要把机器翻译作为兜底的依据——译得不好还不如不给。
 *
 *   node scripts/eval-mt.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
env.localModelPath = path.join(ROOT, 'data', 'model');
env.allowRemoteModels = false;
env.allowLocalModels = true;

console.log('加载模型…');
const t0 = Date.now();
const translate = await pipeline('translation', 'Xenova/opus-mt-en-zh', { dtype: 'q8' });
console.log(`  首次加载 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

/** [输入, 人工参考译法（用于人眼比对，不做自动评分）] */
const CASES = [
  ['ablation study', '消融实验'],
  ['batch normalization', '批归一化'],
  ['attention mechanism', '注意力机制'],
  ['embedding space', '嵌入空间'],
  ['beam search', '束搜索 / 集束搜索'],
  ['gradient descent', '梯度下降'],
  ['confidence interval', '置信区间'],
  ['overfitting', '过拟合'],
  ['to the best of our knowledge', '据我们所知'],
  ['we hypothesize that', '我们假设'],
  ['The model achieves state-of-the-art performance on this benchmark.', '（整句）'],
];

console.log('=== 质量与速度 ===');
let totalMs = 0;
for (const [text, ref] of CASES) {
  const t = Date.now();
  const out = await translate(text, { max_new_tokens: 64 });
  const ms = Date.now() - t;
  totalMs += ms;
  console.log(`  ${String(ms).padStart(5)}ms  ${text}`);
  console.log(`           模型 → ${out[0].translation_text}`);
  console.log(`           参考 → ${ref}`);
}
console.log(`\n平均 ${Math.round(totalMs / CASES.length)}ms/条`);
