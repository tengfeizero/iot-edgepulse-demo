# 第 5 章 生产部署拓扑（演进路线）

> [← 返回教程目录](../README.md#教程目录生产级-iot-开发教程)

```
【单机 demo】         Mosquitto + 单 sink + 单 TDengine     ← 本仓库
        ↓
【单机生产】          EMQX + sink×2 + TDengine(副本2) + Grafana
        ↓
【集群生产】          EMQX 集群 ×3 + 平台无状态 ×N + TDengine 集群 + K8s
```

组件清单（生产）：

| 组件 | 生产选型 | 替代 |
|---|---|---|
| MQTT Broker | EMQX（开源/企业版） | Mosquitto（小规模） |
| 时序库 | TDengine（国产/工业场景主流） | InfluxDB、TimescaleDB |
| 网关 | 工业网关（ARM+Linux，支持 Node/Go） | 树莓派（原型） |
| 部署 | Docker Compose → K8s | 裸机 |
| 监控 | Prometheus + Grafana + Alertmanager | 云厂商监控 |
| 日志 | Loki / ELK | 云日志服务 |

> [← 上一章：改造路线图](./04-roadmap.md) ｜ [下一章：研究学习要点 →](./06-learning.md)
