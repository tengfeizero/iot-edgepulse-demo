// 数据入库器：订阅 MQTT 设备数据 → 写入 TDengine（时序库）
// 可靠性设计：TDengine 不可用时数据暂存本地 SQLite，恢复后自动补写
//
// 用法：node src/tsdb/tsdb-sink.js
// 前置：TDengine 服务已启动（默认 http://localhost:6041 REST 端口）
//       Mosquitto 正在运行（MQTT broker）
const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const path = require('path');

// ── 配置 ──
const TD_URL = process.env.TD_URL || 'http://localhost:6041'; // REST 端口
const TD_USER = 'root';
const TD_PASS = 'taosdata';
const AUTH = 'Basic ' + Buffer.from(`${TD_USER}:${TD_PASS}`).toString('base64');
const DB_NAME = 'iot_demo'; // 时序库名
const MQTT_TOPIC = 'factory/+/temperature'; // 通配符订阅所有网关的上报数据

// ── 本地待补表（TDengine 挂了，数据先攒这）──
const db = new Database(path.join(__dirname, '..', '..', 'data', 'tsdb-pending.db'));
db.exec(`CREATE TABLE IF NOT EXISTS pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);

let tdReady = false; // TDengine 是否已初始化

// ── TDengine REST 请求（发一条 SQL）──
async function taosRequest(sql) {
  const res = await fetch(`${TD_URL}/rest/sql`, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'text/plain' },
    body: sql,
  });
  if (!res.ok) throw new Error(`TDengine HTTP ${res.status}`);
  return res.json();
}

// ── 初始化：建库 + 建超级表 ──
// 超级表 STABLE：一张表管所有设备，按设备打标签（device_id）
async function initTD() {
  await taosRequest(`CREATE DATABASE IF NOT EXISTS ${DB_NAME} PRECISION 'ms'`);
  await taosRequest(
    `CREATE STABLE IF NOT EXISTS ${DB_NAME}.device_data ` +
      `(ts TIMESTAMP, temperature INT, speed INT) TAGS (device_id NCHAR(32))`
  );
  tdReady = true;
  console.log(`✅ TDengine 已就绪：库 ${DB_NAME}，超级表 device_data`);
  flushPending(); // 顺便补写积压
}

// ── 写一条数据：自动建子表 + 插入 ──
async function insertData(obj) {
  const { deviceId, temperature, speed, ts } = obj;
  // 子表名不能有连字符，gateway-001 → d_gateway_001
  const subTable = `d_${deviceId.replace(/-/g, '_')}`;
  const sql =
    `INSERT INTO ${DB_NAME}.${subTable} USING ${DB_NAME}.device_data ` +
    `TAGS ('${deviceId}') VALUES (${ts}, ${temperature}, ${speed})`;
  await taosRequest(sql);
}

// ── 补写积压：TDengine 恢复后把暂存的数据全部写进去 ──
async function flushPending() {
  const rows = db.prepare('SELECT * FROM pending ORDER BY id').all();
  for (const row of rows) {
    try {
      await insertData(JSON.parse(row.payload));
      db.prepare('DELETE FROM pending WHERE id = ?').run(row.id);
    } catch (err) {
      console.error('补写失败（稍后重试）:', err.message);
      return; // 又断了就停，下轮再试
    }
  }
  if (rows.length > 0) console.log(`📤 已补写 ${rows.length} 条积压数据`);
}

// ── MQTT：订阅所有网关的设备数据 ──
const mqttClient = mqtt.connect(process.env.MQTT_URL || 'mqtt://localhost:1883', {
  clientId: 'tsdb-sink-01',
  clean: false,
});

mqttClient.on('connect', () => {
  console.log(`✅ MQTT 已连接，订阅 ${MQTT_TOPIC}`);
  mqttClient.subscribe(MQTT_TOPIC, { qos: 1 });
});

mqttClient.on('message', async (topic, payload) => {
  try {
    const data = JSON.parse(payload.toString());
    try {
      await insertData(data);
      console.log(`💾 入库: ${data.deviceId} 温度=${data.temperature}°C 转速=${data.speed} (${new Date(data.ts).toLocaleTimeString()})`);
    } catch (err) {
      // TDengine 不可用 → 暂存本地，稍后补写
      db.prepare('INSERT INTO pending (payload, created_at) VALUES (?, ?)')
        .run(JSON.stringify(data), Date.now());
      console.log(`⏸ TDengine 不可用，暂存 1 条（当前积压 ${countPending()}）: ${err.message}`);
    }
  } catch (err) {
    console.error('消息解析失败:', err.message);
  }
});

mqttClient.on('error', (err) => console.error('MQTT 错误:', err.message));

function countPending() {
  return db.prepare('SELECT COUNT(*) AS n FROM pending').get().n;
}

// ── 启动：先探活 TDengine，不可用就定时重试（等它上线）──
(async function boot() {
  // 立即试一次
  try {
    await initTD();
  } catch (err) {
    console.log(`⚠️ TDengine 暂不可达（${err.message}），每 5 秒重试，数据会先暂存本地`);
  }
  setInterval(async () => {
    if (!tdReady) {
      try {
        await initTD(); // 成功后自动补写积压
      } catch {
        /* 继续等 */
      }
    } else {
      flushPending(); // 定时清理积压
    }
  }, 5000);
})();
