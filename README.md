# mini-agent sandbox

一个最小可运行的 Python 命令沙盒原型，面向课程项目场景。

## 能力范围

- 独立 session 工作目录
- 仅允许执行 `python`
- 仅允许执行 sandbox workspace 内的 `.py` 文件
- 超时控制
- 输出截断
- JSON 执行日志

## 快速开始

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
sandbox-demo demo
```

## 手动运行

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

## Docker

```bash
docker build -t mini-agent-sandbox .
docker run --rm mini-agent-sandbox
```

默认会执行 `sandbox-demo demo`。
