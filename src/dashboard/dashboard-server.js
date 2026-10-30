// 实时监控大屏后端：查询 TDengine → 提供 API → 托管前端页面
// 附带能力：页面按钮远程调节网关采集速度（A/B/C 三档，走 MQTT 指令下行）
// 用法：node src/dashboard/dashboard-server.js  （前置：TDengine 已启动，设备数据在入库）
// 访问：浏览器打开 http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const TD_URL = process.env.TD_URL || 'http://localhost:6041';
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const AUTH = 'Basic ' + Buffer.from('root:taosdata').toString('base64');
const PORT = process.env.PORT || 3000;

// ── MQTT：发布调速指令给指定网关，订阅应答 + 所有设备数据（数据直推大屏）──
const mqttClient = mqtt.connect(MQTT_URL, {
  clientId: 'dashboard-ctl-01',
  clean: false,
});
let currentSpeed = 'B'; // 当前档位（网关默认 B 档）
let targetGateway = 'gw1'; // 当前操作的目标网关
const acks = new Map(); // 各网关最近一次指令确认结果（key: 网关ID）

mqttClient.on('connect', () => {
  mqttClient.subscribe('factory/+/cmd/ack', { qos: 1 }); // 收所有网关应答
  mqttClient.subscribe('factory/+/temperature', { qos: 1 }); // 收所有网关设备数据
});
mqttClient.on('error', (err) => {
  console.warn('MQTT 连接异常:', err.message);
});
mqttClient.on('message', (topic, payload) => {
  // 从主题 factory/{gwId}/cmd/ack 提取网关 ID
  const m = topic.match(/^factory\/([^/]+)\/cmd\/ack$/);
  if (m) {
    try {
      acks.set(m[1], JSON.parse(payload.toString()));
    } catch { /* ignore */ }
    return;
  }
  // 设备数据 factory/{gwId}/temperature → 通过 WebSocket 直推页面
  if (/^factory\/[^/]+\/temperature$/.test(topic)) {
    try {
      broadcast({ type: 'data', data: JSON.parse(payload.toString()) });
    } catch { /* ignore */ }
  }
});

// ── 查询 TDengine（REST 发 SQL）──
async function taosRequest(sql) {
  const res = await fetch(`${TD_URL}/rest/sql`, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'text/plain' },
    body: sql,
  });
  if (!res.ok) throw new Error(`TDengine HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`SQL 错误: ${json.desc}`);
  return json.data;
}

// gateway 过滤条件（校验格式防注入，非法则返回空条件 = 不过滤）
function gwWhere(gateway) {
  return gateway && /^gw\d+$/.test(gateway) ? `WHERE device_id = '${gateway}'` : '';
}
function gwAnd(gateway) {
  return gateway && /^gw\d+$/.test(gateway) ? ` AND device_id = '${gateway}'` : '';
}

// ── API：最新一条数据（可按网关过滤）──
async function apiLatest(gateway) {
  const rows = await taosRequest(
    `SELECT ts, device_id, temperature, speed FROM iot_demo.device_data ${gwWhere(gateway)} ORDER BY ts DESC LIMIT 1`
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return { ts: r[0], deviceId: r[1], temperature: r[2], speed: r[3] };
}

// ── API：最近 N 分钟的历史（可按网关过滤）──
async function apiHistory(minutes, gateway) {
  const m = Math.max(1, Math.min(60, minutes || 5));
  const rows = await taosRequest(
    `SELECT ts, device_id, temperature, speed FROM iot_demo.device_data WHERE ts >= now - ${m}m${gwAnd(gateway)} ORDER BY ts ASC`
  );
  return rows.map((r) => ({ ts: r[0], deviceId: r[1], temperature: r[2], speed: r[3] }));
}

// ── API：各设备数据量统计（可按网关过滤）──
async function apiStats(gateway) {
  const rows = await taosRequest(
    `SELECT device_id, COUNT(*) FROM iot_demo.device_data ${gwWhere(gateway)} GROUP BY device_id`
  );
  return rows.map((r) => ({ deviceId: r[0], count: r[1] }));
}

// ── 静态文件映射 ──
function staticFile(urlPath, res) {
  let filePath;
  if (urlPath === '/') filePath = path.join(__dirname, '..', '..', 'public', 'index.html');
  else if (urlPath === '/vendor/echarts.min.js')
    filePath = path.join(__dirname, '..', '..', 'node_modules', 'echarts', 'dist', 'echarts.min.js');
  else return false;

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'application/javascript; charset=utf-8' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
  return true;
}

// ── HTTP 服务 ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // API 路由
  if (p === '/api/latest') return json(res, await safe(() => apiLatest(url.searchParams.get('gateway'))));
  if (p === '/api/history') return json(res, await safe(() => apiHistory(Number(url.searchParams.get('minutes')) || 5, url.searchParams.get('gateway'))));
  if (p === '/api/stats') return json(res, await safe(() => apiStats(url.searchParams.get('gateway'))));

  // 调速：GET 查询当前档位
  if (p === '/api/speed' && req.method === 'GET') {
    return json(res, { ok: true, data: { level: currentSpeed, gateway: targetGateway, acks: Object.fromEntries(acks) } });
  }
  // 调速：POST 设置档位（A/B/C）
  if (p === '/api/speed' && req.method === 'POST') {
    return handleSetSpeed(req, res);
  }

  // 静态文件
  if (staticFile(p, res)) return;

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

// ── WebSocket：设备数据实时推送到页面（同一端口，路径 /ws）──
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();
wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`🔗 大屏已连接（当前 ${wsClients.size} 个页面）`);
  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`🔌 大屏断开（剩 ${wsClients.size} 个页面）`);
  });
});
function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(text); // 1 = OPEN
  }
}

// ── 处理调速指令：解析 body → 校验 → MQTT 下发到指定网关 ──
async function handleSetSpeed(req, res) {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const { gateway, level } = JSON.parse(body || '{}');
      // 校验：网关 ID 格式（gw1/gw2/...） + 档位 A/B/C
      const gw = gateway || targetGateway;
      if (!/^gw\d+$/.test(gw)) {
        return json(res, { ok: false, error: `网关必须是 gw1/gw2/... 格式，收到: ${gw}` });
      }
      if (!['A', 'B', 'C'].includes(level)) {
        return json(res, { ok: false, error: '档位必须是 A/B/C' });
      }
      // 发布指令到指定网关（带 msgId，网关执行后回 ack）
      const msgId = crypto.randomUUID();
      mqttClient.publish(
        `factory/${gw}/cmd`,
        JSON.stringify({ cmd: 'set_speed', level, msgId }),
        { qos: 1 }
      );
      targetGateway = gw;
      currentSpeed = level;
      console.log(`🎛 页面调速: ${gw} → ${level} 档 (msgId=${msgId})`);
      json(res, { ok: true, data: { gateway: gw, level } });
    } catch (err) {
      json(res, { ok: false, error: 'body 解析失败' });
    }
  });
}

function json(res, result) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(result));
}

async function safe(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

server.listen(PORT, () => {
  console.log(`📊 监控大屏已启动: http://localhost:${PORT}`);
  console.log(`   数据源: TDengine REST ${TD_URL}`);
  console.log(`   实时推送: WebSocket ws://localhost:${PORT}/ws`);
});
