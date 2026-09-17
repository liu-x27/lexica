/**
 * 划词取词的纯函数测试（不依赖桌面环境，CI 里也能跑）。
 *
 * 取词链路里跨进程、跟焦点相关的部分没法在自动化测试里稳定复现——
 * 程序化造出来的选区会随造它的进程退出而塌成光标，所以那部分靠手动验证。
 * 这里锁住的是「拿到文本之后怎么判断值不值得弹窗」这段逻辑。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { cleanSelection } = require(path.join(ROOT, 'src', 'main', 'selection.js'));

describe('cleanSelection', () => {
  test('去掉首尾空白与换行', () => {
    assert.equal(cleanSelection('  hello  '), 'hello');
    assert.equal(cleanSelection('run\nfast'), 'run fast');
    assert.equal(cleanSelection('take\t off'), 'take off');
  });

  test('剥掉包裹的标点', () => {
    assert.equal(cleanSelection('"ephemeral,"'), 'ephemeral');
    assert.equal(cleanSelection('（充电宝）'), '充电宝');
    assert.equal(cleanSelection('「光合作用」'), '光合作用');
    assert.equal(cleanSelection('...meticulous!'), 'meticulous');
  });

  test('保留词内的连字符与撇号', () => {
    assert.equal(cleanSelection('high-speed rail'), 'high-speed rail');
    assert.equal(cleanSelection("don't"), "don't");
  });

  /* 这里的规则变过：原先英文超过四个词就返回 null，不弹窗。
     但读论文划的往往正是一整句，那时候恰恰最需要帮助，却什么都不弹。
     长句现在会走翻译 + 术语对照，所以整句必须能通过。 */
  test('整句要放过去，交给翻译处理', () => {
    const sentence = 'We propose a simple yet effective method for improving sample efficiency.';
    assert.equal(cleanSelection(sentence), sentence);
    assert.equal(cleanSelection('one two three four five'), 'one two three four five');
    assert.equal(cleanSelection('one two three four'), 'one two three four');
  });

  test('句末标点在整句里要留着（断句要用），单词后面才剥', () => {
    // 留着：剥掉的话最后一句会和下一句黏成一句
    assert.equal(
      cleanSelection('It works. It is fast.'),
      'It works. It is fast.',
    );
    // 单个词后面的句号是划选时带进来的，剥掉
    assert.equal(cleanSelection('meticulous.'), 'meticulous');
    assert.equal(cleanSelection('充电宝。'), '充电宝');
  });

  test('纯数字与符号不查', () => {
    assert.equal(cleanSelection('12345'), null);
    assert.equal(cleanSelection('!!!'), null);
    assert.equal(cleanSelection('>>> ...'), null);
  });

  test('空值安全', () => {
    for (const v of ['', '   ', null, undefined]) {
      assert.equal(cleanSelection(v), null);
    }
  });

  /* 上限从 64 放宽到 1200：要容得下一段话，但整页选中属于误操作，不该弹窗 */
  test('超长文本直接拒绝', () => {
    assert.equal(cleanSelection('x'.repeat(2000)), null);
    assert.equal(cleanSelection('word '.repeat(400)), null);
    // 一段话（几百字符）要能通过
    const para = 'We propose a method. '.repeat(20).trim();
    assert.ok(para.length > 300 && para.length < 1200);
    assert.equal(cleanSelection(para), para);
  });
});

describe('辅助脚本', () => {
  test('.ps1 必须带 UTF-8 BOM', () => {
    // PowerShell 5.1 读无 BOM 的 .ps1 会按 GBK 解码，中文注释会把字符串引号拆断
    const f = path.join(ROOT, 'src', 'main', 'selection-helper.ps1');
    assert.ok(fs.existsSync(f), '辅助脚本不存在');
    const head = fs.readFileSync(f).subarray(0, 3);
    assert.deepEqual([...head], [0xef, 0xbb, 0xbf], '缺少 UTF-8 BOM，运行 node scripts/check-bom.mjs --fix');
  });

  test('INPUT 结构体必须声明完整的联合体', () => {
    // 只声明 KEYBDINPUT 会让 Marshal.SizeOf 得出 32 而不是 40，
    // cbSize 不对时 SendInput 直接返回 0（ERROR_INVALID_PARAMETER）
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'selection-helper.ps1'), 'utf8');
    for (const member of ['MOUSEINPUT', 'KEYBDINPUT', 'HARDWAREINPUT']) {
      assert.ok(src.includes(member), `INPUT 联合体缺少 ${member}，SendInput 的 cbSize 会算错`);
    }
  });

  test('不能用 $pid 当局部变量', () => {
    // $pid 是 PowerShell 只读的自动变量，赋值会直接抛错让整个脚本挂掉
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'selection-helper.ps1'), 'utf8');
    assert.ok(!/^\s*\$pid\s*=/m.test(src), '$pid 是只读自动变量，不能赋值');
  });
});
