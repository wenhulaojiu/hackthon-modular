# 页面与业务模块

所有页面在 `app/merchant-app.tsx` 的左侧导航切换；已新增「知识库」独立入口（见下表 `10-知识库`），客户跟进话术改为点击具体话术就地修改（移除了「编辑话术」弹窗）。

| 页面／功能 | 修改目录 | 入口文件 | 关联逻辑／接口 |
| --- | --- | --- | --- |
| 总览 | `01-总览/` | `overview.tsx` | `lib/domain.ts` |
| 客户档案、客户详情、画像与消费展示 | `02-客户档案/` | `customers.tsx` | `lib/domain.ts`、`app/api/ai/` |
| 客户跟进、批量跟进 | `03-客户跟进/` | `marketing.tsx` | `lib/followup.ts`、`app/api/followup/` |
| 微信数据、提取与导入／导出记录 | `04-微信数据/` | `inbox.tsx` | `local-wechat.tsx`、`scripts/local-wechat/` |
| 自动回复、人工接管、本机发送 | `05-自动回复/` | `auto-reply.tsx` | `app/api/reply/`、`scripts/local-wechat/reply-*.mjs` |
| 商品与服务、商品知识 | `06-商品与服务/` | `products.tsx` | `lib/product-catalog.ts`、`lib/reply-catalog.ts` |
| AI 与设置 | `07-AI与设置/` | `settings.tsx` | `app/api/secret/`、`lib/server.ts` |
| 全局数据导出弹窗 | `08-数据导出/` | `data-export.tsx` | `lib/data-export.ts` |
| 业务公共工具与基础样式 | `09-公共工具与样式/` | `ui.ts`、`components.css` | 多模块共享 |
| 知识库、文档式知识库与本地文件上传 | `10-知识库/` | `knowledge-base.tsx` | `lib/guide-knowledge.ts`、`lib/file-import.ts` |

目录名相对于 `页面模块/`。客户详情等页内功能仍在所属业务模块内部，未复制公共状态或拆成独立应用。

页面专用样式与页面放在一起。全局主题仍在 `app/globals.css`、`app/kexu.css`、`app/green-theme.css`，通用 UI 组件仍在 `components/ui/`。

每个目录都有 README，先读职责和验证方式再修改。完整旧路径对应表见 `docs/module-migration.json`。
