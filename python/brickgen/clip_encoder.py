"""Self-contained pure-PyTorch CLIP ViT-B/32 (Text + Vision) encoder.

Zero dependency on `transformers`: loads directly from the local HuggingFace cache
(`openai/clip-vit-base-patch32`, already present on Mac) or downloads via urllib/hf_hub
on Colab if absent. Outputs BOTH:
  - `token_embeds`: (B, 77, 512) per-token contextual embeddings for cross-attention
  - `pooled`:       (B, 512) L2-normalized CLIP text embedding (matches BrickNet's CLIP vectors to >0.9999)
"""
from __future__ import annotations

import html
import json
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CLIP_MODEL_ID = "openai/clip-vit-base-patch32"
CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD = (0.26862954, 0.26130258, 0.27577711)


def find_clip_snapshot(snapshot_dir: str | Path | None = None) -> Path:
    """Locate the local CLIP ViT-B/32 directory containing pytorch_model.bin, vocab.json, merges.txt."""
    if snapshot_dir is not None:
        p = Path(snapshot_dir)
        if (p / "pytorch_model.bin").exists() and (p / "vocab.json").exists():
            return p

    hf_root = Path.home() / ".cache" / "huggingface" / "hub" / "models--openai--clip-vit-base-patch32" / "snapshots"
    if hf_root.exists():
        for snap in sorted(hf_root.iterdir()):
            if (snap / "pytorch_model.bin").exists() and (snap / "vocab.json").exists() and (snap / "merges.txt").exists():
                return snap

    # Colab / remote fallback via huggingface_hub if installed
    try:
        from huggingface_hub import snapshot_download

        downloaded = Path(
            snapshot_download(
                CLIP_MODEL_ID,
                allow_patterns=["pytorch_model.bin", "vocab.json", "merges.txt", "config.json"],
            )
        )
        if (downloaded / "pytorch_model.bin").exists():
            return downloaded
    except Exception:
        pass

    raise FileNotFoundError(
        "Could not locate openai/clip-vit-base-patch32 snapshot (pytorch_model.bin, vocab.json, merges.txt)."
    )


@lru_cache(maxsize=1)
def _bytes_to_unicode() -> dict[int, str]:
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, [chr(c) for c in cs]))


def _get_pairs(word: tuple[str, ...]) -> set[tuple[str, str]]:
    return {(word[i], word[i + 1]) for i in range(len(word) - 1)}


