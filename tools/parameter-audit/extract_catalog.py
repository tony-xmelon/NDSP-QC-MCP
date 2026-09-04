"""Extract the generated Quad Cortex parameter registry into a stable audit fixture.

The upstream pyquadcortex protocol package generates ``models.py`` and
``params.py`` from a real QC ModelRepo.  This extractor deliberately uses the
generated source rather than importing an unreleased checkout, so the audit is
repeatable without changing the application's pinned runtime dependency.
"""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
import re
import subprocess


SUPPORTED_KINDS = {
    "comboBox", "empty", "fader", "float", "floatWithLed", "grMeter", "int",
    "rotarySwitch", "string", "switch", "toggleButton"
}


def assignment(tree: ast.Module, name: str) -> ast.Dict:
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            if isinstance(node.value, ast.Dict):
                return node.value
    raise ValueError(f"Could not find dictionary assignment {name!r}")


def literal_dict(node: ast.Dict) -> dict:
    result = {}
    for key, value in zip(node.keys, node.values, strict=True):
        if key is None:
            continue
        parsed_key = ast.literal_eval(key)
        if isinstance(value, ast.Name):
            parsed_value = value.id
        else:
            parsed_value = ast.literal_eval(value)
        result[parsed_key] = parsed_value
    return result


def class_identity(node: ast.ClassDef) -> tuple[str, str]:
    doc = ast.get_docstring(node) or node.name
    match = re.fullmatch(r"(.*) \(([^()]*)\)\.", doc)
    return (match.group(1), match.group(2)) if match else (doc, "Unknown")


def annotation_unit(annotation: ast.expr) -> str:
    if isinstance(annotation, ast.Subscript):
        slice_node = annotation.slice
        if isinstance(slice_node, ast.Name):
            return slice_node.id.removesuffix("Unit")
    return "No"


def parameter_sets(source: str, tree: ast.Module) -> dict[str, dict]:
    lines = source.splitlines()
    result = {}
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        if not any(isinstance(base, ast.Name) and base.id == "ParamSet" for base in node.bases):
            continue
        display_name, category = class_identity(node)
        parameters = []
        for member in node.body:
            if not isinstance(member, ast.AnnAssign) or not isinstance(member.target, ast.Name):
                continue
            call = member.value
            if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id != "Param" or len(call.args) < 2:
                continue
            index = ast.literal_eval(call.args[0])
            name = ast.literal_eval(call.args[1]).replace("_", " ")
            comment = lines[member.lineno - 1].partition("#")[2].strip()
            kind = comment.split(maxsplit=1)[0] if comment else "float"
            parameters.append({
                "index": index,
                "name": name,
                "kind": kind,
                "unit": annotation_unit(member.annotation),
            })
        parameters.sort(key=lambda parameter: parameter["index"])
        result[node.name] = {
            "name": display_name,
            "category": category,
            "parameters": parameters,
        }
    return result


def git_commit(reference_root: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(reference_root), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def build_catalog(reference_root: Path) -> dict:
    protocol = reference_root / "pyquadcortex" / "protocol"
    params_path = protocol / "params.py"
    models_path = protocol / "models.py"
    params_source = params_path.read_text(encoding="utf-8")
    models_source = models_path.read_text(encoding="utf-8")
    params_tree = ast.parse(params_source, filename=str(params_path))
    models_tree = ast.parse(models_source, filename=str(models_path))

    sets = parameter_sets(params_source, params_tree)
    by_model = literal_dict(assignment(params_tree, "BY_MODEL"))
    model_constants = literal_dict(assignment(models_tree, "ALL"))
    constants_by_id: dict[int, list[str]] = {}
    for qualified_name, model_id in model_constants.items():
        constants_by_id.setdefault(model_id, []).append(qualified_name)

    models = []
    for model_id, set_name in sorted(by_model.items()):
        definition = sets[set_name]
        models.append({
            "id": model_id,
            "name": definition["name"],
            "category": definition["category"],
            "parameterSet": set_name,
            "constants": sorted(constants_by_id.get(model_id, [])),
            "parameters": definition["parameters"],
        })

    kinds = sorted({parameter["kind"] for model in models for parameter in model["parameters"]})
    units = sorted({parameter["unit"] for model in models for parameter in model["parameters"]})
    categories = sorted({model["category"] for model in models})
    unknown_kinds = sorted(set(kinds) - SUPPORTED_KINDS)
    duplicate_indexes = [
        model["id"] for model in models
        if len({parameter["index"] for parameter in model["parameters"]}) != len(model["parameters"])
    ]
    unnamed_parameters = [
        [model["id"], parameter["index"]]
        for model in models for parameter in model["parameters"] if not parameter["name"].strip()
    ]

    return {
        "provenance": {
            "source": "https://github.com/stokes-audio/pyquadcortex",
            "commit": git_commit(reference_root),
            "files": ["pyquadcortex/protocol/models.py", "pyquadcortex/protocol/params.py"],
            "note": "Generated upstream from a Quad Cortex ModelRepo; live device metadata remains authoritative for ranges, steps, and dynamic options.",
        },
        "summary": {
            "modelConstants": len(model_constants),
            "mappedModels": len(models),
            "parameterSets": len(sets),
            "parameters": sum(len(model["parameters"]) for model in models),
            "categories": categories,
            "kinds": kinds,
            "units": units,
        },
        "exceptions": {
            "unknownKinds": unknown_kinds,
            "duplicateParameterIndexes": duplicate_indexes,
            "unnamedParameters": unnamed_parameters,
            "modelsWithoutConstants": [model["id"] for model in models if not model["constants"]],
        },
        "models": models,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("reference_root", type=Path, help="Checkout of stokes-audio/pyquadcortex")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    catalog = build_catalog(args.reference_root.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"summary": catalog["summary"], "exceptions": catalog["exceptions"]}, indent=2))


if __name__ == "__main__":
    main()
