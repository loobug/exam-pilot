/**
 * 本地模拟 OpenAI 兼容接口（含 SSE 流式），用于端到端联调，不需要真实 Key。
 *   POST /v1/chat/completions
 * 按题干关键词返回预设答案，模拟"先思考后作答"的 JSON 输出。
 */
import http from 'node:http';

const ANSWERS = [
  { re: /合外力/, answer: 'C', type: 'single', conf: 0.93,
    reasoning: '匀速直线运动 → 加速度为零 → 由牛顿第二定律 ΣF = ma = 0，合外力必为零。\nA、B 描述的是合力方向，与零合力矛盾；D 描述圆周运动特征，不符。故选 C。' },
  { re: /操作系统/, answer: 'AC', type: 'multi', conf: 0.95,
    reasoning: 'Linux 与 Windows Server 是操作系统内核/发行版。\nMySQL 是关系数据库管理系统（应用层软件），Nginx 是 Web 服务器/反向代理，二者都不管理硬件资源与进程调度，不属于操作系统。故选 A、C。' },
  { re: /TCP/, answer: '错', type: 'judge', conf: 0.97,
    reasoning: 'TCP 位于传输层而非网络层；它面向连接、提供可靠字节流，而"无连接的数据报服务"是 UDP 与 IP 的特征。题干两处均错，故判断为"错"。' },
  { re: /光在真空|声速|传播速度/, answer: '3×10^8 | 340', type: 'fill', conf: 0.9,
    reasoning: '真空中光速 c = 299792458 m/s ≈ 3×10^8 m/s。\n15℃ 干燥空气中声速约 340 m/s（v ≈ 331.4 + 0.6t）。两空依次填写。' },
  { re: /HTTPS/, answer: '1. 传输加密：TLS 对 HTTP 报文加密，中间人无法直接读取明文（防窃听）。\n2. 身份认证：服务器出示由 CA 签发的证书，客户端校验证书链，防冒充与 DNS 劫持。\n3. 完整性校验：TLS 记录层使用 MAC/AEAD 校验，篡改会被发现（防篡改）。', type: 'short', conf: 0.92,
    reasoning: 'HTTPS = HTTP over TLS。得分点应覆盖机密性、身份真实性、完整性三条，并点明由证书体系与对称/非对称混合加密实现。' },
  { re: /主键|唯一标识/, answer: 'B', type: 'single', conf: 0.96,
    reasoning: '主键（Primary Key）唯一标识元组且非空。外键用于表间参照完整性；索引是加速检索的数据结构；视图是虚表。故选 B。' },
  { re: /截图模式|见截图/, answer: '（截图模式模拟）1. C  2. AC  3. 错', type: 'page', conf: 0.7,
    reasoning: '模拟视觉模型的整页识别输出。' }
];

function pick(text) {
  for (const a of ANSWERS) if (a.re.test(text)) return a;
  return null;
}

const FALLBACK = { answer: 'B', type: 'single', conf: 0.5, reasoning: '未命中预设，返回兜底答案。' };

function sseChunks(obj, size = 14) {
  const s = JSON.stringify(obj);
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export function startMockApi(port = 8791) {
  const stats = { requests: 0, byModel: {} };
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (/\/stats/.test(req.url)) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(stats));
    }
    if (!/chat\/completions/.test(req.url)) {
      res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch (e) { }
      stats.requests += 1;
      const model = payload.model || 'unknown';
      stats.byModel[model] = (stats.byModel[model] || 0) + 1;
      const userText = (payload.messages || [])
        .filter(m => m.role === 'user')
        .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .join('\n');
      const stemMatch = userText.match(/【题干】([\s\S]*?)(?:\n【|$)/);
      const subject = stemMatch ? stemMatch[1] : userText;
      const hit = pick(subject);
      const a = hit || (/【题型】多/i.test(userText)
        ? { type: 'multi', answer: 'AB', confidence: 0.9, reasoning: '多选题：A、B 符合题意。' }
        : FALLBACK);
      const result = { type: a.type, reasoning: a.reasoning, answer: a.answer, confidence: a.conf };

      if (!payload.stream) {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify(result) } }]
        }));
      }

      res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      for (const piece of sseChunks(result)) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
        await new Promise(r => setTimeout(r, 6));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
