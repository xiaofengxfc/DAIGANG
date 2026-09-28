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
- `src/erpnext-map.mjs`：游戏、分类、服务、客户的只读映射预览。
- `GET /api/integrations/erpnext/status`：只返回连接状态，不泄露密钥。
- `GET /api/integrations/erpnext/preview`：查看本地数据将映射成哪些 ERPNext 文档。
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
4. 报价 Quotation
5. 财务和收款
6. 新订单双写并核对后，再考虑切换订单主写入
7. 凭证保险箱继续留在本地，不迁移密文

在没有完成字段创建、数据对账和回滚演练前，适配层只允许 status、preview、test 三类只读/测试动作。
