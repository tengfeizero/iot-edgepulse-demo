// 平台控制端：给设备下发指令，等待 ack，带超时与重试
const mqtt = require('mqtt');
const crypto = require('crypto');

const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://localhost:1883', {
  clientId: 'platform-control-01',
  clean: false,
});

// 等待应答的指令表：msgId -> { resolve, timer }
const pending = new Map();
const ACK_TIMEOUT_MS = 5000; // 5 秒没应答算超时

client.on('connect', () => {
  console.log('平台已连接');

  // 订阅应答主题
  client.subscribe('factory/line1/cmd/ack', { qos: 1 });

  // 依次下发两条指令演示
  setTimeout(() => sendCmd({ cmd: 'set_threshold', value: 25 }), 500);
  setTimeout(() => sendCmd({ cmd: 'reboot' }), 2500);
  // 第三条：给一个设备不认识的指令，演示 unknown_cmd 应答
  setTimeout(() => sendCmd({ cmd: 'firmware_upgrade' }), 4500);
});

// 收到设备应答：匹配 msgId，找到等待中的调用方
client.on('message', (topic, payload) => {
  if (topic !== 'factory/line1/cmd/ack') return;

  let ack;
  try {
    ack = JSON.parse(payload.toString());
  } catch {
    return;
  }

  const waiter = pending.get(ack.msgId);
  if (!waiter) {
    console.log('⚠️ 收到无法匹配的应答:', ack.msgId);
    return;
  }

  clearTimeout(waiter.timer);
  pending.delete(ack.msgId);
  console.log(`✅ 指令 ${ack.msgId} (${ack.cmd}) 应答: ${ack.result}`);
});

// 发送指令：带上 msgId，登记等待，5 秒超时
function sendCmd(cmdObj) {
  const msgId = crypto.randomUUID(); // 唯一指令 ID
  const full = { ...cmdObj, msgId };

  client.publish('factory/line1/cmd', JSON.stringify(full), { qos: 1 }, (err) => {
    if (err) {
      console.error('指令发送失败:', err.message);
      return;
    }
    console.log(`📤 已发送指令 ${msgId} → ${cmdObj.cmd}`, cmdObj.value ? `(值=${cmdObj.value})` : '');
  });

  // 登记等待 + 超时
  const timer = setTimeout(() => {
    if (pending.has(msgId)) {
      pending.delete(msgId);
      console.log(`⏰ 指令 ${msgId} (${cmdObj.cmd}) 超时无应答！`);
    }
  }, ACK_TIMEOUT_MS);

  pending.set(msgId, { timer });
}

client.on('error', (err) => {
  console.error('连接错误:', err.message);
});

// 演示完 8 秒后自动退出
setTimeout(() => {
  console.log('演示结束，退出');
  client.end();
  process.exit(0);
}, 8000);
