// 设备端：模拟传感器设备
// 功能：① 每秒上报温度 ② 订阅指令主题接收下行指令 ③ 执行后发 ack 应答
const mqtt = require('mqtt');

const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://localhost:1883', {
  clientId: 'device-sensor-001',
  clean: false,
});

// 模拟设备当前状态
let deviceState = { threshold: 27, power: 'on' };

client.on('connect', () => {
  console.log('设备已连接');

  // 订阅指令主题（平台下发的指令）
  client.subscribe('factory/line1/cmd', { qos: 1 });

  // 每秒上报温度（保留上报功能）
  setInterval(() => {
    const payload = JSON.stringify({
      deviceId: 'sensor-001',
      temperature: +(20 + Math.random() * 10).toFixed(2),
      ts: Date.now(),
    });
    client.publish('factory/line1/temperature', payload, { qos: 1 });
  }, 1000);
});

// 收到指令：执行 → 发 ack（带上同一个 msgId）
client.on('message', (topic, payload) => {
  if (topic !== 'factory/line1/cmd') return;

  let cmd;
  try {
    cmd = JSON.parse(payload.toString());
  } catch {
    return;
  }

  console.log('📩 收到指令:', cmd);

  // 执行指令（模拟：修改设备状态）
  let result = 'ok';
  switch (cmd.cmd) {
    case 'set_threshold':
      deviceState.threshold = cmd.value;
      console.log(`  ✅ 已设置报警阈值 = ${cmd.value}°C`);
      break;
    case 'reboot':
      console.log('  ✅ 设备重启中...');
      break;
    default:
      result = 'unknown_cmd';
      console.log('  ⚠️ 未知指令:', cmd.cmd);
  }

  // 发应答：必须带回原指令的 msgId，平台才能匹配
  const ack = JSON.stringify({
    msgId: cmd.msgId,          // ← 关键：回传同一个 msgId
    deviceId: 'sensor-001',
    cmd: cmd.cmd,
    result,
    state: deviceState,
    ts: Date.now(),
  });
  client.publish('factory/line1/cmd/ack', ack, { qos: 1 });
  console.log('📤 已应答:', ack);
});

client.on('error', (err) => {
  console.error('连接错误:', err.message);
});
