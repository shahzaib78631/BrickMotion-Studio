"""The builder: a decoder transformer over step tokens, steered by a caption's CLIP vector.

Position 0 is the CLIP vector, projected; position t (t >= 1) holds token t-1. The output at position t
predicts token t. Each position also gets the field and step of the token it predicts, so the model
always knows whether it is choosing a part, a connector or an angle, and for which step.
"""
from __future__ import annotations

import sys
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'shape'))
from shape import Block  # noqa: E402

from .sequence import MAX_STEPS, Vocab

N_FIELDS = 10


def target_slots(n: int, device=None) -> tuple[torch.Tensor, torch.Tensor]:
    """Field (0 = BOS, 1..10 = the step's fields) and step of the token at each of n positions.
    EOS falls where the next step's part would, so it is chosen in place of a part."""
    t = torch.arange(n, device=device)
    field = torch.where(t == 0, torch.zeros_like(t), (t - 1) % N_FIELDS + 1)
    step = torch.where(t == 0, torch.zeros_like(t), (t - 1) // N_FIELDS).clamp(max=MAX_STEPS)
    return field, step


class Builder(nn.Module):
    def __init__(self, vocab_size: int, width: int = 512, layers: int = 8, heads: int = 8,
                 max_steps: int = MAX_STEPS, dropout: float = 0.1):
        super().__init__()
        self.config = dict(vocab_size=vocab_size, width=width, layers=layers, heads=heads, max_steps=max_steps,
                           dropout=dropout)
        self.tok = nn.Embedding(vocab_size, width)
        self.field = nn.Embedding(N_FIELDS + 1, width)
        self.step = nn.Embedding(max_steps + 1, width)
        self.clip = nn.Linear(512, width)
        self.blocks = nn.ModuleList([Block(width, heads, True, dropout) for _ in range(layers)])
        self.ln = nn.LayerNorm(width)
        self.head = nn.Linear(width, vocab_size, bias=False)

    def forward(self, clip: torch.Tensor, tokens: torch.Tensor) -> torch.Tensor:
        b, n = tokens.shape
        field, step = target_slots(n, tokens.device)
        x = torch.cat([self.clip(clip.to(self.clip.weight.dtype))[:, None], self.tok(tokens[:, :-1])], 1)
        x = x + self.field(field)[None] + self.step(step)[None]
        for blk in self.blocks:
            x = blk(x)
        return self.head(self.ln(x))

    def loss(self, clip: torch.Tensor, tokens: torch.Tensor) -> torch.Tensor:
        logits = self(clip, tokens)
        return F.cross_entropy(logits.reshape(-1, logits.shape[-1]).float(), tokens.reshape(-1),
                               ignore_index=Vocab.PAD)
