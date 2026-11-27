"""Unified CLI entrypoint: `python -m brickgen <command> [args]`."""
from __future__ import annotations

import sys


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(
            "usage: python -m brickgen <command> [args]\n\n"
            "commands:\n"
            "  build-corpus      extract BrickNet + OMR + MOC + BrickHeadz + BrickLayer MOCs + STB into v3 corpus\n"
            "  train-blueprint   train Stage-1 BlueprintFlow3D (unbiased Rectified Flow Text -> 16^3x5 3D blueprint)\n"
            "  sample-blueprint  sample and preview 3D colored blueprints from Stage-1 checkpoint\n"
            "  train             train Stage-2 BrickGen v3 (3D Blueprint-Conditioned Brick Transformer)\n"
            "  collect-dpo       roll out candidates + libbmcore/CLIP rewards -> dpo_pairs.npz (BrickAnything recipe)\n"
            "  train-dpo         fine-tune BrickGen v3 with Offline Reward-Guided DPO -> brickgen_v3_dpo.pt\n"
            "  generate          generate certified LEGO .ldr model from text, --image-ref, or --blueprint-from-mesh\n"
            "  agent-build       autonomous BrickLayer-Agent (Text/Image -> 100+ part human-grade MOC + visual polish)\n"
            "  showcase          build & certify the 3 BrickLayer-Studio human-grade showcase MOCs\n"
            "  eval              generate & certify a 6-prompt Metal-rendered evaluation gallery\n"
            "  colab-bundle      package compact v3.5 corpus + 2-stage + DPO notebook for Google Colab GPU training"
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
    elif cmd == "collect-dpo":
        from .dpo import collect_main as fn
    elif cmd == "train-dpo":
        from .dpo import train_main as fn
    elif cmd == "generate":
        from .generate import main as fn
    elif cmd == "agent-build":
        from .agent_builder import main as fn
    elif cmd == "showcase":
        from .showcase_mocs import main as fn
    elif cmd == "eval":
        from .eval_gallery import main as fn
    elif cmd == "colab-bundle":
        from .colab_bundle import main as fn
    else:
        raise SystemExit(f"Unknown command: {cmd}")
    fn()


if __name__ == "__main__":
    main()
