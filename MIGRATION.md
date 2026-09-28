# 组件渐进迁移契约

## 不可破坏的数据

- `orders.order_no`、`orders.total` 和下单时间必须保留。
- `order_items.snapshot` 是老订单的价格与服务快照，不能用当前价格表重算。
- `order_progress`、`payments` 和 `quotes` 必须保留原始 ID 或可追溯映射。
- `credentials.payload_enc` 只能作为密文迁移；没有原保险箱密码和兼容解密实现时，不尝试转换明文。
- `data/uploads/` 必须和数据库一起备份、迁移和校验。

## 替换顺序

1. 游戏、服务价格和客户资料
2. 报价单与财务汇总
3. 订单、收款和进度
4. 凭证保险箱（默认保留原实现）

每一层都先导出数据包，再在副本上导入，最后用 `migration-compare.mjs` 对比。对比通过后才允许切换入口；任何失败都回滚到原 `console.db` 和 `data/uploads/`。

## 命令

```bash
node scripts/migration-check.mjs
node scripts/migration-export.mjs
node scripts/migration-compare.mjs --before <迁移前数据包> --after <迁移后数据包>
```

完整回滚源是数据库快照，不是脱敏后的 JSON 数据包。JSON 数据包不包含登录密码哈希和保险箱密钥材料。
