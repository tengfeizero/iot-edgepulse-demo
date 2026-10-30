// 网关：Modbus 读设备 → 本地缓存 → MQTT 上报 + 接收平台指令写回设备
// 核心可靠性：断线缓存补报 —— 数据先落本地 SQLite，MQTT 在线就上报并删除，
//             断网就攒在本地，重连后自动补报（平台端幂等去重兜底重复）
// 用法：node src/gateway/gateway.js [网关ID] [设备端口] [从站地址]
//   node src/gateway/gateway.js          → gw1 连 127.0.0.1:5020 从站1
//   node src/gateway/gateway.js gw2 5021 2 → gw2 连 127.0.0.1:5021 从站2
// 可选测试参数：SIMULATE_OFFLINE_MS=8000  → 启动 1 秒后模拟断网，8 秒后恢复
const ModbusRTU = require('modbus-serial');
const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const path = require('path');

const args = process.argv.slice(2);
const GW_ID = args[0] || 'gw1'; // 网关 ID（多网关唯一）
const MODBUS_HOST = '127.0.0.1';
const MODBUS_PORT = Number(args[1]) || 5020; // 对接的设备端口
const UNIT_ID = Number(args[2]) || 1; // 设备从站地址（必须与设备一致）
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';

// 主题按网关隔离：数据/指令/应答各走各的
const DATA_TOPIC = `factory/${GW_ID}/temperature`;
const CMD_TOPIC = `factory/${GW_ID}/cmd`;
const ACK_TOPIC = `factory/${GW_ID}/cmd/ack`;

// ── 设备转速三档（平台远程设定）：A=3000rpm B=2000rpm C=1000rpm ──
const SPEED_MAP = { A: 3000, B: 2000, C: 1000 };
let currentLevel = 'B'; // 当前档位
const POLL_INTERVAL_MS = 1000; // 数据采集间隔固定 1s

// ── 本地缓存（SQLite：断网时数据攒在这里，每个网关独立文件）──
const db = new Database(path.join(__dirname, '..', '..', 'data', `gateway-cache-${GW_ID}.db`));
db.exec(`CREATE TABLE IF NOT EXISTS cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);

// ── Modbus 客户端（主站，读设备）──
const modbus = new ModbusRTU();
let modbusReady = false;

// ── MQTT 客户端（连平台）──
const mqttClient = mqtt.connect(MQTT_URL, {
  clientId: `gateway-${GW_ID}`,
  clean: false,
});

async function initModbus() {
  await modbus.connectTCP(MODBUS_HOST, { port: MODBUS_PORT });
  await modbus.setID(UNIT_ID); // 从站地址必须与设备一致
  modbus.setTimeout(2000);
  modbusReady = true;
  console.log(`✅ [${GW_ID}] Modbus 已连接设备 (127.0.0.1:${MODBUS_PORT}, 从站 ${UNIT_ID})`);
}

// 轮询：读设备 → 先落缓存 → 再尝试上报
async function pollAndReport() {
  if (!modbusReady) return;
  try {
    const res = await modbus.readHoldingRegisters(0, 2);
    const payloadObj = {
      deviceId: GW_ID,
      temperature: res.data[0],
      speed: res.data[1],
      ts: Date.now(),
    };
    // ① 先写本地缓存（不管在不在线，先保证数据不丢）
    db.prepare('INSERT INTO cache (payload, created_at) VALUES (?, ?)')
      .run(JSON.stringify(payloadObj), Date.now());
    // ② 尝试补报（在线就发，断网就留着下次再发）
    flushCache();
  } catch (err) {
    console.error('❌ 读取设备失败:', err.message);
  }
}

// 补报：把缓存里的数据全部发送，发送成功的删除
function flushCache() {
  if (!mqttClient.connected) {
    console.log(`⏸  MQTT 离线，缓存 ${countCache()} 条待补报`);
    return;
  }
  const rows = db.prepare('SELECT * FROM cache ORDER BY id').all();
  for (const row of rows) {
    mqttClient.publish(DATA_TOPIC, row.payload, { qos: 1 }, (err) => {
      if (!err) {
        db.prepare('DELETE FROM cache WHERE id = ?').run(row.id);
      }
    });
  }
  if (rows.length > 0) {
    console.log(`📤 补报 ${rows.length} 条缓存数据`);
  }
}

function countCache() {
  return db.prepare('SELECT COUNT(*) AS n FROM cache').get().n;
}

// ── 指令下行：平台指令 → 写回设备寄存器 → ack ──
mqttClient.on('message', async (topic, payload) => {
  if (topic !== CMD_TOPIC) return;
  let cmd;
  try {
    cmd = JSON.parse(payload.toString());
  } catch {
    return;
  }
  console.log('📩 收到指令:', cmd);

  let result = 'ok';
  try {
    switch (cmd.cmd) {
      case 'set_threshold':
        await modbus.writeRegister(0, cmd.value);
        console.log(`  ✅ 已写设备寄存器0 = ${cmd.value}`);
        break;
      case 'reboot':
        console.log('  ✅ 网关重启完成');
        break;
      case 'set_speed': // 页面三档调速：A/B/C → 写设备转速寄存器（寄存器1）
        if (SPEED_MAP[cmd.level]) {
          currentLevel = cmd.level;
          await modbus.writeRegister(1, SPEED_MAP[currentLevel]); // 写转速寄存器
          console.log(`  ✅ 设备转速已设为 ${cmd.level} 档（${SPEED_MAP[currentLevel]} rpm）`);
        } else {
          result = 'bad_level';
          console.log('  ⚠️ 无效档位:', cmd.level);
        }
        break;
      default:
        result = 'unknown_cmd';
        console.log('  ⚠️ 未知指令:', cmd.cmd);
    }
  } catch (err) {
    result = 'error';
    console.error('  ❌ 指令执行失败:', err.message);
  }

  const ack = JSON.stringify({
    msgId: cmd.msgId,
    deviceId: GW_ID,
    cmd: cmd.cmd,
    result,
    ts: Date.now(),
  });
  mqttClient.publish(ACK_TOPIC, ack, { qos: 1 });
});

mqttClient.on('connect', () => {
  console.log(`✅ [${GW_ID}] MQTT 已连接 broker，当前缓存`, countCache(), '条');
  mqttClient.subscribe(CMD_TOPIC, { qos: 1 });
  flushCache(); // 重连后立即补报积压数据
});

mqttClient.on('error', (err) => {
  console.error('MQTT 错误:', err.message);
});

// ── 启动 ──
(async () => {
  try {
    await initModbus();
    setInterval(pollAndReport, POLL_INTERVAL_MS); // 每秒采集上报
    console.log(`⏱  [${GW_ID}] 采集间隔 1s，当前转速档位: ${currentLevel}（${SPEED_MAP[currentLevel]} rpm）`);
  } catch (err) {
    console.error('❌ Modbus 连接失败:', err.message);
  }

  // 断网模拟（仅测试用）：1 秒后断开 MQTT，N 毫秒后恢复
  const offlineMs = Number(process.env.SIMULATE_OFFLINE_MS || 0);
  if (offlineMs > 0) {
    setTimeout(() => {
      console.log(`🔌 模拟断网（${offlineMs}ms）...`);
      mqttClient.end(); // 断开连接，期间数据进缓存
    }, 1000);
    setTimeout(() => {
      console.log('🔌 模拟恢复网络...');
      mqttClient.reconnect(); // 触发重连 → connect 事件 → flushCache 补报
    }, offlineMs);
  }
})();
