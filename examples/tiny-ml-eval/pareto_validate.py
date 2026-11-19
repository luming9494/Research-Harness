"""WP-06.3 validation: independently reload Full weights and count model parameters."""
import argparse
import json
from pathlib import Path

from common import load_config, load_model, sha256, write_json
from validate_only import validate


def evaluate_full(run: Path) -> dict[str, object]:
    # 先让独立评估器校验权重和候选快照，再从同一受信模型重算参数量。
    result: dict[str, object] = validate(run)
    if result["level"] != "full":
        raise ValueError("Pareto objectives require Full evaluation")
    model_path = run / "candidate"
    model = load_model(model_path, load_config(model_path)["seed"])
    result["parameters"] = sum(parameter.numel() for parameter in model.parameters())
    result["parameter_evaluator_sha256"] = sha256(Path(__file__))
    return result


def main() -> None:
    # 单独的入口保留历史评估器身份，永远只读取 validation。
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        result = evaluate_full(args.run)
        if args.output:
            write_json(args.output, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, RuntimeError, KeyError, TypeError) as error:
        parser.exit(1, f"Pareto validation failed: {error}\n")


if __name__ == "__main__":
    main()
