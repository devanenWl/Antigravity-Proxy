# Antigravity Proxy

OpenAI / Anthropic 兼容的 Antigravity 反代网关（账号池 + Web 管理面板），支持流式、多模态与工具调用。

## 快速启动

### 0) 先配置 `.env`（必做）

在 `antigravity-proxy/` 下创建 `.env`：

```bash
cat > .env <<'EOF'
PORT=8088
ADMIN_PASSWORD=change-me
JWT_SECRET=change-me-too

# 可选（一般不用填）：npm start 会自动用 ../data/database.sqlite
# DB_PATH=../data/database.sqlite

# 可选：npm 安装很慢时（例如中国大陆网络）
# NPM_REGISTRY=https://registry.npmmirror.com

# 可选：管理接口兼容 Authorization: Bearer <ADMIN_PASSWORD>
# ADMIN_PASSWORD_BEARER_COMPAT=true
EOF
```

### 方式 A：本地一条命令（推荐）

```bash
cd antigravity-proxy
npm start
```


### 方式 B：Docker 一条命令（部署用）

```bash
cd antigravity-proxy
docker compose up -d --build
```

启动后：
- 管理面板：`http://localhost:8088`
- API Base：`http://localhost:8088/v1`

## 添加账号 & 创建 API Key

### 1) 登录管理面板

打开 `http://127.0.0.1:8088`，使用 `ADMIN_PASSWORD` 登录。

### 2) 添加账号（Accounts）

两种方式任选其一：
- **OAuth 绑定**：点 `OAuth` → 新窗口授权 → 复制回调 URL 粘贴回面板 → 完成添加
- **手动添加**：点 `添加` → 填 `email` + `refresh_token`

建议再点一次：**刷新所有 Token 及配额**（同步 token / tier / projectId / quota）。

### 3) 创建 API Key（API Keys）

在 `API Keys` 页面创建 `sk-...`，调用时：
- OpenAI 风格：`Authorization: Bearer sk-...`
- Anthropic 风格：`x-api-key: sk-...`

## Web 管理面板

入口：`http://127.0.0.1:8088`

- `Dashboard`：账号状态、今日请求数/Token、模型使用统计
- `Accounts`
  - OAuth/手动添加账号
  - 单账号刷新：刷新 token 并同步 tier/projectId/quota
  - 刷新所有：一次刷新所有账号 Token 及配额
- `API Keys`：创建/禁用/删除 `sk-...`
- `Logs`：请求日志、筛选模型/账号/状态
- `Settings`：默认模型、轮询策略（weighted/roundrobin/random）

## API 使用

### OpenAI：对话

```bash
curl http://localhost:8088/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

### OpenAI：工具调用

说明：代理只透传 `tools/tool_calls`，不会替你执行工具；工具需要客户端自己执行后再用 `role: "tool"` 回传。

1) 第一次请求：带 `tools`

```bash
curl http://localhost:8088/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role":"user","content":"用工具查一下北京现在几点，然后用一句话回答。"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_time",
        "description": "Get current time for a timezone",
        "parameters": {
          "type": "object",
          "properties": { "timezone": { "type": "string" } },
          "required": ["timezone"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

2) 响应会包含 `tool_calls`（示例）：

```json
{
  "tool_calls": [
    {
      "id": "call_xxx",
      "type": "function",
      "function": { "name": "get_time", "arguments": "{\"timezone\":\"Asia/Shanghai\"}" }
    }
  ]
}
```

3) 客户端执行工具后回传（二次请求）：

```bash
curl http://localhost:8088/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {"role":"user","content":"用工具查一下北京现在几点，然后用一句话回答。"},
      {"role":"assistant","content":null,"tool_calls":[{"id":"call_xxx","type":"function","function":{"name":"get_time","arguments":"{\"timezone\":\"Asia/Shanghai\"}"}}]},
      {"role":"tool","tool_call_id":"call_xxx","name":"get_time","content":"当前时间 (Asia/Shanghai CST): 2025-12-12 23:59:59\\nUTC偏移: +8:00"}
    ]
  }'
```

### Anthropic：对话

```bash
curl http://localhost:8088/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-your-api-key" \
  -d '{"model":"claude-opus-4-5-thinking","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

### Anthropic：工具调用（完整示例，代理只透传）

说明：
- 支持 Anthropic 的 `tool_use/tool_result` 流程（函数工具）。
- Anthropic 内置工具（例如 `web_search_...` / `computer_...`）会被服务端跳过，只透传 `name + input_schema` 这种函数工具。

1) 第一次请求：带 `tools`

```bash
curl http://localhost:8088/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-your-api-key" \
  -d '{
    "model": "claude-opus-4-5-thinking",
    "max_tokens": 256,
    "messages": [
      {"role":"user","content":"用工具查一下北京时间，然后用一句话回答。"}
    ],
    "tools": [
      {
        "name": "get_time",
        "description": "Get current time for a timezone",
        "input_schema": {
          "type": "object",
          "properties": { "timezone": { "type": "string" } },
          "required": ["timezone"]
        }
      }
    ],
    "tool_choice": { "type": "auto" }
  }'
