# ERPNext 渐进接管方案

当前架构采用：

```text
现有 Node + SQLite 运营台（继续对外提供页面和原有 API）
                 │
                 ├── 本地数据库：订单、进度、收款、保险箱仍是回滚源
                 └── ERPNext 适配层：默认关闭，准备逐步接管客户/目录/报价/财务
```

## 当前已完成

- `src/erpnext.mjs`：ERPNext REST API 客户端，默认关闭。
- `src/erpnext-map.mjs`：游戏、分类、服务、客户、报价、订单、收款的只读迁移包。
- `GET /api/integrations/erpnext/status`：只返回连接状态，不泄露密钥。
- `GET /api/integrations/erpnext/preview`：查看本地数据将映射成哪些 ERPNext 文档。
- `GET /api/integrations/erpnext/bundle`：导出完整的 ERPNext 迁移包预览，不执行远程写入。
- `POST /api/integrations/erpnext/test`：显式测试连接，不会写 ERPNext。

## 环境变量

```text
XFC_ERPNEXT_ENABLED=1
XFC_ERPNEXT_URL=http://127.0.0.1:8000
XFC_ERPNEXT_API_KEY=...
XFC_ERPNEXT_API_SECRET=...
```

密钥不写入 SQLite、不进入前端响应、不放入迁移 JSON。

## 接管顺序

1. ERPNext 自定义字段和 Item Group 结构
2. 客户 Customer
3. 游戏/分类/服务 Item 与 Item Price
4. 报价 Quotation、订单 Sales Order
5. 财务和收款 Payment Entry 草稿（必须补齐目标账套科目）
6. 新订单双写并核对后，再考虑切换订单主写入
7. 凭证保险箱继续留在本地，不迁移密文

## 当前新增：安全迁移包

执行 `npm run erpnext:bundle` 会在 `backups/erpnext-preview-*/` 生成完整 JSON 包，包含：

- `item_groups`、`items`、`item_prices`
- `customers`
- `quotations`
- `sales_orders`
- `payment_entries`

这个阶段仍然是只读导出。包里会列出重复名称、缺少服务关联、缺少客户关联和 ERPNext 科目未配置等问题；没有通过对账和回滚演练前，不会自动调用 ERPNext 写接口。

在没有完成字段创建、数据对账和回滚演练前，适配层只允许 status、preview、test 三类只读/测试动作。
