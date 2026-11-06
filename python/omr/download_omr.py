"""Download OMR model files for sets in building-likely themes.

Reads the index from index_omr.py and Rebrickable's sets.csv / themes.csv (free
downloads from rebrickable.com/downloads) to find each set's theme, keeps themes where
buildings live (Town, City, Modular Buildings, Creator, Friends, Castle, Pirates,
Western, Ideas, Architecture, seasonal villages), and fetches their .mpd/.ldr files
politely. Which of them really are buildings is decided later from their parts
(classify.py). Files land in OUT/<set number>/; already downloaded files are skipped.

    python -m omr.download_omr INDEX.jsonl SETS.csv THEMES.csv OUT [--delay 0.6] [--all]

With --all, every set in the index is fetched, whatever its theme (sets Rebrickable does
not know are kept too, with an empty theme).
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import urllib.request
from pathlib import Path

UA = 'BrickMotion-Studio dataset downloader (polite, 1 req/s)'
KEEP = ('Town', 'City', 'Modular Buildings', 'Creator', 'Friends', 'Castle', 'Pirates', 'Western',
        'LEGO Ideas and CUUSOO', 'Architecture', 'Seasonal', 'Legoland', 'Harry Potter', 'Disney',
        'Ninjago', 'Elves', 'Belville', 'Fabuland', 'Paradisa', 'System', 'Basic', 'Classic')
SKIP = ('Duplo', 'Technic', 'Bionicle', 'Books', 'Gear', 'Key Chain', 'Magnets', 'Collectible Minifigures')


def theme_paths(themes_csv: str) -> dict[str, str]:
    th = {r['id']: r for r in csv.DictReader(open(themes_csv))}

    def path(i: str) -> str:
        out = []
        while i:
            out.append(th[i]['name'])
            i = th[i]['parent_id']
        return ' > '.join(reversed(out))
    return {i: path(i) for i in th}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('index')
    ap.add_argument('sets')
    ap.add_argument('themes')
    ap.add_argument('out')
    ap.add_argument('--delay', type=float, default=0.6)
    ap.add_argument('--all', action='store_true', help='every set, not only building-likely themes')
    a = ap.parse_args()
    paths = theme_paths(a.themes)
    set_theme = {r['set_num']: paths.get(r['theme_id'], '') for r in csv.DictReader(open(a.sets))}
    set_meta = {r['set_num']: r for r in csv.DictReader(open(a.sets))}

    wanted = []
    for line in Path(a.index).read_text().splitlines():
        rec = json.loads(line)
        theme = set_theme.get(rec.get('number') or '', '')
        if not rec['files']:
            continue
        if not a.all and (not theme or any(theme.startswith(s) for s in SKIP) or not any(k in theme for k in KEEP)):
            continue
        wanted.append((rec, theme))

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = []
    files = [(rec, theme, url) for rec, theme in wanted for url in rec['files']]
    for n, (rec, theme, url) in enumerate(files, 1):
        print(f'::progress {n}/{len(files)}', flush=True)
        dest = out / (rec['number'] or f"omr-{rec['id']}") / url.rsplit('/', 1)[1]
        meta = set_meta.get(rec['number'] or '', {})
        manifest.append({'set': rec['number'], 'name': rec['name'], 'theme': theme, 'year': meta.get('year'),
                         'parts': meta.get('num_parts'), 'file': str(dest.relative_to(out)), 'url': url})
        if dest.exists() and dest.stat().st_size > 0:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                dest.write_bytes(r.read())
        except Exception as e:  # keep going; a later run retries it
            print(f'failed {url}: {e}', flush=True)
        time.sleep(a.delay)
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=1))
    print(f'{len(wanted)} sets, {len(files)} files', flush=True)


if __name__ == '__main__':
    sys.exit(main())
