"""Unified CLI entrypoint: `python -m brickgen <command> [args]`."""
from __future__ import annotations

import sys


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(
            "usage: python -m brickgen <command> [args]\n\n"
            "commands:\n"
            "  build-corpus      extract BrickNet + OMR + MOC + BrickHeadz + StableText2Brick into v3 corpus\n"
            "  train-blueprint   train Stage-1 BlueprintFlow3D (Text -> 16x16x16x5 colored 3D silhouette)\n"
            "  sample-blueprint  sample and preview 3D colored blueprints from Stage-1 checkpoint\n"
            "  train             train Stage-2 BrickGen v3 (3D Blueprint-Conditioned Brick Transformer)\n"
            "  generate          generate certified 2-stage LEGO .ldr model from a text prompt\n"
            "  eval              generate & certify a 6-prompt Metal-rendered evaluation gallery\n"
            "  colab-bundle      package compact v3 corpus + 2-stage notebook for Google Colab GPU training"
        )
        return
    cmd = sys.argv.pop(1)
    if cmd == "build-corpus":
        from .corpus import main as fn
    elif cmd == "train-blueprint":
        from .train_blueprint import main as fn
    elif cmd == "sample-blueprint":
        from .train_blueprint import sample_blueprint_cli as fn
    elif cmd == "train":
        from .train import main as fn
    elif cmd == "generate":
        from .generate import main as fn
    elif cmd == "eval":
        from .eval_gallery import main as fn
    elif cmd == "colab-bundle":
        from .colab_bundle import main as fn
    else:
        raise SystemExit(f"Unknown command: {cmd}")
    fn()


if __name__ == "__main__":
    main()
