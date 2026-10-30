// 模拟一台 Modbus TCP 设备（从站）
// 作用：在寄存器里放"温度"和"转速"两个值，供主站（网关/采集器）读取
// 用法：node modbus-sim.js [端口] [从站号] [设备名]
//   node modbus-sim.js            → 端口5020 从站1  device-1
//   node modbus-sim.js 5021 2     → 端口5021 从站2  device-2
const ModbusRTU = require('modbus-serial');

const args = process.argv.slice(2);
const PORT = Number(args[0]) || 5020; // 监听端口（每台设备一个端口）
const UNIT_ID = Number(args[1]) || 1; // 从站地址
const DEVICE_NAME = args[2] || `device-${UNIT_ID}`; // 设备名（仅日志用）

// 设备的数据存储区（寄存器模型）
const holdingRegisters = [0, 0]; // [0]=温度, [1]=转速
let baseSpeed = 2000; // 设定转速（默认 B 档 2000rpm，可由平台远程改写）

// vector：告诉 modbus 服务器库"怎么读我的数据"
const vector = {
  // 读保持寄存器（功能码 03）
  getHoldingRegister: function (addr) {
    return holdingRegisters[addr];
  },
  // 读输入寄存器（功能码 04）
  getInputRegister: function (addr) {
    return holdingRegisters[addr];
  },
  // 写保持寄存器（功能码 06/16）——模拟"平台下指令改参数"
  setRegister: function (addr, value) {
    holdingRegisters[addr] = value;
    if (addr === 1) baseSpeed = value; // 写入转速寄存器 → 更新设定转速
    console.log(`✍️ 寄存器 ${addr} 被写入: ${value}`);
  },
  // 线圈读写（这里简单模拟）
  getCoil: () => true,
  setCoil: () => {},
  getDiscreteInput: () => true,
};

// 启动 Modbus TCP 服务器（从站）
// 注意：构造签名是 ServerTCP(vector, options) —— vector 在前
const server = new ModbusRTU.ServerTCP(vector, {
  host: '127.0.0.1',
  port: PORT,
  unitID: UNIT_ID,
});

server.on('socketError', (err) => {
  console.error('socket 错误:', err.message);
});

console.log(`✅ Modbus TCP 模拟设备 [${DEVICE_NAME}] 已启动: 127.0.0.1:${PORT} (从站地址 ${UNIT_ID})`);
console.log('   寄存器: [0]=温度, [1]=转速');

// 模拟设备运行：每秒更新一次
// 温度随机变化；转速围绕"设定值"小幅波动（模拟电机平稳运行，设定值由平台远程改写）
setInterval(() => {
  holdingRegisters[0] = Math.round(20 + Math.random() * 10); // 温度 20~30°C
  holdingRegisters[1] = baseSpeed + Math.round(Math.random() * 60 - 30); // 设定值 ±30 rpm
}, 1000);
