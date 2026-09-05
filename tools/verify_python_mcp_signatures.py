"""Verify that FastMCP's inferred Python schemas match the canonical action contract."""

from __future__ import annotations

import ast
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / "contracts" / "qc-actions.v1.json").read_text(encoding="utf-8"))
TREE = ast.parse(
    (ROOT / "services" / "mcp-server" / "src" / "qc_mcp_server" / "server.py").read_text(encoding="utf-8")
)
TOOLS = next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "QcTools")
METHODS = {node.name: node for node in TOOLS.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}

for action in CONTRACT["actions"]:
    name = action["name"]
    if name not in METHODS:
        raise SystemExit(f"Python MCP is missing contracted method {name}")
    method = METHODS[name]
    positional = method.args.posonlyargs + method.args.args
    if not positional or positional[0].arg != "self":
        raise SystemExit(f"Python MCP method {name} must be an instance method")
    actual = [argument.arg for argument in positional[1:]]
    expected = list(action["properties"])
    if actual != expected or method.args.vararg or method.args.kwarg or method.args.kwonlyargs:
        raise SystemExit(f"Python MCP signature drift for {name}: expected {expected}, got {actual}")
    default_count = len(method.args.defaults)
    required = set(actual[: len(actual) - default_count] if default_count else actual)
    if required != set(action["required"]):
        raise SystemExit(
            f"Python MCP required/default drift for {name}: "
            f"expected {sorted(action['required'])}, got {sorted(required)}"
        )

tap = METHODS["tap_screen"]
tap_annotations = {argument.arg: ast.unparse(argument.annotation) for argument in tap.args.args if argument.annotation}
if tap_annotations.get("x") != "int" or tap_annotations.get("y") != "int":
    raise SystemExit("Python MCP tap_screen coordinates must remain integer pixels")

print(json.dumps({"verified": True, "actions": len(CONTRACT["actions"]), "implementation": "QcTools"}))
