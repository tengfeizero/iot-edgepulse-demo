// 发布端：模拟一台温度传感器，每秒上报一次温度，QoS 1
const mqtt = require('mqtt');

const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://localhost:1883', {
  clientId: 'sensor-001',
  clean: false, // 会话保持：断线重连后服务端继续帮我们转发
});

client.on('connect', () => {
  console.log('设备已连接 broker');

  // 每秒上报一次温度（模拟）
  setInterval(() => {
    const payload = JSON.stringify({
      deviceId: 'sensor-001',
      temperature: +(20 + Math.random() * 10).toFixed(2),
      ts: Date.now(),
    });

    // QoS 1：保证至少到 broker 一次
    client.publish('factory/line1/temperature', payload, { qos: 1 }, (err) => {
      if (err) console.error('发布失败:', err.message);
    });
  }, 1000);
});

client.on('error', (err) => {
  console.error('连接错误:', err.message);
});
