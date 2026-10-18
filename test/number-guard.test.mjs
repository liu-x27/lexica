/**
 * 数字守卫的回归测试。
 *
 * 一半是「该拦的要拦住」（63.8 → 638 是这个模块存在的理由），
 * 一半是「正常的中文写法别误拦」——误拦一次就是退回兜底模型重译一次，
 * 而兜底模型（opus）本身更容易错。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { checkNumbers, numbersIn, chineseNumerals } = require(path.join(ROOT, 'src', 'main', 'number-guard.js'));

const ok = (src, out) => assert.equal(checkNumbers(src, out).ok, true, `应当通过：${src} → ${out}`);
const bad = (src, out, missing) => {
  const r = checkNumbers(src, out);
  assert.equal(r.ok, false, `应当拦住：${src} → ${out}`);
  if (missing) assert.deepEqual(r.missing, missing);
};

describe('数字守卫：该拦的', () => {
  test('小数点被吃掉（opus 的真实输出）', () => {
    bad('This degrades accuracy from 71.2 to 63.8.', '这将直线概率从 71.2 降低至 638', ['63.8']);
    ok('This degrades accuracy from 71.2 to 63.8.', '这使准确率从71.2降至63.8。');
  });

  test('比的是整个数字串，不是子串', () => {
    bad('It reached 63.8 points.', '它达到了163.8分。');
    bad('We use 7 layers.', '我们用了70层。');
    bad('Batch size 32.', '批大小为 320。');
  });

  test('数字丢了', () => {
    bad('We trained for 3 epochs on 2 GPUs.', '我们在GPU上训练了几轮。', ['3', '2']);
  });

  test('万/亿换算错了十倍', () => {
    bad('The model has 7 billion parameters.', '该模型有7亿个参数。');
    bad('About 50 students.', '大约50万名学生。');
  });

  test('汉字写法也不能连成别的数', () => {
    bad('Step 3.', '第十三步。');
    bad('Use 3 heads.', '使用三十个头。');
    bad('Use 3 heads.', '使用三万个头。');
  });
});

describe('数字守卫：别误拦的', () => {
  test('没有数字的句子直接放行', () => {
    ok('We release code and checkpoints.', '我们发布代码和检查点。');
  });

  test('千分位与全角数字', () => {
    ok('We collected 1,000 samples.', '我们收集了1000个样本。');
    ok('We collected 1,000 samples.', '我们收集了1,000个样本。');
    ok('We collected 10000 samples.', '我们收集了10,000个样本。');
    ok('Accuracy is 63.8.', '准确率为６３．８。');
    ok('About 12,500 tokens.', '大约 12 500 个词元。');
  });

  test('普通空格和中文逗号不当千分位', () => {
    ok('Table 1 has 100 rows.', '表 1 有 100 行。');
    ok('Batch sizes of 100, 200 and 300.', '批大小为100，200和300。');
  });

  test('两位以内的整数写成汉字', () => {
    ok('We use 3 layers.', '我们使用三层。');
    ok('Compare the 2 models.', '比较这两个模型。');
    ok('We read 25 papers.', '我们读了二十五篇论文。');
    ok('Over 10 runs.', '超过十次运行。');
  });

  test('序数', () => {
    ok('She came 1st.', '她得了第一名。');
    ok('In the 21st century.', '在21世纪。');
    ok('In the 21st century.', '在二十一世纪。');
    ok('A 3rd-party library.', '一个第三方库。');
  });

  test('年代', () => {
    ok('Since the 1990s.', '自20世纪90年代以来。');
    ok('Since the 1990s.', '自1990年代以来。');
  });

  test('量级换成万/亿', () => {
    ok('The model has 7 billion parameters.', '该模型有70亿个参数。');
    ok('The model has 7 billion parameters.', '该模型有七十亿个参数。');
    ok('A 7B model.', '一个7B模型。');
    ok('1.5 million users.', '150万用户。');
    ok('175 billion parameters.', '1750亿个参数。');
    ok('10,000 examples.', '1万个例子。');
    ok('10,000 examples.', '一万个例子。');
    ok('3 thousand words.', '3000个词。');
    ok('3 thousand words.', '三千个词。');
    ok('10k steps.', '1万步。');
  });

  test('年份、百分比、倍数、范围', () => {
    ok('In 2023, accuracy rose by 15%.', '2023年，准确率提高了15%。');
    ok('Accuracy rose by 15%.', '准确率提高了百分之十五。');
    ok('It is 3x faster.', '它快了3倍。');
    ok('Between 3 and 5 hours.', '3到5小时之间。');
  });

  test('模型名里的数字照抄', () => {
    ok('GPT-4 and T5 are compared.', '比较了GPT-4和T5。');
  });
});

describe('数字守卫：拆数', () => {
  test('带千分位的数整体取出', () => {
    assert.deepEqual(numbersIn('From 1,000,000 to 2.5').map((n) => n.value), ['1000000', '2.5']);
  });

  test('列表里的逗号不当千分位', () => {
    assert.deepEqual(numbersIn('Layers 1,2,3').map((n) => n.value), ['1', '2', '3']);
  });

  test('句末句点不是小数点', () => {
    assert.deepEqual(numbersIn('It improved to 0.91.').map((n) => n.value), ['0.91']);
  });

  test('汉字写法', () => {
    assert.deepEqual(chineseNumerals(0), ['零']);
    assert.deepEqual(chineseNumerals(2), ['二', '两']);
    assert.deepEqual(chineseNumerals(10), ['十', '一十']);
    assert.deepEqual(chineseNumerals(15), ['十五', '一十五']);
    assert.deepEqual(chineseNumerals(40), ['四十']);
    assert.deepEqual(chineseNumerals(100), []);
  });
});
