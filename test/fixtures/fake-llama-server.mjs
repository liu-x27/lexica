/**
 * 测试用的假 llama-server：只实现 llama-server.js 用到的两个接口。
 *
 *   node fake-llama-server.mjs --port 8771 [--warm 400] [--crash] [--reply 文本]
 *
 * --warm  启动后这么多毫秒内 /health 回 503（真服务在载模型时就是这样）
 * --crash 一启动就以非零码退出（参数写错、显存不够时真服务就是这样）
 * --reply 固定回这段文本；不给就回「译：<用户消息>」
 * 每次请求的消息体追加写到 --dump 指定的文件，测试拿它核对发出去的提示词和参数。
 */
import http from 'node:http';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
if (argv.includes('--crash')) {
  process.stderr.write('error: failed to load model\n');
  process.exit(3);
}
const port = Number(arg('--port'));
const warm = Number(arg('--warm', '0'));
const reply = arg('--reply');
const dump = arg('--dump');
const t0 = Date.now();

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const ready = Date.now() - t0 >= warm;
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: ready ? 'ok' : 'loading model' }));
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (dump) fs.appendFileSync(dump, `${JSON.stringify(body)}\n`, 'utf8');
      const user = body.messages.filter((m) => m.role === 'user').pop()?.content || '';
      if (user.includes('FAIL500')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'boom' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: reply ?? `译：${user}` } }],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      }));
    });
    return undefined;
  }
  res.writeHead(404);
  return res.end();
}).listen(port, '127.0.0.1');
