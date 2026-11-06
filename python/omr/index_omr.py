"""Index the LDraw Official Model Repository (OMR): set number, name and model file links.

The OMR (library.ldraw.org/omr) hosts LDraw replicas of official LEGO sets under
CC BY 2.0 / 4.0 (see each file's !LICENSE line). It has no bulk download, so this walks
the set pages one by one, politely (one request per --delay seconds), and writes one
JSON line per set. It resumes: sets already in the output are skipped.

    python -m omr.index_omr OUT.jsonl [--start 1] [--stop 6000] [--delay 0.6]
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = 'https://library.ldraw.org'
UA = 'BrickMotion-Studio dataset indexer (polite, 1 req/s)'


def fetch(url: str, tries: int = 3) -> str | None:
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 * (k + 1))
        except Exception:
            time.sleep(2 * (k + 1))
    return None


def parse(page: str, set_id: int) -> dict | None:
    title = re.search(r'<title>LDraw\.org Official Model Repository - (.*?) \| LDraw', page)
    if not title:
        return None
    files = sorted(set(re.findall(r'https://library\.ldraw\.org/media/omr_models/\d+/[^"\'<>\s?]+\.(?:mpd|ldr)', page)))
    text = html.unescape(re.sub(r'<[^>]+>', '\n', re.sub(r'<(script|style)[\s\S]*?</\1>', '', page)))
    number = None
    for line in text.split('\n'):
        m = re.match(r'\s*(\d{3,7}-\d+) - ', line)
        if m:
            number = m.group(1)
            break
    if number is None and files:
        m = re.search(r'/(\d{3,7}-\d+)[_-]', files[0])
        number = m.group(1) if m else None
    return {'id': set_id, 'number': number, 'name': html.unescape(title.group(1)), 'files': files}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--start', type=int, default=1)
    ap.add_argument('--stop', type=int, default=6000)
    ap.add_argument('--delay', type=float, default=0.6)
    a = ap.parse_args()
    out = Path(a.out)
    done = set()
    if out.exists():
        for line in out.read_text().splitlines():
            try:
                done.add(json.loads(line)['id'])
            except Exception:
                pass
    misses = 0
    total = a.stop - a.start + 1
    with out.open('a') as f:
        for i in range(a.start, a.stop + 1):
            print(f'::progress {i - a.start + 1}/{total}', flush=True)
            if i in done:
                continue
            page = fetch(f'{BASE}/omr/sets/{i}')
            time.sleep(a.delay)
            rec = parse(page, i) if page else None
            if rec is None:
                misses += 1
                if misses >= 60 and i > 4000:
                    print(f'60 missing in a row at {i}: done', flush=True)
                    break
                continue
            misses = 0
            f.write(json.dumps(rec) + '\n')
            f.flush()


if __name__ == '__main__':
    sys.exit(main())
