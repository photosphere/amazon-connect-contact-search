# Amazon Connect Contact 详情查询

浏览器端查询 Amazon Connect Contact 详情的单页应用，使用 AWS SDK for JavaScript v3 调用 `DescribeContact`、`GetContactAttributes`、`ListRealtimeContactAnalysisSegmentsV2` 等 API，支持查看聊天记录和语音转录。

## 功能

- 输入 Contact ID 查询联系详情（基本信息、坐席、队列、Contact Attributes）
- Chat 渠道：自动加载聊天记录，以气泡样式展示（区分客户 / 坐席 / 系统消息）
- Voice 渠道：自动加载 Contact Lens 语音转录，按发言人分段展示
- 原始 JSON 标签页查看完整 API 返回数据
- 支持临时凭证（Session Token）

## 前置条件

- **Node.js >= 20**（推荐使用 [fnm](https://github.com/Schniz/fnm) 或 [nvm](https://github.com/nvm-sh/nvm) 管理版本）
- **npm**（随 Node.js 一起安装）
- **AWS 凭证**：需要具有以下权限的 IAM Access Key：
  - `connect:DescribeContact`
  - `connect:GetContactAttributes`
  - `s3:GetObject`（读取 S3 中的聊天记录 JSON 文件）
  - `connect:ListContactReferences`（获取附件的预签名下载 URL）
  - `connect-contact-lens:ListRealtimeContactAnalysisSegments`（Voice 转录，需启用 Contact Lens）
- **Amazon Connect 实例**：需要实例 ID

## 安装

```bash
npm install
```

## 运行（开发模式）

```bash
npm run dev
```

浏览器打开 `http://localhost:5173/contact_search.html`。

## 配置

### 方式一：页面手动输入

在页面上展开「AWS Credential 配置」填写 Access Key ID、Secret Access Key、Session Token（可选）和 AWS 区域，填写 Connect 实例 ID 和 Contact ID，点击「查询」。

### 方式二：config.json 自动加载

在项目根目录创建 `config.json`，页面加载时会自动读取并填入表单：

```json
{
  "accessKeyId": "AKIA...",
  "secretAccessKey": "your-secret-key",
  "sessionToken": "",
  "region": "us-east-1",
  "instanceId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

> `config.json` 已在 `.gitignore` 中排除，不会被提交到版本库。可参考 `config.json.example` 创建。

## 构建（生产部署）

```bash
npm run build
```

产物输出到 `dist/` 目录。

### 部署到 S3 + CloudFront

1. 执行 `npm run build` 生成 `dist/` 目录
2. 将 `dist/` 下所有文件上传到 S3 存储桶
3. 如需自动加载默认配置，将 `config.json` 也上传到 S3 存储桶根目录
4. 配置 CloudFront 分发指向该 S3 存储桶
5. 通过 CloudFront 域名访问 `contact_search.html`

## 项目结构

```
├── contact_search.html   # 主页面
├── src/contact-search.js # 业务逻辑（AWS SDK 调用、渲染）
├── config.json.example   # 配置文件示例
├── config.json           # 可选，默认凭证配置（不提交到 Git）
├── vite.config.js        # Vite 构建配置
└── package.json
```
## 截图
<img width="1914" height="3584" alt="Image" src="https://github.com/user-attachments/assets/41907dab-bb48-4f4d-b12b-42aa8ce52c1f" />
