// 查询验证：从 TDengine 读最近写入的设备数据
// 用法：node tsdb-query.js
const TD_URL = process.env.TD_URL || 'http://localhost:6041';
const AUTH = 'Basic ' + Buffer.from('root:taosdata').toString('base64');

async function main() {
  try {
    // 1. 看有哪些库
    const dbs = await q('SHOW DATABASES');
    console.log('📦 数据库列表:', dbs.data.map((r) => r[0]).join(', '));

    // 2. 查最近 10 条设备数据（按时间倒序）
    const rows = await q(
      `SELECT ts, device_id, temperature, speed
       FROM iot_demo.device_data
       ORDER BY ts DESC
       LIMIT 10`
    );
    console.log(`\n📊 最近 ${rows.data.length} 条设备数据:`);
    console.log('时间戳                   设备          温度    转速');
    for (const r of rows.data) {
      const t = new Date(r[0]).toLocaleString('zh-CN', { hour12: false });
      console.log(`${t}  ${String(r[1]).padEnd(12)} ${String(r[2]).padEnd(6)} ${r[3]}`);
    }

    // 3. 统计每个设备的记录数
    const stats = await q(
      `SELECT device_id, COUNT(*) AS cnt
       FROM iot_demo.device_data
       GROUP BY device_id`
    );
    console.log('\n📈 各设备数据量:');
    for (const r of stats.data) {
      console.log(`  ${r[0]}: ${r[1]} 条`);
    }
  } catch (err) {
    console.error('❌ 查询失败:', err.message);
    console.error('  确认：1) TDengine 已启动 2) REST 端口 6041 可访问 3) iot_demo 库已建（先跑 tsdb-sink.js）');
    process.exit(1);
  }
}

async function q(sql) {
  const res = await fetch(`${TD_URL}/rest/sql`, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'text/plain' },
    body: sql,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`SQL 错误: ${json.desc}`);
  return json;
}

main();
