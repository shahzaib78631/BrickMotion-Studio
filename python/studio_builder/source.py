"""Studio raster pages and OCR layout. Coordinates in saved manifests are pixels."""
from __future__ import annotations

import csv
import hashlib
import io
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

import cv2
import numpy as np
import pymupdf


def read_rgb(path):
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Cannot read image: {path}")
    return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)


def save_rgb(path, image):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), cv2.cvtColor(image, cv2.COLOR_RGB2BGR)):
        raise OSError(f"Cannot write image: {path}")


def pages(inputs, out, dpi=144):
    """Use original full-page PDF image bytes when possible; otherwise render once."""
    rows = []
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for source in map(Path, inputs):
        if source.suffix.lower() == ".pdf":
            with pymupdf.open(source) as doc:
                for page in doc:
                    # Only bypass rendering for an unrotated, single page-filling
                    # image and no overlaid text or drawings. Others need composition.
                    info = page.get_image_info(xrefs=True)
                    native = (len(info) == 1 and info[0].get("xref") and not page.rotation
                              and not page.get_text().strip() and not page.get_drawings()
                              and all(abs(a-b) < 1 for a, b in zip(info[0]["bbox"], page.rect)))
                    if native:
                        pix = pymupdf.Pixmap(doc, info[0]["xref"])
                        if pix.alpha:
                            pix = pymupdf.Pixmap(pix, 0)
                        if pix.n != 3:
                            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
                    else:
                        pix = page.get_pixmap(dpi=dpi, alpha=False, colorspace=pymupdf.csRGB)
                    rgb = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3).copy()
                    rows.append(_page(rgb, source.name, page.number + 1, out, len(rows)))
        else:
            rows.append(_page(read_rgb(source), source.name, 1, out, len(rows)))
    return rows


def _page(rgb, source, number, out, index):
    if rgb.shape[0] * rgb.shape[1] > 40_000_000:
        raise ValueError("Page exceeds 40 million pixels; reduce image resolution.")
    path = f"pages/{index+1:04d}.png"
    save_rgb(out / path, rgb)
    return {"image": path, "source": source, "sourcePage": number,
            "width": rgb.shape[1], "height": rgb.shape[0],
            "pixelSHA256": hashlib.sha256(rgb.tobytes()).hexdigest()}


def words(rgb, *, psm=11, whitelist=None):
    if not shutil.which("tesseract"):
        raise RuntimeError("Install Tesseract OCR to read Studio page labels (brew install tesseract).")
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "page.png"
        save_rgb(path, rgb)
        args=["tesseract", str(path.resolve()), "stdout", "--psm", str(psm), "--dpi", "144"]
        if whitelist:
            args += ["-c", "tessedit_char_whitelist="+whitelist]
        result = subprocess.run(args+["tsv"],
                                capture_output=True, text=True, timeout=60, check=True)
    rows = []
    for row in csv.DictReader(io.StringIO(result.stdout), delimiter="\t"):
        if row["level"] == "5" and row.get("text", "").strip():
            x, y, w, h = [int(row[k]) for k in ("left", "top", "width", "height")]
            rows.append({"text": row["text"].strip(), "confidence": float(row["conf"]),
                         "box": [x, y, x+w, y+h]})
    return rows


def panel_words(rgb):
    """Read isolated labels around light Studio parts panels.

    Full-page OCR often treats a large brick as a letter and discards the real
    labels. These ROIs separate text from the model instead of guessing labels.
    """
    h,w=rgb.shape[:2]
    p=rgb.astype(np.int16)
    light=(p.min(-1)>150)&(p.min(-1)<245)
    blue=(p[:,:,2]-p[:,:,0]>10)&(p[:,:,2]>210)
    grey=(p.max(-1)-p.min(-1)<12)
    count,_,stats,_=cv2.connectedComponentsWithStats((light&(blue|grey)).astype(np.uint8),8)
    out=[]
    for x,y,bw,bh,area in stats[1:]:
        if not (bw>w*.13 and bh>h*.045 and area>w*h*.005 and bw*bh<w*h*.32):
            continue
        boxes=[([max(0,x-int(w*.17)),max(0,y-8),max(1,x-4),min(h,y+bh)],"0123456789",6),
               ([x+2,y+int(bh*.70),min(w,x+bw-2),min(h,y+bh-1)],"0123456789xX",6)]
        for box,chars,psm in boxes:
            if box[2]<=box[0] or box[3]<=box[1]:
                continue
            roi=crop(rgb,box)
            roi=cv2.resize(roi,None,fx=2,fy=2,interpolation=cv2.INTER_CUBIC)
            for word in words(roi,psm=psm,whitelist=chars):
                word["box"]=[round(v/2+box[k%2]) for k,v in enumerate(word["box"])]
                if "x" in word["text"].lower():
                    word["panelBox"]=[int(x),int(y),int(x+bw),int(y+bh)]
                out.append(word)
    return out


