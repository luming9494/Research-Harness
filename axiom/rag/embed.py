"""宿主离线编码冻结 SciFact 输入，输出可独立核验的文档与查询矩阵。"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import resource
import struct
from time import perf_counter
from typing import Literal, TypedDict

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL = "BAAI/bge-small-en-v1.5"
REVISION = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"
WEIGHTS = "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35"
TOKENIZER = "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66"
SOURCES = {
    "corpus.jsonl": "b8d6c89624cb2ed74dee8938effc4f5d8bd2086887880af8110d64be4ceade62",
    "claims_train.jsonl": "f4c8fa82d8bd0653a9cc8d61a6ea48c25eacea64e90af5dbf390ebb1b74372f0",
    "claims_dev.jsonl": "86f0435d08fdb65d1aa41d1472684f57e6e71930626497bdf4d7a9ec1a632217",
}
PREFIX = "Represent this sentence for searching relevant passages: "
DIMENSIONS = 384
Split = Literal["development", "holdout"]


class Matrix(TypedDict):
    sha256: str
    source_sha256: str
    rows: int
    encode_ms: float
    peak_rss_kib: int


def digest(path: Path) -> str:
    """流式验证大权重，避免额外保留一份模型。"""
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked(path: Path, expected: str) -> None:
    """权重、分词器、语料和已持久化缓存都按原始字节核对。"""
    if digest(path) != expected:
        raise ValueError(f"Digest mismatch: {path.name}")


def rows(path: Path, documents: bool) -> list[tuple[int, str]]:
    """只向编码器投影文档 ID 和文本，不读取相关性标签。"""
    checked(path, SOURCES[path.name])
    result: list[tuple[int, str]] = []
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            if documents:
                result.append((row["doc_id"], " ".join([row.get("title", ""), *row.get("abstract", [])]).strip()))
            else:
                result.append((row["id"], PREFIX + row["claim"]))
    return result


def encode(
    inputs: list[tuple[int, str]], output: Path, tokenizer: Tokenizer, session: ort.InferenceSession, source: str
) -> Matrix:
    """对官方 BGE ONNX 使用首词元池化与 L2 归一化。"""
    names = {item.name for item in session.get_inputs()}
    started = perf_counter()
    temp = output.with_suffix(".tmp")
    with temp.open("wb") as stream:
        for start in range(0, len(inputs), 8):
            batch = inputs[start:start + 8]
            tokens = tokenizer.encode_batch([text for _, text in batch])
            candidates = {
                "input_ids": [item.ids for item in tokens],
                "attention_mask": [item.attention_mask for item in tokens],
                "token_type_ids": [item.type_ids for item in tokens],
            }
            hidden = session.run(None, {name: np.asarray(candidates[name], dtype=np.int64) for name in names})[0]
            vectors = hidden[:, 0, :]
            norms = np.linalg.norm(vectors, axis=1, keepdims=True)
            if vectors.shape != (len(batch), DIMENSIONS) or not np.isfinite(vectors).all() or np.any(norms <= 0):
                raise ValueError("Invalid BGE output")
            for (identity, _), vector in zip(batch, vectors / norms, strict=True):
                stream.write(struct.pack("<i", identity))
                stream.write(vector.astype("<f4").tobytes())
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(output)
    return {
        "sha256": digest(output), "source_sha256": source, "rows": len(inputs),
        "encode_ms": (perf_counter() - started) * 1000, "peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    }


def write_json(path: Path, value: object) -> None:
    """在所有矩阵写完后原子发布收据，缺少收据的矩阵不能复用。"""
    temp = path.with_suffix(".tmp")
    with temp.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, separators=(",", ":"), allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)


def prepare(data: Path, model: Path, output: Path, split: Split) -> str:
    """对同一目录串行编码，留出分片由宿主在交付之后单独运行。"""
    checked(model / "model.onnx", WEIGHTS)
    checked(model / "tokenizer.json", TOKENIZER)
    output.mkdir(parents=True, exist_ok=True)
    corpus_receipt = output / "documents.json"
    manifest = output / f"{split}.json"
    claim = "claims_train.jsonl" if split == "development" else "claims_dev.jsonl"
    identity = {
        "version": 1, "model": MODEL, "revision": REVISION, "weights_sha256": WEIGHTS,
        "tokenizer_sha256": TOKENIZER, "dimensions": DIMENSIONS, "max_tokens": 256,
        "encoder": "bge-cls-l2-onnx-cpu-v1", "ort": ort.__version__,
    }
    with (output / "encode.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for filename in ("corpus.jsonl", claim):
            checked(data / filename, SOURCES[filename])
        if manifest.exists():
            saved = json.loads(manifest.read_text(encoding="utf-8"))
            if saved["identity"] != identity or saved["queries"]["source_sha256"] != SOURCES[claim] or saved["documents"]["source_sha256"] != SOURCES["corpus.jsonl"]:
                raise ValueError("Incompatible existing vector manifest")
            checked(output / "documents.f32", saved["documents"]["sha256"])
            checked(output / f"{split}.f32", saved["queries"]["sha256"])
            return digest(manifest)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(str(model / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
        tokenizer = Tokenizer.from_file(str(model / "tokenizer.json"))
        tokenizer.enable_truncation(max_length=256)
        tokenizer.enable_padding()
        if corpus_receipt.exists():
            saved = json.loads(corpus_receipt.read_text(encoding="utf-8"))
            documents: Matrix = saved["matrix"]
            if saved["identity"] != identity or documents["source_sha256"] != SOURCES["corpus.jsonl"]:
                raise ValueError("Incompatible document embedding cache")
            checked(output / "documents.f32", documents["sha256"])
        else:
            documents = encode(rows(data / "corpus.jsonl", True), output / "documents.f32", tokenizer, session, SOURCES["corpus.jsonl"])
            write_json(corpus_receipt, {"identity": identity, "matrix": documents})
        queries = encode(rows(data / claim, False), output / f"{split}.f32", tokenizer, session, SOURCES[claim])
        write_json(manifest, {"identity": identity, "split": split, "documents": documents, "queries": queries})
        return digest(manifest)


def main() -> None:
    """入口只供受信宿主使用，Pi 工具没有子进程或文件访问能力。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--split", required=True, choices=["development", "holdout"])
    args = parser.parse_args()
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    print(prepare(args.data, args.model, args.out, args.split))


if __name__ == "__main__":
    main()
