"""固定的窄非线性起点，用于 Tiny CPU 多轮反馈评测。"""

from torch import nn


def build_model():  # type: () -> nn.Sequential
    # 固定单条返回语句，遵守所有候选共用的 AST 审查。
    return nn.Sequential(nn.Linear(2, 2), nn.Tanh(), nn.Linear(2, 2))
