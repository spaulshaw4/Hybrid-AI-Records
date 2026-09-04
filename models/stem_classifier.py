"""Residual CNN stem classifier for the five locked DSP bus classes.

Classes (label_id): acoustic=0, voice=1, electric=2, beats=3, bass=4.

Input tensor shape: ``(batch, 1, 128 mel bins, time steps)``.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F


class ConvBlock(nn.Module):
    def __init__(self, in_channels: int, out_channels: int):
        super().__init__()
        self.conv1 = nn.Conv2d(
            in_channels,
            out_channels,
            kernel_size=3,
            stride=1,
            padding=1,
            bias=False,
        )
        self.bn1 = nn.BatchNorm2d(out_channels)
        self.conv2 = nn.Conv2d(
            out_channels,
            out_channels,
            kernel_size=3,
            stride=1,
            padding=1,
            bias=False,
        )
        self.bn2 = nn.BatchNorm2d(out_channels)
        self.pool = nn.MaxPool2d(kernel_size=2, stride=2)
        self.residual = nn.Conv2d(
            in_channels, out_channels, kernel_size=1, stride=1, bias=False
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        res = self.residual(x)
        out = F.gelu(self.bn1(self.conv1(x)))
        out = self.bn2(self.conv2(out))
        out = F.gelu(out + res)
        return self.pool(out)


class AudioStemClassifier(nn.Module):
    def __init__(self, num_classes: int = 5):
        super().__init__()
        self.layer1 = ConvBlock(1, 32)
        self.layer2 = ConvBlock(32, 64)
        self.layer3 = ConvBlock(64, 128)
        self.layer4 = ConvBlock(128, 256)
        self.global_pool = nn.AdaptiveAvgPool2d((1, 1))
        self.head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(256, 128),
            nn.GELU(),
            nn.Dropout(0.30),
            nn.Linear(128, num_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.layer1(x)
        x = self.layer2(x)
        x = self.layer3(x)
        x = self.layer4(x)
        x = self.global_pool(x)
        return self.head(x)


def get_loss_and_optimizer(
    model: nn.Module,
    lr: float = 1e-3,
    weight_decay: float = 1e-4,
):
    criterion = nn.CrossEntropyLoss(label_smoothing=0.10)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=lr, weight_decay=weight_decay
    )
    return criterion, optimizer
