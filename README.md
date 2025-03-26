# Backpack 自动交易系统

这是一个基于 Backpack 交易所的自动交易系统，支持自动买入、止盈和风险控制。

## 文件结构

```
├── start_auto_trading.js      # 主启动脚本
├── test_create_orders_auto.js # 交易执行脚本
├── backpack_trading_config.json # 配置文件
├── backpack_exchange-main/    # Backpack API 客户端
│   └── backpack_client.js
└── logs/                      # 日志目录
    ├── trading_YYYY-MM-DD.log    # 交易日志
    ├── error_YYYY-MM-DD.log      # 错误日志
    └── auto_trading_cycle_YYYY-MM-DD.log # 交易周期日志
```

## 配置文件说明

`backpack_trading_config.json` 包含以下配置项：

```json
{
  "trading": {
    "tradingCoin": "BTC",           // 交易币种
    "initialPrice": 50000,          // 初始价格
    "takeProfitPercentage": 5,      // 止盈百分比
    "maxDropPercentage": 10,        // 最大跌幅百分比
    "totalAmount": 1000,            // 总投资金额（USDC）
    "orderCount": 5,                // 买入次数
    "incrementPercentage": 10       // 每次买入递增百分比
  },
  "actions": {
    "autoRestartAfterTakeProfit": true,  // 止盈后是否自动重启
    "autoRestartNoFill": true,           // 无订单成交是否自动重启
    "autoCancelOrders": true             // 是否自动取消未成交订单
  },
  "advanced": {
    "noFillRestartMinutes": 60,          // 无订单成交重启等待时间（分钟）
    "orderCheckInterval": 600000,        // 订单检查间隔（毫秒）
    "priceCheckInterval": 60000,         // 价格检查间隔（毫秒）
    "maxRetries": 3                      // 最大重试次数
  }
}
```

## 脚本说明

### 1. start_auto_trading.js
主启动脚本，负责：
- 启动交易脚本
- 监控脚本运行状态
- 自动重启功能
- 处理进程终止信号

### 2. test_create_orders_auto.js
交易执行脚本，包含：
- 订单创建逻辑
- 价格监控
- 止盈处理
- 风险控制
- 订单状态更新

### 3. backpack_client.js
Backpack 交易所 API 客户端，处理：
- API 认证
- 订单操作
- 账户查询
- 市场数据获取

## 工作原理

1. **启动流程**：
   - 读取配置文件
   - 启动交易脚本
   - 开始监控价格和订单

2. **交易策略**：
   - 在初始价格基础上，按递增比例创建多个买入订单
   - 监控订单成交情况
   - 达到止盈目标时自动卖出
   - 超过最大跌幅时自动止损

3. **风险控制**：
   - 设置最大跌幅限制
   - 自动取消未成交订单
   - 定期检查订单状态
   - 异常情况自动重启

4. **自动重启机制**：
   - 止盈后自动重启
   - 无订单成交自动重启
   - 异常退出自动重启

## 使用方法

1. **配置设置**：
   ```bash
   # 编辑配置文件
   nano backpack_trading_config.json
   ```

2. **启动程序**：
   ```bash
   # 启动自动交易
   node start_auto_trading.js
   ```

3. **监控运行**：
   - 查看控制台输出
   - 检查日志文件
   - 监控订单状态

4. **停止程序**：
   - 按 Ctrl+C 优雅退出
   - 程序会自动取消所有未成交订单

## 注意事项

1. **风险提示**：
   - 请确保理解交易策略
   - 合理设置止盈止损
   - 注意资金安全

2. **配置建议**：
   - 初始价格建议设置为当前市价
   - 止盈目标建议 3-5%
   - 最大跌幅建议 10-15%
   - 买入次数建议 3-5 次

3. **运行环境**：
   - Node.js 环境
   - 稳定的网络连接
   - 足够的系统资源

4. **日志管理**：
   - 定期检查日志文件
   - 及时处理错误信息
   - 保留重要交易记录

## 常见问题

1. **程序无法启动**：
   - 检查配置文件格式
   - 确认 API 密钥正确
   - 验证网络连接

2. **订单未成交**：
   - 检查价格设置
   - 确认市场流动性
   - 查看订单状态

3. **程序异常退出**：
   - 检查错误日志
   - 验证系统资源
   - 确认网络状态

## 更新日志

### v1.0.0
- 初始版本发布
- 基本交易功能
- 自动重启机制
- 日志记录系统 