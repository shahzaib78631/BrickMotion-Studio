"""Python side of scripts/lab-oracle.ts: asks the editor's own collision world whether a part overlaps."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]


def _m(pose: np.ndarray) -> list[float]:
    return [float(v) for v in np.asarray(pose, dtype=float).T.reshape(-1)]  # column-major


class Oracle:
    def __init__(self):
        self.p = subprocess.Popen(['npx', 'tsx', 'scripts/lab-oracle.ts'], cwd=REPO, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        ready = json.loads(self.p.stdout.readline())
        assert ready.get('ready'), ready

    def _ask(self, msg: dict) -> dict:
        self.p.stdin.write(json.dumps(msg) + '\n')
        out = json.loads(self.p.stdout.readline())
        if 'error' in out:
            raise RuntimeError(out['error'])
        return out

    def reset(self) -> None:
        self._ask({'op': 'reset'})

    def add(self, stem: str, pose: np.ndarray) -> bool:
        return bool(self._ask({'op': 'add', 'part': stem, 'm': _m(pose)})['known'])

    def hits(self, stem: str, pose: np.ndarray) -> bool:
        return bool(self._ask({'op': 'hits', 'part': stem, 'm': _m(pose)})['hit'])

    def hits_many(self, stem: str, poses: list[np.ndarray]) -> list[bool]:
        return self._ask({'op': 'hitsMany', 'part': stem, 'ms': [_m(p) for p in poses]})['hits']

    def close(self) -> None:
        if self.p.poll() is None:
            self.p.stdin.close()
            self.p.wait(timeout=10)
