from __future__ import annotations

import json
from importlib import import_module
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


def main() -> None:
    tool_demo = import_module("mini_agent_sandbox.tool_demo")
    result = tool_demo.word_count_tool("the sandbox can be wrapped as a callable tool")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
