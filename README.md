# mini-agent sandbox

一个最小可运行的 Python 命令沙盒原型，面向课程项目场景。

现在同时包含一个**最小 Node.js / Express 网关**，用于：

- 调用大模型生成 Python 代码
- 通过现有 Python sandbox CLI 写入 session workspace
- 触发沙盒执行并返回执行结果

## 能力范围

- 独立 session 工作目录
- 仅允许执行 `python`
- 仅允许执行 sandbox workspace 内的 `.py` 文件
- 超时控制
- 输出截断
- JSON 执行日志
- Express HTTP 网关
- 大模型生成代码后自动执行

## 快速开始

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
sandbox-demo demo
```

## 手动运行

## Python 可调用工具示范

除了 CLI，这个项目现在也提供了一个最小 **Python 可调用工具包装**，直接复用
`SandboxService`：

```python
from mini_agent_sandbox import run_python_tool

result = run_python_tool(
    "print('hello from callable tool')",
    script_path="hello.py",
)

print(result["result"]["stdout"])
```

还附带了一个更贴近“工具调用”的示范：

```python
from mini_agent_sandbox import word_count_tool

result = word_count_tool("the sandbox can be wrapped as a callable tool")
print(result["parsed_output"])
```

直接运行完整示例：

```bash
python examples/python_callable_tool_demo.py
```

### 1. 创建 session

```bash
sandbox-demo create-session
```

记录输出中的 `session_id` 和 `workspace_dir`。

### 2. 在 workspace 中写入脚本

例如在 `workspace_dir` 下写一个 `main.py`。

### 3. 执行脚本

```bash
sandbox-demo run <session_id> main.py arg1 arg2
```

### 4. 写入文件

```bash
printf 'print("hello")\n' | sandbox-demo write-file <session_id> hello.py --stdin
```

### 5. 清理 session

```bash
sandbox-demo cleanup-session <session_id>
```

## Node.js / Express 网关

网关代码位于 `gateway/`，职责是：

1. 接收 HTTP 请求
2. 调用大模型生成 Python 代码
3. 调用 Python CLI 创建 sandbox session / 写文件 / 执行脚本
4. 把执行结果回传给调用方

### 前置要求

- Python 3.11+
- Node.js 18+
- 已完成 Python 包安装：`pip install -e .`
- 可用的大模型兼容接口（默认按 OpenAI Chat Completions 协议调用）

### 安装网关依赖

```bash
cd gateway
npm install
```

### 环境变量

最小需要：

```bash
export LLM_API_KEY=your_api_key
```

可选变量：

```bash
export PORT=3000
export PYTHON_BIN=python
export SANDBOX_MODULE=mini_agent_sandbox.cli
export LLM_API_URL=https://api.openai.com/v1/chat/completions
export LLM_MODEL=gpt-4o-mini
export DEFAULT_TIMEOUT_MS=5000
export MAX_TIMEOUT_MS=10000
export SESSION_TTL_MS=600000
```

### 启动网关

```bash
cd gateway
npm start
```

### 接口

#### 1. 健康检查

```bash
curl http://localhost:3000/health
```

返回示例：

```json
{
  "ok": true,
  "sessionTtlMs": 600000
}
```

#### 2. 创建 sandbox session

```bash
curl -X POST http://localhost:3000/sandbox/sessions
```

返回示例：

```json
{
  "session_id": "sess_xxx",
  "workspace_dir": "/tmp/mini-agent-sandbox/sessions/sess_xxx/workspace",
  "logs_dir": "/tmp/mini-agent-sandbox/sessions/sess_xxx/logs",
  "cleanup_at": "2026-04-25T12:00:00.000Z"
}
```

#### 3. 生成并执行代码

```bash
curl -X POST http://localhost:3000/generate-and-run \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "Write a Python script that prints the first 10 Fibonacci numbers.",
    "fileName": "fibonacci.py",
    "timeoutMs": 5000,
    "scriptArgs": []
  }'
```

返回示例：

```json
{
  "sessionId": "sess_xxx",
  "fileName": "fibonacci.py",
  "filePath": "/tmp/mini-agent-sandbox/sessions/sess_xxx/workspace/fibonacci.py",
  "timeoutMs": 5000,
  "generatedCode": "numbers = [0, 1]\n...",
  "sessionCleanup": {
    "mode": "immediate",
    "cleanup_at": null
  },
  "execution": {
    "success": true,
    "exit_code": 0,
    "stdout": "0 1 1 2 3 5 8 13 21 34\n",
    "stderr": "",
    "timeout": false,
    "duration_ms": 25,
    "truncated": false
  }
}
```

说明：

- 如果请求里**不传** `sessionId`，网关会创建一个临时 session，并在执行结束后**立即清理**。
- 如果请求里**传了** `sessionId`，网关会复用该 session，并把清理时间延后到 `SESSION_TTL_MS`。

#### 4. 直接执行传入代码

```bash
curl -X POST http://localhost:3000/execute-code \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "print(\"hello direct execution\")",
    "fileName": "hello.py",
    "timeoutMs": 5000,
    "scriptArgs": []
  }'
```

返回示例：

```json
{
  "sessionId": "sess_xxx",
  "fileName": "hello.py",
  "filePath": "/tmp/mini-agent-sandbox/sessions/sess_xxx/workspace/hello.py",
  "timeoutMs": 5000,
  "code": "print(\"hello direct execution\")",
  "sessionCleanup": {
    "mode": "immediate",
    "cleanup_at": null
  },
  "execution": {
    "success": true,
    "exit_code": 0,
    "stdout": "hello direct execution\n",
    "stderr": "",
    "timeout": false,
    "duration_ms": 20,
    "truncated": false
  }
}
```

#### 5. 删除 sandbox session

```bash
curl -X DELETE http://localhost:3000/sandbox/sessions/<session_id>
```

## 当前实现边界

为了先做最简单处理，当前网关采用以下策略：

- 只生成并执行 **Python** 代码
- 通过 **CLI 桥接** Python sandbox，而不是直接嵌入 Python API
- 默认使用 OpenAI 兼容的 `chat/completions` 接口
- 已支持 session 自动回收，但未做多租户鉴权、请求队列、审计增强

这适合作为后续增强版 agent runtime 的最小起点。

## Docker

```bash
docker build -t mini-agent-sandbox .
docker run --rm mini-agent-sandbox
```

默认会执行 `sandbox-demo demo`。
