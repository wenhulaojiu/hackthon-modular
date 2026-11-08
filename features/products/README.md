# 商品与服务

入口：`products.tsx`。

职责：商品目录与知识编辑界面。

关联文件（相对于仓库根目录）：lib/product-catalog.ts、lib/reply-catalog.ts。

本目录适合分配给对应页面负责人。修改共享类型、服务端权限或其他模块时先协调；本目录的负责人约定不构成访问权限隔离。

验证：在仓库根目录运行 `npm run typecheck`、`npm test`、`npm run build`。界面修改还需通过导航打开本页，验证空数据、正常数据及错误状态；微信相关功能使用测试数据，不启动真实发送。
