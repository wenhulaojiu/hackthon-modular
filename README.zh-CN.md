# 客序 · 商户客户经营工作台

用于管理客户档案、导入聊天记录、整理带证据的客户画像、审核消费候选，并安排后续服务与营销跟进。

首次打开包含16位虚构客户、近30天订单、待确认收款与退款、8条任务。演示数据标记为 `demo`，日期随上海当天日期生成；请勿把演示订单当作真实经营数据。

## 本地一键提取微信

已接入 [yeklongdi/wechat-chat-export](https://github.com/yeklongdi/wechat-chat-export) 的本机调用流程。Windows 上先安装 Node.js 24，完整解压本地包，双击 **启动客序.cmd**；首次再运行 **安装微信提取组件.cmd**（需要64位 Python 3.11+）。在本地工作台的「微信数据 → 一键提取」中主动读取会话列表，选择好友私聊与起止日期，再点击「一键提取并导入」。

导出任务有进度、失败与取消状态，验证通过后自动合并客户记录，不再需要手动选择导出文件。重复导入按原生消息标识去重，手工标签与已有画像会保留。首次导入会询问是否移除虚构示例档案；消费依然需要商家确认。单次最多20位好友、连续31天，并受工作空间容量限制。

在线预览无法直接启动用户电脑里的程序，在线页面提供本地版下载；本机提取使用 `http://127.0.0.1:5173/`，聊天和客户资料保存在本机 D1。只有主动点击 AI 功能时，当前客户上下文才发送到所配置的模型供应商。启动、安装和状态检查不会扫描微信；读取会话列表和导出都需要用户主动操作。

完整环境、版本与权限要求见 [本地微信提取说明](docs/本地微信提取.md)。尚未使用真实微信或真实聊天做开发验收；上游不支持的客户端、登录状态或进程权限会返回实际错误。

## 本地运行与检查

网页版用户直接登录使用即可，无需运行以下命令。以下步骤适用于开发者首次在本机部署，使用 Node.js 24。项目沿用 Sites / Cloudflare 运行环境、D1 数据存储和 ChatGPT 登录。

```powershell
npm ci
node --input-type=module -e "import {randomBytes} from 'node:crypto'; import {writeFileSync} from 'node:fs'; writeFileSync('.dev.vars', 'APP_ENCRYPTION_KEY=' + randomBytes(32).toString('base64') + '\n', {encoding:'utf8',flag:'wx'});"
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_workable_sunset_bain.sql
npm run dev
```

上面的随机密钥直接写入 UTF-8 `.dev.vars`，不会打印到终端；`flag:'wx'` 会拒绝覆盖已有文件。若已有 `.dev.vars`，保留原来的 `APP_ENCRYPTION_KEY`，不要重新生成。该文件已被 `.gitignore` 排除，禁止提交。首次构建先生成 `dist/server/wrangler.json`，然后初始化本地 D1 数据表；缺少初始化会报数据表不存在。数据库初始化仅在新环境执行，已有数据库不要重复执行建表 SQL。

生产构建与本地预览：

```powershell
npm run build
npm run start
```

数据层验证不需要模型密钥，也不会访问真实微信：

```powershell
node --experimental-strip-types --test tests/domain.test.ts
node --test app/api/backend.test.mjs
```

代码检查：

```powershell
npx tsc --noEmit
```

也可运行 npm run local，由启动器准备首次本地配置；本地数据库及登录需要项目运行环境的配置；未登录时 API 不会返回门店数据。部署前应按项目 Cloudflare 配置准备 D1 数据表和加密密钥。不要将数据库凭据或模型密钥写进源码。

## 连接真实模型

在「设置」填写模型接口、模型名与自己的 API Key，再使用连接测试。默认设置：

| 项目 | 默认值 |
|---|---|
| Base URL | `https://api.deepseek.com` |
| 模型 | `deepseek-chat` |
| 温度 | `0.5` |

支持返回 OpenAI 兼容 Chat Completions JSON 的公共 HTTPS 接口。Base URL 可填供应商根路径或包含 `/v1` 的前缀；服务端会拼接 `/chat/completions`。不支持本机、内网地址及非标准端口。供应商需要支持 `response_format: {"type":"json_object"}`。

API Key 在服务端按登录用户保存，并使用 AES-GCM 加密，不包含在门店备份中。服务端必须配置 `APP_ENCRYPTION_KEY`：32字节随机值的 Base64 编码。它是应用加密密钥，不是模型 API Key，不应提交 Git。更换应用加密密钥后，需要重新保存已有模型密钥。

画像、话术和消费提取只在主动点击相应按钮时请求模型，调用会产生供应商费用。模型只接收当前客户的部分近期聊天和必要客户信息；这是向所选模型供应商传输数据，请先确认自己有权处理这些聊天。

## 微信数据与 Skills 边界

本地模式通过独立安装的微信导出组件读取所选私聊，不内置数据库密钥，也不调用密钥写出工具；在线模式保留文件导入。两种模式都不包含微信发送程序或企业微信会话存档服务。

文件导入链路仍保留：

```text
本人有权使用的微信/企业微信聊天导出
→ JSON / JSONL / UTF-8 CSV / TXT / Markdown
→ 本工作台导入
→ 核对联系人和消息
→ 生成画像、话术或消费候选
→ 商户审核后保存
```

可使用已有聊天导出工具或已授权的企业微信渠道取得文件。`customer-community-profiler`、`customer-solution-library` 等分析型 Skills 可以作为外部工作流参考，这些分析型 Skills 不属于本地导出组件，本项目不自动安装或运行它们。导入只保存与整理聊天，**不会自动调用 AI**；导入后，需要打开客户档案主动点击画像、话术或消费提取，再使用所配置的真实模型。第三方工具的许可、客户端版本与数据权限需要独立确认。

### 已适配 wechat-chat-export

已按 [yeklongdi/wechat-chat-export 的公开导出代码](https://github.com/yeklongdi/wechat-chat-export/blob/main/scripts/export_wechat.py)核对并适配其 `main` 在2026年10月22日更新的**好友私聊 JSON / TXT**结构。上游 [SKILL.md](https://github.com/yeklongdi/wechat-chat-export/blob/main/SKILL.md)声明实时读取适用于 Windows 微信4.x，已核对4.1.6.46的会话目录；这不是本工作台对所有微信版本的实机兼容保证。本工作台只接收它导出的文件，不安装或运行其微信读取、数据库或密钥扫描代码。

该工具原生导出 TXT、JSON，**不原生导出 JSONL 或 CSV**；后两者属于本工作台通用导入协议。推荐选择好友私聊的 `聊天记录.json`，不要上传 `验证报告.json`、终端输出的文件路径清单或文件传输助手记录。

JSON 中使用 `metadata.chat` 作为客户称呼、`metadata.chat_username` 作为稳定微信标识；`sender=我` 识别为商家，其他消息核对 `sender_username`，`timestamp`（秒）或 `time`（带时区ISO）用于消息时间。原生 `server_id` 用于重复导出去重；同一秒内容相同但原生ID不同的两条消息会保留。TXT 的 `[时间] [发送人] [类型]` 与后续多行正文会按消息块还原，说明前言不会作为聊天导入。

当前限制：

- 群聊 JSON、`@chatroom` 会话及文件传输助手会显式拒绝，避免把多人发言归到一位客户。
- 原生 TXT 没有微信号和会话类型，不能可靠自动识别群聊；仅导入你已核对的好友私聊，并人工确认客户身份。TXT 不会按昵称自动合并已有客户，建议优先使用 JSON。
- 系统通知和合并转发记录会跳过并提示；合并转发中的原始消息不能当作当前客户本人陈述。
- 引用消息加上 `【引用资料，非客户本人陈述】`；引文不作为客户本人事实或付款依据。
- 图片、语音、视频与附件只保留导出文件提供的类型和描述，不识别或上传媒体本体。
- `转账/收款`、`app_message.kind=payment` 卡片只保留为 `【转账/收款卡片，到账状态未核实】` 线索。上游没有提供可靠的已到账状态或独立金额核验接口，卡片与红包不能当作营业收入凭据；需要实际收款证据和人工核对。

真实结构的合成样例可下载 `/wechat-chat-export-example.json` 与 `/wechat-chat-export-example.txt`。样例不含真实聊天；已用测试覆盖私聊身份、角色、上海时区、多行正文、重复ID、群聊拒绝、转发隔离及支付卡片不自动入账。

## 导入协议

可在站点下载示例：`/chat-import-example.json` 与 `/chat-import-example.csv`。示例中的客户、微信号和聊天均为虚构信息，日期仅演示格式。

单次导入文件或粘贴内容上限为 **2,000,000个 UTF-8 字节（约2MB）**。当前工作空间最多500位客户、每位1500条聊天、合计12000条，单条正文最多8000字。完整业务状态在前端限制为 **1,450,000个 UTF-8 字节（约1.45MB）**，服务端保存上限为1,500,000字节；完整状态还包含订单、任务和设置，因此不能把2MB聊天文件视为一定可全部存入。较大记录请先筛选必要会话与时间范围。

### 会话 JSON

支持会话数组、`customers` / `conversations` / `chats` / `sessions` 数组，或一个包含 `messages` 的单联系人对象：

```json
{
  "customers": [
    {
      "id": "external-001",
      "name": "示例客户",
      "wechatId": "wx_example_001",
      "messages": [
        {
          "sender": "customer",
          "content": "想了解200元以内的礼盒，暂时还没决定买。",
          "timestamp": "2026-11-07T09:00:00+08:00"
        },
        {
          "sender": "merchant",
          "text": "可以，我先给您发实际商品信息。",
          "date": "2026-11-07"
        }
      ]
    }
  ]
}
```

`content` 与 `text` 均可。推荐角色为 `customer` / `merchant`；`self`、`me`、`我`、`商家`、`客服`也识别为商家。其他角色默认作为客户，导入后应核对。

### JSONL 与 CSV

JSONL 每行一条消息。推荐字段：

```json
{"chat_id":"chat-001","customer_name":"示例客户","wechat_id":"wx_example_001","timestamp":"2026-11-07T09:00:00+08:00","sender":"customer","content":"请问这个产品多少钱？"}
```

CSV 使用同名表头，例如：

```csv
customer_id,customer_name,wechat_id,timestamp,sender,content
customer-001,示例客户,wx_example_001,2026-11-07,customer,"请问这个产品多少钱？"
```

CSV 支持 UTF-8 BOM、引号内逗号、双引号转义以及跨行消息。Excel 文件请先另存为 UTF-8 CSV。日期推荐有效的 `YYYY-MM-DD` 或带时区 ISO 时间；也接受秒或毫秒时间戳。

TXT / Markdown 按单个联系人文本导入，文件名用作客户名，不会执行其中的指令。可用 `2026-11-07 09:00 客户名：消息` 格式；未识别的整行默认客户消息。缺少有效日期的消息暂记为当天并显示警告，需要手工核对，不能据此推断真实付款时间。

只有明确的 `wechatId` / `wechat_id` / `wxid` 才用来匹配已有档案。同昵称、导出中的同名 `id` 不会自动合并已有客户。缺少微信号会新建独立档案，因此建议导出时保留稳定微信号。同一微信号的重复消息按角色、时间、正文去重；重复导入不会再次累积这些消息。

## 消费确认与统计

- `pending`：待审核候选，不计入收入或消费次数。
- `confirmed` + `sale`：增加消费金额，增加一次消费次数。
- `confirmed` + `refund`：扣减消费金额，不增加消费次数；退款金额存为正数。
- `rejected`：已排除，不计入金额与次数。

报价、询价、想买、预约和未付款均不等于收入。AI 与本地付款规则的输出都是候选，需要核对金额、日期、付款凭据和是否重复交易后确认。本地规则只匹配明确已付款/已收款/已退款语句，是保守的文字规则，不是支付接口或 AI 识别；同日同金额的重复候选会保守去重，实际多次付款可人工补记。

概览时间范围包含上海今天，按订单日期筛选已确认销售与退款；客户累计消费按所有历史已确认交易计算。累计消费可以因退款形成负数，不会被强制清零。消费次数表示确认销售记录数量，并不等于到店次数或支付平台笔数。

## 备份、提醒与隐私

定期通过概览页「导出数据」保存备份，特别是在批量导入、清理演示数据或大规模修改之前。备份包含客户资料、聊天、订单、任务和提示词，不含模型 API Key。备份文件需要像客户原始资料一样妥善保管。当前页面没有一键恢复完整备份的入口，文件可留作后续迁移；不要把完整备份误当作聊天文件导入。

在线版门店数据按登录账户存储在托管数据库；本地版使用当前电脑的 D1 数据库。模型请求仍会向供应商发送相关上下文，因此不能把产品描述为完全离线或“数据绝不离开本机”。仅处理本人有权使用或已获得授权的数据，避免上传无关身份信息及完整敏感资料。用户主动调用模型时，相关上下文会发送到所选模型服务。应用导出文件和导入源文件不应提交公开 Git 仓库。

任务仅是站内待办与到期提醒，不会自动打开微信、群发、添加好友或向客户发送消息。即使设置了跟进日期，话术仍需由商户审核后自行发送；关闭网页不会触发后台定时推送。
