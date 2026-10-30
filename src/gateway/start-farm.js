// 一键启动多终端 + 多网关（3 台设备 + 3 个网关）
// 用法：node src/gateway/start-farm.js   （Ctrl+C 退出）
// 另需：Mosquitto、TDengine、tsdb-sink.js、dashboard-server.js 可另行启动
const { spawn } = require('child_process');
const path = require('path');

// 设备/网关配对：gw1→设备5020从站1, gw2→设备5021从站2, gw3→设备5022从站3
const DEVICE_SCRIPT = path.join(__dirname, '..', 'device', 'modbus-sim.js');
const GATEWAY_SCRIPT = path.join(__dirname, 'gateway.js');
const FARM = [
  { file: DEVICE_SCRIPT, args: ['5020', '1', 'device-1'] },
  { file: GATEWAY_SCRIPT, args: ['gw1', '5020', '1'] },
  { file: DEVICE_SCRIPT, args: ['5021', '2', 'device-2'] },
  { file: GATEWAY_SCRIPT, args: ['gw2', '5021', '2'] },
  { file: DEVICE_SCRIPT, args: ['5022', '3', 'device-3'] },
  { file: GATEWAY_SCRIPT, args: ['gw3', '5022', '3'] },
];

const procs = [];
for (const { file, args } of FARM) {
  const p = spawn(process.execPath, [file, ...args], { stdio: 'inherit' });
  procs.push(p);
  p.on('exit', (code) => console.log(`[${file} ${args.join(' ')}] 退出 (code=${code})`));
}

console.log('🏭 已启动 3 台模拟设备 + 3 个网关（Ctrl+C 停止全部）');
process.on('SIGINT', () => {
  console.log('\n⏹ 停止所有进程...');
  procs.forEach((p) => p.kill());
  process.exit(0);
});
