"""Fixed CUDA Tiny workload. Independent validation runs on the operator host."""

import argparse
import os
import shutil
import time
from pathlib import Path

import torch
from torch import nn

from common import PROTOCOL, configure_cpu, dataset, load_config, load_model, sha256, write_json
from review_candidate import review_source


def train(candidate: Path, output: Path, level: str) -> None:
    """保留独立评分器既有的 Tiny 工件合同，只将训练步骤放到 CUDA。"""
    started = time.perf_counter()
    config = load_config(candidate)
    review_source((candidate / "model.py").read_text(encoding="utf-8"))
    output.mkdir()
    snapshot = output / "candidate"
    snapshot.mkdir()
    for name in ("model.py", "config.json"):
        shutil.copyfile(candidate / name, snapshot / name)
    model = load_model(snapshot, config["seed"]).cuda()
    x, y = dataset("train")
    epochs = config["epochs"]
    if level == "smoke":
        x, y, epochs = x[:16], y[:16], 2
    x, y = x.cuda(), y.cuda()
    optimizer = torch.optim.Adam(model.parameters(), lr=config["learning_rate"])
    objective = nn.CrossEntropyLoss()
    history: list[dict[str, float | int]] = []
    for epoch in range(epochs):
        optimizer.zero_grad()
        loss = objective(model(x), y)
        if not torch.isfinite(loss):
            raise ValueError("Nonfinite GPU loss")
        loss.backward()
        if any(parameter.grad is not None and not torch.isfinite(parameter.grad).all() for parameter in model.parameters()):
            raise ValueError("Nonfinite GPU gradient")
        optimizer.step()
        history.append({"epoch": epoch + 1, "loss": float(loss.detach())})
    checkpoint = output / "checkpoint.pt"
    torch.save({name: value.detach().cpu() for name, value in model.state_dict().items()}, checkpoint)
    trusted = Path(__file__).parent
    write_json(output / "history.json", history)
    # 记录 CUDA 工作负载身份，宿主仍需验证已批准候选、环境和模型权重。
    write_json(output / "run.json", {
        "schema_version": 1, "protocol": PROTOCOL, "status": "trained",
        "level": level, "config": config, "epochs_executed": epochs, "train_samples": len(y),
        "candidate_sha256": {name: sha256(snapshot / name) for name in ("model.py", "config.json")},
        "checkpoint_sha256": sha256(checkpoint), "evaluator_sha256": {
            name: sha256(trusted / name) for name in ("task.json", "common.py", "train.py", "evaluate.py", "judge.py")
        },
        "workload_sha256": sha256(Path(__file__)), "torch_version": str(torch.__version__), "device": "cuda",
        "gpu_name": torch.cuda.get_device_name(0), "gpu_vram_bytes": torch.cuda.get_device_properties(0).total_memory,
        "wall_seconds": time.perf_counter() - started,
    })


def main() -> None:
    """没有获批的 GPU 或足量显存时退出，禁止改走 CPU。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--smoke-output", type=Path)
    parser.add_argument("--min-vram-mib", required=True, type=int)
    args = parser.parse_args()
    # cuBLAS 确定性作业需要在首次 CUDA 运算前设置工作区。
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    configure_cpu()
    if torch.cuda.device_count() != 1:
        parser.exit(1, "Expected exactly one allocated CUDA device\n")
    if torch.cuda.get_device_properties(0).total_memory < args.min_vram_mib * 1024**2:
        parser.exit(1, "Allocated CUDA device has insufficient VRAM\n")
    if args.smoke_output:
        train(args.candidate, args.smoke_output, "smoke")
    train(args.candidate, args.output, "full")
    print("AXIOM_TINY_GPU_TRAIN_COMPLETED")


if __name__ == "__main__":
    main()