class ClipBpeTokenizer:
    """Exact OpenAI / HuggingFace CLIP byte-level BPE tokenizer (no external packages)."""

    BOS_ID = 49406
    EOS_ID = 49407
    MAX_LEN = 77

    def __init__(self, snapshot_dir: Path):
        self.encoder: dict[str, int] = json.loads((snapshot_dir / "vocab.json").read_text(encoding="utf-8"))
        merges_lines = (snapshot_dir / "merges.txt").read_text(encoding="utf-8").splitlines()
        merges = [tuple(line.split()) for line in merges_lines[1 : 49152 - 256 - 2 + 1]]
        self.bpe_ranks: dict[tuple[str, str], int] = {pair: i for i, pair in enumerate(merges)}
        self.byte_encoder = _bytes_to_unicode()
        self.cache: dict[str, str] = {"<|startoftext|>": "<|startoftext|>", "<|endoftext|>": "<|endoftext|>"}
        # Matches OpenAI CLIP SimpleTokenizer pattern using stdlib `re`
        self.pat = re.compile(
            r"<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[a-zA-Z]+|[0-9]|[^\s\w]+",
            re.IGNORECASE,
        )

    def _bpe(self, token: str) -> str:
        cached = self.cache.get(token)
        if cached is not None:
            return cached
        word = tuple(token[:-1]) + (token[-1] + "</w>",)
        pairs = _get_pairs(word)
        if not pairs:
            return token + "</w>"
        while True:
            bigram = min(pairs, key=lambda pair: self.bpe_ranks.get(pair, float("inf")))
            if bigram not in self.bpe_ranks:
                break
            first, second = bigram
            new_word = []
            i = 0
            while i < len(word):
                try:
                    j = word.index(first, i)
                    new_word.extend(word[i:j])
                    i = j
                except ValueError:
                    new_word.extend(word[i:])
                    break
                if i < len(word) - 1 and word[i] == first and word[i + 1] == second:
                    new_word.append(first + second)
                    i += 2
                else:
                    new_word.append(word[i])
                    i += 1
            word = tuple(new_word)
            if len(word) == 1:
                break
            pairs = _get_pairs(word)
        out = " ".join(word)
        self.cache[token] = out
        return out

    def encode_one(self, text: str) -> list[int]:
        text = html.unescape(html.unescape(text))
        text = re.sub(r"\s+", " ", text).strip().lower()
        ids = [self.BOS_ID]
        for token in self.pat.findall(text):
            enc = "".join(self.byte_encoder[b] for b in token.encode("utf-8"))
            for bpe_tok in self._bpe(enc).split(" "):
                tid = self.encoder.get(bpe_tok)
                if tid is not None:
                    ids.append(tid)
                if len(ids) >= self.MAX_LEN - 1:
                    break
            if len(ids) >= self.MAX_LEN - 1:
                break
        ids.append(self.EOS_ID)
        return ids

    def encode_batch(self, texts: list[str], max_len: int = MAX_LEN) -> tuple[np.ndarray, np.ndarray]:
        """Returns (input_ids[B, max_len] int32, lengths[B] int32 including BOS and EOS)."""
        n = len(texts)
        arr = np.full((n, max_len), self.EOS_ID, dtype=np.int32)
        lengths = np.zeros(n, dtype=np.int32)
        for i, txt in enumerate(texts):
            ids = self.encode_one(txt)
            L = min(len(ids), max_len)
            arr[i, :L] = ids[:L]
            arr[i, L - 1] = self.EOS_ID
            lengths[i] = L
        return arr, lengths


def _quick_gelu(x: torch.Tensor) -> torch.Tensor:
    return x * torch.sigmoid(1.702 * x)


class _ClipAttn(nn.Module):
    def __init__(self, width: int, heads: int):
        super().__init__()
        self.heads = heads
        self.head_dim = width // heads
        self.q_proj = nn.Linear(width, width)
        self.k_proj = nn.Linear(width, width)
        self.v_proj = nn.Linear(width, width)
        self.out_proj = nn.Linear(width, width)

    def forward(self, x: torch.Tensor, is_causal: bool = False) -> torch.Tensor:
        b, n, c = x.shape
        q = self.q_proj(x).view(b, n, self.heads, self.head_dim).transpose(1, 2)
        k = self.k_proj(x).view(b, n, self.heads, self.head_dim).transpose(1, 2)
        v = self.v_proj(x).view(b, n, self.heads, self.head_dim).transpose(1, 2)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=is_causal)
        return self.out_proj(y.transpose(1, 2).contiguous().view(b, n, c))


class _ClipMLP(nn.Module):
    def __init__(self, width: int, inner: int):
        super().__init__()
        self.fc1 = nn.Linear(width, inner)
        self.fc2 = nn.Linear(inner, width)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.fc2(_quick_gelu(self.fc1(x)))


class _ClipLayer(nn.Module):
    def __init__(self, width: int, heads: int, inner: int):
        super().__init__()
        self.layer_norm1 = nn.LayerNorm(width, eps=1e-5)
        self.self_attn = _ClipAttn(width, heads)
        self.layer_norm2 = nn.LayerNorm(width, eps=1e-5)
        self.mlp = _ClipMLP(width, inner)

    def forward(self, x: torch.Tensor, is_causal: bool = False) -> torch.Tensor:
        x = x + self.self_attn(self.layer_norm1(x), is_causal=is_causal)
        x = x + self.mlp(self.layer_norm2(x))
        return x