def crop(rgb, box):
    x0, y0, x1, y1 = [int(v) for v in box]
    h, w = rgb.shape[:2]
    if not (0 <= x0 < x1 <= w and 0 <= y0 < y1 <= h):
        raise ValueError(f"Invalid crop {box} for {w}×{h} page")
    return rgb[y0:y1, x0:x1].copy()


def layout(rgb, text):
    """Detect numbered step cells and parts thumbnails in common Studio layouts.

    Conservative: no inferred step numbers or default quantity of one. Unsupported
    layouts remain unparsed and can be corrected in the saved observations.
    """
    h, w = rgb.shape[:2]
    qty = []
    for word in text:
        match = re.fullmatch(r"([1-9]\d{0,2})\s*[xX×]", word["text"])
        if match:
            qty.append({**word, "count": int(match[1])})
    labels = [t for t in text if re.fullmatch(r"[1-9]\d{0,3}", t["text"])
              and t["confidence"] >= 60 and t["box"][1] < h*.9
              and t["box"][3]-t["box"][1] >= max(12, w*.025)
              and t["box"][0] < w*.6]
    labels.sort(key=lambda t: (t["box"][1], t["box"][0]))
    # A step label needs a nearby quantity row; avoid treating an illustration's
    # printed number or the page footer as a build step.
    labels = [t for t in labels if any(q["box"][0] > t["box"][0]
              and abs(q["box"][1]-t["box"][1]) < h*.23 for q in qty)]
    steps = []
    for label in labels:
        lx, ly, _, lh = label["box"]
        right = [t["box"][0] for t in labels if t["box"][0] > lx+w*.2
                 and abs(t["box"][1]-ly) < h*.08]
        below = [t["box"][1] for t in labels if t["box"][1] > ly+h*.12
                 and abs(t["box"][0]-lx) < w*.2]
        x0 = max(0, lx-int(w*.025))
        x1 = min(right)-int(w*.025) if right else w-int(w*.02)
        y1 = min(below)-int(h*.02) if below else h-int(h*.035)
        own = [q for q in qty if lx < q["box"][0] < x1
               and ly-h*.03 <= q["box"][1] < min(y1, ly+h*.23)]
        if not own:
            continue
        bottom = max(q["box"][3] for q in own)
        calls = []
        for q in own:
            bx = q["box"]
            row = sorted([c for c in own if abs(c["box"][1]-bx[1]) < h*.025], key=lambda c:c["box"][0])
            k = row.index(q)
            # Standard Studio quantities sit below the part thumbnail. Use
            # midpoints between labels and strip the quantity row itself.
            panel=q.get("panelBox")
            left = (row[k-1]["box"][2]+bx[0])//2 if k else (panel[0]+2 if panel else max(lx+int(w*.06), x0))
            end = (bx[2]+row[k+1]["box"][0])//2 if k+1 < len(row) else (panel[2]-2 if panel else x1)
            above = [c["box"][3] for c in own if c["box"][1] < bx[1]-h*.025]
            top = max(above)+3 if above else (panel[1]+2 if panel else max(0, ly-int(h*.02)))
            box = [left, top, end, bx[1]-3]
            if box[2] <= box[0] or box[3] <= box[1]:
                continue
            calls.append({"box": box, "count": q["count"], "countConfidence": q["confidence"]/100,
                          "part": None, "color": None, "confirmed": False})
        picture = [x0, bottom+max(4, int(h*.012)), x1, y1]
        if calls and picture[3] > picture[1]+20:
            steps.append({"number": int(label["text"]), "pictureBox": picture, "parts": calls,
                          "repeat": 1, "scope": "main", "notes": []})
    return steps


def extract(inputs, out, log=lambda _: None):
    page_rows = pages(inputs, out)
    steps, diagnostics = [], []
    for pi, page in enumerate(page_rows):
        log({"stage": "reading", "page": pi+1, "pages": len(page_rows)})
        rgb = read_rgb(Path(out) / page["image"])
        text = words(rgb)
        for word in panel_words(rgb):
            same=next((other for other in text if word["text"]==other["text"]
                       and abs(word["box"][0]-other["box"][0])<10
                       and abs(word["box"][1]-other["box"][1])<10),None)
            if same is None:
                text.append(word)
            elif word.get("panelBox"):
                same["panelBox"]=word["panelBox"]
        page["ocr"] = text
        found = layout(rgb, text)
        if not found:
            diagnostics.append({"page": pi+1, "message": "No supported step layout detected. Review this page; it may be a cover, inventory or unsupported instructions."})
        for step in found:
            step["page"] = pi
            step["id"] = f"step-{len(steps)+1:04d}"
            steps.append(step)
    return {"format": "brickmotion-studio-observations", "version": 1,
            "pages": page_rows, "steps": steps, "diagnostics": diagnostics}
