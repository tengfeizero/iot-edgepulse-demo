// 订阅端：平台接收温度数据，QoS 1 + 业务幂等（去重）
const mqtt = require('mqtt');

const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://localhost:1883', {
  clientId: 'platform-sub-01',
  clean: false, // 断线期间的消息，重连后继续接收（配合 QoS 1）
});

// 已处理过的消息 id（幂等表：业务层去重）
const processedIds = new Map(); // key: msgId, value: 处理时间
const WINDOW_MS = 60_000; // 60 秒窗口内的重复消息直接忽略

function isDuplicate(msgId) {
  const last = processedIds.get(msgId);
  const now = Date.now();
  if (last && now - last < WINDOW_MS) return true; // 窗口内见过 = 重复
  processedIds.set(msgId, now);
  return false;
}

client.on('connect', () => {
  console.log('平台已连接，订阅 factory/line1/temperature (QoS 1)');
  client.subscribe('factory/line1/temperature', { qos: 1 });
});

client.on('message', (topic, payload) => {
  try {
    const data = JSON.parse(payload.toString());

    // ── 业务幂等：QoS 1 可能重复投递，这里按设备+时间戳去重 ──
    const msgId = `${data.deviceId}-${data.ts}`;
    if (isDuplicate(msgId)) {
      console.log('忽略重复消息:', msgId);
      return;
    }

    // ── 业务处理（真正干活的地方）──
    console.log(`[${new Date().toLocaleTimeString()}] ${topic} →`, data);

    // 示例：温度超阈值报警
    if (data.temperature > 27) {
      console.log(`  ⚠️ 温度超限！${data.temperature}°C，需要告警`);
    }
  } catch (err) {
    console.error('消息解析失败:', err.message);
  }
});

client.on('error', (err) => {
  console.error('连接错误:', err.message);
});