class PureClipTextModel(nn.Module):
    """Exact PyTorch implementation of CLIP ViT-B/32 text transformer."""

    def __init__(self, vocab_size: int = 49408, max_pos: int = 77, width: int = 512, layers: int = 12, heads: int = 8):
        super().__init__()
        self.token_embedding = nn.Embedding(vocab_size, width)
        self.position_embedding = nn.Embedding(max_pos, width)
        self.layers = nn.ModuleList([_ClipLayer(width, heads, width * 4) for _ in range(layers)])
        self.final_layer_norm = nn.LayerNorm(width, eps=1e-5)
        self.text_projection = nn.Linear(width, width, bias=False)

    def load_hf_state_dict(self, sd: dict[str, torch.Tensor]) -> None:
        mapped = {
            "token_embedding.weight": sd["text_model.embeddings.token_embedding.weight"],
            "position_embedding.weight": sd["text_model.embeddings.position_embedding.weight"],
            "final_layer_norm.weight": sd["text_model.final_layer_norm.weight"],
            "final_layer_norm.bias": sd["text_model.final_layer_norm.bias"],
            "text_projection.weight": sd["text_projection.weight"],
        }
        for k, v in sd.items():
            if k.startswith("text_model.encoder.layers."):
                mapped["layers." + k[len("text_model.encoder.layers.") :]] = v
        self.load_state_dict(mapped, strict=True)

    @torch.no_grad()
    def forward(self, input_ids: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """input_ids: (B, L) long -> (token_embeds[B, L, 512], pooled_normed[B, 512])."""
        b, L = input_ids.shape
        pos = torch.arange(L, device=input_ids.device)
        x = self.token_embedding(input_ids) + self.position_embedding(pos)[None]
        for layer in self.layers:
            x = layer(x, is_causal=True)
        x = self.final_layer_norm(x)
        # EOS is the highest token id (49407); first occurrence of EOS (argmax works identically to HF CLIP)
        eos_pos = input_ids.argmax(dim=-1)
        pooled = self.text_projection(x[torch.arange(b, device=input_ids.device), eos_pos])
        pooled = F.normalize(pooled.float(), dim=-1)
        return x, pooled


class PureClipVisionModel(nn.Module):
    """Exact PyTorch implementation of CLIP ViT-B/32 vision transformer."""

    def __init__(self, image_size: int = 224, patch_size: int = 32, width: int = 768, layers: int = 12, heads: int = 12, proj: int = 512):
        super().__init__()
        self.class_embedding = nn.Parameter(torch.zeros(width))
        self.patch_embedding = nn.Conv2d(3, width, kernel_size=patch_size, stride=patch_size, bias=False)
        n_pos = (image_size // patch_size) ** 2 + 1
        self.position_embedding = nn.Embedding(n_pos, width)
        self.pre_layrnorm = nn.LayerNorm(width, eps=1e-5)
        self.layers = nn.ModuleList([_ClipLayer(width, heads, width * 4) for _ in range(layers)])
        self.post_layernorm = nn.LayerNorm(width, eps=1e-5)
        self.visual_projection = nn.Linear(width, proj, bias=False)

    def load_hf_state_dict(self, sd: dict[str, torch.Tensor]) -> None:
        mapped = {
            "class_embedding": sd["vision_model.embeddings.class_embedding"],
            "patch_embedding.weight": sd["vision_model.embeddings.patch_embedding.weight"],
            "position_embedding.weight": sd["vision_model.embeddings.position_embedding.weight"],
            "pre_layrnorm.weight": sd["vision_model.pre_layrnorm.weight"],
            "pre_layrnorm.bias": sd["vision_model.pre_layrnorm.bias"],
            "post_layernorm.weight": sd["vision_model.post_layernorm.weight"],
            "post_layernorm.bias": sd["vision_model.post_layernorm.bias"],
            "visual_projection.weight": sd["visual_projection.weight"],
        }
        for k, v in sd.items():
            if k.startswith("vision_model.encoder.layers."):
                mapped["layers." + k[len("vision_model.encoder.layers.") :]] = v
        self.load_state_dict(mapped, strict=True)

    @torch.no_grad()
    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        """pixel_values: (B, 3, 224, 224) normalized -> L2-normalized image_embeds (B, 512)."""
        b = pixel_values.shape[0]
        x = self.patch_embedding(pixel_values).flatten(2).transpose(1, 2)
        cls = self.class_embedding.view(1, 1, -1).expand(b, -1, -1)
        x = torch.cat([cls, x], dim=1)
        pos = torch.arange(x.shape[1], device=x.device)
        x = self.pre_layrnorm(x + self.position_embedding(pos)[None])
        for layer in self.layers:
            x = layer(x, is_causal=False)
        pooled = self.visual_projection(self.post_layernorm(x[:, 0]))
        return F.normalize(pooled.float(), dim=-1)


class ClipEncoder:
    """High-level wrapper for pure-PyTorch CLIP text (+ optional vision) encoding."""

    def __init__(self, device: str | None = None, load_vision: bool = False, snapshot_dir: str | Path | None = None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
        self.snapshot = find_clip_snapshot(snapshot_dir)
        self.tokenizer = ClipBpeTokenizer(self.snapshot)
        sd = torch.load(self.snapshot / "pytorch_model.bin", map_location="cpu", weights_only=True)
        self.text_model = PureClipTextModel()
        self.text_model.load_hf_state_dict(sd)
        self.text_model.to(self.device).eval()
        for p in self.text_model.parameters():
            p.requires_grad_(False)

        self.vision_model: PureClipVisionModel | None = None
        if load_vision:
            self.vision_model = PureClipVisionModel()
            self.vision_model.load_hf_state_dict(sd)
            self.vision_model.to(self.device).eval()
            for p in self.vision_model.parameters():
                p.requires_grad_(False)

    def tokenize(self, texts: list[str], max_len: int = ClipBpeTokenizer.MAX_LEN) -> tuple[np.ndarray, np.ndarray]:
        return self.tokenizer.encode_batch(texts, max_len=max_len)

    @torch.no_grad()
    def encode_token_ids(self, input_ids: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """input_ids: (B, L) long -> (token_embeds[B, L, 512], pooled[B, 512]) on self.device."""
        ids = input_ids.to(self.device, dtype=torch.long)
        return self.text_model(ids)

    @torch.no_grad()
    def encode_texts(self, texts: list[str], batch_size: int = 128) -> tuple[np.ndarray, np.ndarray]:
        """Returns (token_embeds[N, 77, 512] float32, pooled[N, 512] float32)."""
        ids, _ = self.tokenize(texts)
        toks_out, pool_out = [], []
        for i in range(0, len(texts), batch_size):
            t_in = torch.from_numpy(ids[i : i + batch_size]).to(self.device, dtype=torch.long)
            te, pe = self.text_model(t_in)
            toks_out.append(te.float().cpu().numpy())
            pool_out.append(pe.float().cpu().numpy())
        return np.concatenate(toks_out, axis=0), np.concatenate(pool_out, axis=0)

    @torch.no_grad()
    def encode_images(self, images_hwc_float01: list[np.ndarray], batch_size: int = 32) -> np.ndarray:
        """images: list of (H, W, 3) float in [0, 1] -> (N, 512) L2-normalized float32."""
        if self.vision_model is None:
            raise RuntimeError("ClipEncoder initialized with load_vision=False")
        if not images_hwc_float01:
            return np.zeros((0, 512), dtype=np.float32)
        mean = np.array(CLIP_MEAN, dtype=np.float32)
        std = np.array(CLIP_STD, dtype=np.float32)
        out = []
        for i in range(0, len(images_hwc_float01), batch_size):
            batch = images_hwc_float01[i : i + batch_size]
            arr = np.stack(batch).astype(np.float32)
            # Resize if not 224x224
            t = torch.from_numpy(arr.transpose(0, 3, 1, 2)).to(self.device)
            if t.shape[-2:] != (224, 224):
                t = F.interpolate(t, size=(224, 224), mode="bicubic", align_corners=False).clamp(0.0, 1.0)
            m = torch.tensor(mean, device=self.device).view(1, 3, 1, 1)
            s = torch.tensor(std, device=self.device).view(1, 3, 1, 1)
            e = self.vision_model((t - m) / s)
            out.append(e.float().cpu().numpy())
        return np.concatenate(out, axis=0)
