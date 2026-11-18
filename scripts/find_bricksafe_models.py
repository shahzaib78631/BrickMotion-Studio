"""Find Bricksafe pages that link to LEGO model files.

This is the finder behind the app's **Bricksafe models** panel. The panel's dev-server
bridge runs it (see scripts/bricksafe-bridge.ts); it also runs standalone:

    python scripts/find_bricksafe_models.py                # 100 pages, default outputs
    python scripts/find_bricksafe_models.py --target 25    # a quick run

Requires: pip install requests beautifulsoup4  (the bridge supplies them through uv)

Outputs, relative to the repo root by default:
    public/data/bricksafe-model-pages.csv   the flat table
    public/data/bricksafe-models.json       the same results, with every URL, rewritten
                                            after each match so the panel can follow along
"""

import argparse
import csv
import json
import os
import random
import re
import time
from datetime import datetime, timezone
from urllib.parse import unquote, urljoin, urlsplit
from uuid import uuid4

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE = "https://bricksafe.com"
EXTENSIONS = (".io", ".mpd", ".lxf", ".ldr", ".lxfml")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FILENAME_RE = re.compile(r"\.(?:io|mpd|lxf|ldr|lxfml)(?:\s|$)", re.I)


def make_session():
    session = requests.Session()
    session.headers.update({
        "User-Agent": "LEGO-model-page-finder/1.0 (public Bricksafe pages)",
        "Cache-Control": "no-cache",
    })
    retries = Retry(
        total=3, backoff_factor=2,
        status_forcelist=(429, 500, 502, 503, 504),
        respect_retry_after_header=True,
    )
    session.mount("https://", HTTPAdapter(max_retries=retries))
    return session


def fetch(session, url):
    response = session.get(url, timeout=25)
    response.raise_for_status()
    return BeautifulSoup(response.text, "html.parser")


def find_browse_pages(soup):
    """Read only Random Pages, excluding the fixed Popular Pages list."""
    heading = soup.find("h2", string=lambda text: text and text.strip() == "Random Pages")
    if heading is None:
        raise ValueError("Bricksafe browse page is missing its Random Pages section")
    section = heading.parent.find_next_sibling("div", class_="cube-portfolio")
    if section is None:
        raise ValueError("Bricksafe Random Pages section has no page grid")
    pages = set()
    for tag in section.select("[href], [src], [data-src]"):
        for attribute in ("href", "src", "data-src"):
            raw = tag.get(attribute)
            if not raw:
                continue
            url = urljoin(BASE, raw)
            parts = urlsplit(url)
            if parts.netloc not in ("bricksafe.com", "www.bricksafe.com"):
                continue
            path = unquote(parts.path)

            if path.startswith("/pages/"):
                # Skip links to individual files, if any.
                if not path.rstrip("/").lower().endswith(EXTENSIONS):
                    pages.add(BASE + path.rstrip("/") + "/")

            if path.startswith("/cache/"):
                # Typical thumbnail path:
                # /cache/user/folder/image.jpg/250x250.jpg
                segments = path.strip("/").split("/")
                if len(segments) >= 5:
                    folder = "/".join(segments[1:-2])
                    pages.add(BASE + "/pages/" + folder + "/")
    return pages


def fetch_random_pages(session):
    # Browse renders a server-selected random sample. A unique query prevents
    # intermediary caches from serving the same sample on subsequent rounds/runs.
    return find_browse_pages(fetch(session, BASE + "/browse?sample=" + uuid4().hex))


def find_model_files(soup, page_url):
    """Look for model-file links without downloading any model files."""
    model_links = {}
    for anchor in soup.select("a[href]"):
        href = urljoin(page_url, anchor["href"])
        parsed = urlsplit(href)
        if parsed.netloc not in ("bricksafe.com", "www.bricksafe.com"):
            continue
        path = unquote(parsed.path).rstrip("/").lower()
        label = anchor.get_text(" ", strip=True)
        url_extension = next((e for e in EXTENSIONS if path.endswith(e)), "")
        label_match = FILENAME_RE.search(label)
        if url_extension or label_match:
            extension = url_extension or label_match.group(0).strip().lower()
            model_links[href] = extension
    return model_links


def write_json(path, payload):
    """Rewrite the results file atomically, so a reader never sees half of it."""
    if not path:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=1)
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description="Find Bricksafe pages linking to LEGO model files.")
    parser.add_argument("--out", default=os.path.join(ROOT, "public", "data", "bricksafe-model-pages.csv"),
                        help="CSV to write ('' to skip)")
    parser.add_argument("--json", default=os.path.join(ROOT, "public", "data", "bricksafe-models.json"),
                        help="results JSON to write ('' to skip)")
    parser.add_argument("--target", type=int, default=100, help="stop after this many matching pages")
    parser.add_argument("--max-rounds", type=int, default=100, help="safety limit on browse rounds")
    parser.add_argument("--delay", type=float, default=1.0, help="seconds between page requests")
    args = parser.parse_args()

    session = make_session()
    visited = set()
    pages = []
    candidates = 0
    rounds = 0
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def snapshot(**extra):
        return {
            "format": "brickmotion-bricksafe-models",
            "version": 1,
            "target": args.target,
            "found": len(pages),
            "candidates": candidates,
            "rounds": rounds,
            "startedAt": started,
            "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "pages": pages,
            **extra,
        }

    if args.out:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
    output = open(args.out, "w", newline="", encoding="utf-8") if args.out else None
    writer = csv.writer(output) if output else None
    if writer:
        writer.writerow(("page_url", "file_extensions", "model_file_urls"))
    write_json(args.json, snapshot())

    try:
        for round_number in range(1, args.max_rounds + 1):
            rounds = round_number
            try:
                sampled = fetch_random_pages(session)
            except (requests.RequestException, ValueError) as exc:
                print(f"Random-page request failed: {exc}", flush=True)
                break

            fresh = sorted(sampled - visited)
            random.shuffle(fresh)
            candidates += len(fresh)
            print(f"Round {round_number}: {len(fresh)} new candidates", flush=True)

            for page_url in fresh:
                visited.add(page_url)
                try:
                    soup = fetch(session, page_url)
                    models = find_model_files(soup, page_url)
                except requests.RequestException as exc:
                    print(f"  Skipped {page_url}: {exc}", flush=True)
                    models = {}

                if models:
                    extensions = sorted(set(models.values()))
                    files = sorted(models)
                    pages.append({"url": page_url, "extensions": extensions, "files": files})
                    if writer:
                        writer.writerow((page_url, ", ".join(extensions), " | ".join(files)))
                        output.flush()
                    write_json(args.json, snapshot())
                    print(f"[{len(pages)}/{args.target}] {page_url} ({len(files)} files)", flush=True)

                if len(pages) >= args.target:
                    print(f"Finished: {len(pages)} matching pages", flush=True)
                    return
                time.sleep(args.delay)

            time.sleep(max(0.0, args.delay * 2))
    except KeyboardInterrupt:
        print("Stopped.", flush=True)
    finally:
        if output:
            output.close()
        write_json(args.json, snapshot(complete=True))

    print(f"Stopped after checking {len(visited)} distinct candidates; found {len(pages)} matches.", flush=True)


if __name__ == "__main__":
    main()
