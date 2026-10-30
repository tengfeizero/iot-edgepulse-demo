// Modbus 主站（采集器/网关）：读取模拟设备的温度和转速
// 用法：node modbus-reader.js
const ModbusRTU = require('modbus-serial');

async function main() {
  const client = new ModbusRTU();

  try {
    // 1. 连接设备（Modbus TCP）
    await client.connectTCP('127.0.0.1', { port: 5020 });
    await client.setID(1); // 从站地址 1
    client.setTimeout(3000);
    console.log('✅ 已连接 Modbus 设备 (127.0.0.1:5020, 从站 1)\n');

    // 2. 连续读取 5 次，演示"轮询采集"
    for (let i = 0; i < 5; i++) {
      // 读保持寄存器：从地址 0 开始，读 2 个
      const res = await client.readHoldingRegisters(0, 2);

      const temperature = res.data[0]; // 寄存器0 = 温度
      const speed = res.data[1];       // 寄存器1 = 转速

      console.log(
        `第 ${i + 1} 次采集 → 温度: ${temperature}°C, 转速: ${speed} rpm`
      );
      await sleep(1000);
    }

    // 3. 演示"写寄存器"（模拟平台下发设定值给设备）
    console.log('\n--- 演示写寄存器（下发指令）---');
    await client.writeRegister(0, 25); // 把温度寄存器写成 25
    const after = await client.readHoldingRegisters(0, 1);
    console.log(`写入后读回: 温度寄存器 = ${after.data[0]}（下次设备自动更新后会变）`);

    client.close();
    console.log('\n采集完成，连接已关闭');
  } catch (err) {
    console.error('采集失败:', err.message);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main();
