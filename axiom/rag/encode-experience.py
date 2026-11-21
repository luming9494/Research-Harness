"""复用 WP-10.2 已固定的 BGE 模型与编码流程，仅编码小规模经验批次。"""
import argparse
import base64
import json
import struct
import tempfile
from pathlib import Path

import onnxruntime as ort
from tokenizers import Tokenizer

from embed import DIMENSIONS, PREFIX, TOKENIZER, WEIGHTS, checked, encode


def main() -> None:
    """拒绝超长批次，区分查询指令和文档文本。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--texts", required=True)
    parser.add_argument("--query", action="store_true")
    args = parser.parse_args()
    texts = json.loads(base64.b64decode(args.texts, validate=True))
    if not isinstance(texts, list) or not 1 <= len(texts) <= 16 or any(
        not isinstance(text, str) or not 1 <= len(text) <= 400 for text in texts
    ):
        raise ValueError("Invalid bounded embedding input")
    checked(args.model / "model.onnx", WEIGHTS)
    checked(args.model / "tokenizer.json", TOKENIZER)
    tokenizer = Tokenizer.from_file(str(args.model / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=256)
    tokenizer.enable_padding()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(args.model / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
    with tempfile.TemporaryDirectory(prefix="axiom-memory-") as temp:
        vectors = Path(temp) / "memory.f32"
        prefix = PREFIX if args.query else ""
        encode([(i, prefix + text) for i, text in enumerate(texts)], vectors, tokenizer, session, WEIGHTS)
        print(json.dumps([row[1:] for row in struct.iter_unpack(f"<i{DIMENSIONS}f", vectors.read_bytes())], allow_nan=False))


if __name__ == "__main__":
    main()
