"""The BrickNet half of the remix index: every captioned BrickNet model as an LDraw file, and
its CLIP text embedding (the mean of its five captions), in the layout src/ai/remix.ts reads.

    python -I remix_index.py DATA_DIR MODELS_OUT INDEX_OUT

DATA_DIR: sft.npz, captions_sft.jsonl and the catalog (see decode.py). Writes MODELS_OUT/sft_NNNNN.ldr
(skipping files already there) and INDEX_OUT/bricknet_index.{json,bin}. The bin has no render
views (views = 0): BrickNet ships no images, so these models are found by their captions alone.
"""
from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))  # decode.py, next to this file
import decode  # noqa: E402

CUT = re.compile(r'\s(featuring|with|that|which|consisting|composed|constructed|built|made|designed|set|in a|on a|against)\s|[.;:(]', re.I)
INTRO = re.compile(r'^.*\b(of|depicts|depicting|represents|representing|shows|showing|is|as)\s+(an?|the)\s+', re.I)
NOISE = re.compile(r'\b(lego|model|3d-rendered|rendered|3d|moc)\b', re.I)


def short_name(caption: str) -> str:
    """'This LEGO model depicts a pirate minifigure with a yellow head, …' -> 'Pirate minifigure'."""
    s = CUT.split(caption.strip(), maxsplit=1)[0]
    s = INTRO.sub('', s)
    s = re.sub(r'^(this|the)\s+(is\s+)?(an?\s+)?', '', s, flags=re.I)
    s = NOISE.sub(' ', s).replace(',', ' ')
    words = s.split()
    s = ' '.join(words[-7:]) if words else 'BrickNet model'
    return s[:1].upper() + s[1:]


def embed(captions: list[str], cache: Path) -> np.ndarray:
    import torch
    from transformers import CLIPTextModelWithProjection, CLIPTokenizerFast
    if cache.exists():
        return np.load(cache)
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
    tok = CLIPTokenizerFast.from_pretrained('openai/clip-vit-base-patch32')
    model = CLIPTextModelWithProjection.from_pretrained('openai/clip-vit-base-patch32').to(dev).half().eval()
    out = []
    with torch.no_grad():
        for s in range(0, len(captions), 256):
            b = tok(captions[s:s + 256], padding=True, truncation=True, max_length=77, return_tensors='pt').to(dev)
            e = model(**b).text_embeds.float()
            out.append((e / e.norm(dim=-1, keepdim=True)).cpu().numpy())
            if s % (256 * 40) == 0:
                print(f'::progress {s}/{len(captions)} captions embedded', flush=True)
    e = np.concatenate(out).astype(np.float32)
    np.save(cache, e)
    return e


def main() -> None:
    d, models, out = (Path(a) for a in sys.argv[1:4])
    arrs = decode.load(d / 'sft.npz')
    n = len(arrs['node_ptr']) - 1
    caps = [json.loads(l)['caption'] for l in (d / 'captions_sft.jsonl').read_text().splitlines() if l.strip()]
    assert len(caps) == 5 * n, f'{len(caps)} captions for {n} models'
    cat = decode.Catalog(d)
    models.mkdir(parents=True, exist_ok=True)
    rows = []
    for i in range(n):
        f = models / f'sft_{i:05d}.ldr'
        pids, colors, edges = decode.model(arrs, i)
        if f.exists():
            kept = sum(1 for l in f.read_text().splitlines() if l.startswith('1 '))
        else:
            order, poses = decode.realise(cat, pids, edges)
            f.write_text(decode.to_ldr(cat, pids, colors, order, poses, short_name(caps[5 * i]), caps[5 * i]))
            kept = len(order)
        # only what differs per model: the app fills in the rest (src/ai/remix.ts)
        rows.append({'name': short_name(caps[5 * i]), 'file': f.name, 'pieces': kept})
        if i % 2000 == 0:
            print(f'::progress {i}/{n} models decoded', flush=True)
    e = embed(caps, d / 'captions_sft_clip.npy').reshape(n, 5, 512).mean(1)
    e /= np.linalg.norm(e, axis=1, keepdims=True)
    scale = np.abs(e).max(-1, keepdims=True) / 127 + 1e-12
    t8 = np.round(e / scale).astype(np.int8)
    out.mkdir(parents=True, exist_ok=True)
    with (out / 'bricknet_index.bin').open('wb') as fh:
        fh.write(struct.pack('<IIII', n, n, 0, 512))
        fh.write(np.arange(n, dtype=np.int32).tobytes())
        fh.write(scale[:, 0].astype(np.float32).tobytes())
        fh.write(t8.tobytes())
    (out / 'bricknet_index.json').write_text(json.dumps(rows, separators=(',', ':')))
    print(f'{n} BrickNet models -> {models}, index -> {out}', flush=True)


if __name__ == '__main__':
    main()