```

2) 响应会包含 `tool_use`（示例）：

```json
{
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_xxx",
      "name": "get_time",
      "input": { "timezone": "Asia/Shanghai" }
    }
  ]
}
```

3) 客户端执行工具后回传（二次请求）：

```bash
curl http://localhost:8088/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-your-api-key" \
  -d '{
    "model": "claude-opus-4-5-thinking",
    "max_tokens": 256,
    "messages": [
      {"role":"user","content":"用工具查一下北京时间，然后用一句话回答。"},
      {"role":"assistant","content":[{"type":"tool_use","id":"toolu_xxx","name":"get_time","input":{"timezone":"Asia/Shanghai"}}]},
      {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_xxx","content":"当前时间 (Asia/Shanghai CST): 2025-12-12 23:59:59\\nUTC偏移: +8:00"}]}
    ]
  }'
```

### 模型列表

```bash
curl http://localhost:8088/v1/models -H "Authorization: Bearer sk-your-api-key"
```

## 多模态（图片输入）

- OpenAI：`messages[].content` 支持 `[{ "type":"text" }, { "type":"image_url" }]`；`image_url.url` 可用 `data:<mime>;base64,...` 或纯 base64（默认按 png）。
- Anthropic：`messages[].content` 支持 `type:"image"` 且 `source.type:"base64"`。

## Anthropic thinking 处理（重要）

Anthropic extended thinking 要求历史 `thinking` 块带 `signature`。由于上游返回的 thinking 不包含 signature：
- 若历史消息不满足签名要求，服务端会自动把本次请求的 `thinking` 设为 `disabled`，并清理历史中的 `thinking/redacted_thinking`，避免 Anthropic 端报错。
- 实现：`backend/src/services/converter.js` → `preprocessAnthropicRequest()`。

## 支持模型（`/v1/models` 返回）

- `gemini-3-pro-high`
- `gemini-3-pro-low`
- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-thinking`
- `gemini-2.5-flash-lite`
- `gemini-3-pro-image`
- `claude-opus-4-5`
- `claude-opus-4-5-thinking`
- `claude-sonnet-4-5`
- `claude-sonnet-4-5-thinking`
- `gpt-oss-120b-medium`

## 项目结构

```text
antigravity-proxy/
├─ Dockerfile
├─ docker-compose.yml
├─ package.json
├─ scripts/start.mjs
├─ backend/
│  └─ src/
│     ├─ index.js            # 服务入口
│     ├─ routes/             # openai / anthropic / admin / oauth / auth
│     ├─ services/           # tokenManager / accountPool / converter / antigravity
│     └─ db/                 # sqlite schema + DAO
└─ frontend/
   └─ src/
      ├─ views/              # Dashboard / Accounts / ApiKeys / Logs / Settings
      └─ components/
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PORT` | `8088` | 对外端口（`npm start` 监听端口 / Docker 映射端口；容器内固定监听 `3000`） |
| `HOST` | `127.0.0.1` | 监听地址（`npm start` 用；Docker 会强制用 `0.0.0.0`） |
| `DB_PATH` | `../data/database.sqlite` | SQLite 路径（`npm start` 默认；Docker 固定 `/app/data/database.sqlite`） |
| `NPM_REGISTRY` | (空) | 仅 `npm start`：自定义 npm registry（网络慢时可用镜像） |
| `AGP_FORCE_BUILD` | `false` | `npm start` 强制重新安装前端依赖并重建 `frontend/dist` |
| `ADMIN_PASSWORD` | `admin123` | 管理面板密码 |
| `JWT_SECRET` | `antigravity-proxy-secret-key-2024` | 管理 JWT 密钥 |
| `ADMIN_PASSWORD_BEARER_COMPAT` | `true` | 兼容 `Authorization: Bearer <ADMIN_PASSWORD>`（建议生产关闭） |
| `DASHBOARD_TZ_OFFSET_MINUTES` | `480` | 仪表盘“今日”统计时区偏移（分钟） |
| `MAX_CONCURRENT_PER_ACCOUNT` | `1` | 单账号并发上限 |
| `MAX_CONCURRENT_PER_MODEL` | `3` | 单模型并发上限 |
| `CAPACITY_COOLDOWN_DEFAULT_MS` | `3000` | 上游容量耗尽后的默认冷却时间（毫秒） |

## License

MIT
