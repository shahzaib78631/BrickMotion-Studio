"""Studio observations -> incremental geometric reconstruction, MPD and review."""
from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path

import cv2
import numpy as np

from assembly_model.ldraw import load_library
from booklet_mpd.flagged_mpd import write_flagged_mpd
from booklet_mpd.solver.collide import Collider
from booklet_mpd.solver.picture import Picture, colour_rgb
from booklet_mpd.solver.render import render
from booklet_mpd.solver.step import solve

from .catalog import Catalog, PART_ID, candidates
from .source import crop, extract, read_rgb, save_rgb

ROOT = Path(__file__).resolve().parents[2]


def save_json(path, data):
    path = Path(path)
    temp = path.with_suffix(path.suffix+".tmp")
    temp.write_text(json.dumps(data, indent=2, allow_nan=False)+"\n")
    temp.replace(path)


def validate(data, folder, lib):
    if data.get("format") != "brickmotion-studio-observations" or data.get("version") != 1:
        raise ValueError("Unsupported observations format")
    if not data.get("steps"):
        raise ValueError("No supported steps found. Review observations.json and add step/parts crop boxes for this layout.")
    if len(data["steps"]) > 2000:
        raise ValueError("A build may contain at most 2,000 steps.")
    for page in data["pages"]:
        path = (Path(folder)/page["image"]).resolve()
        if not path.is_relative_to(Path(folder).resolve()):
            raise ValueError("Page image must be inside the build folder")
        image = read_rgb(path)
        if hashlib.sha256(image.tobytes()).hexdigest() != page["pixelSHA256"]:
            raise ValueError("Source page pixels changed; extract the source again.")
    seen=set()
    for step in data["steps"]:
        if not isinstance(step.get("id"),str) or not PART_ID.fullmatch(step["id"]) or step["id"] in seen:
            raise ValueError("Each step needs a unique ID containing letters, digits, underscores or hyphens.")
        seen.add(step["id"])
        if type(step.get("number")) is not int or step["number"]<1:
            raise ValueError("Each step needs a positive printed step number")
        if type(step.get("page")) is not int or not 0 <= step["page"] < len(data["pages"]):
            raise ValueError("Step refers to an invalid source page")
        image = read_rgb(Path(folder)/data["pages"][step["page"]]["image"])
        crop(image, step["pictureBox"])
        for part in step["parts"]:
            crop(image, part["box"])
            if type(part.get("count")) is not int or not 1 <= part["count"] <= 500:
                raise ValueError("Part quantities must be integers between 1 and 500")
            if part.get("part") is not None:
                if not PART_ID.fullmatch(str(part["part"])) or not lib.find(part["part"]+".dat"):
                    raise ValueError(f"Unknown local part ID: {part['part']}")
            if part.get("color") is not None and (type(part["color"]) is not int or not 0 <= part["color"] <= 0x7ffffff):
                raise ValueError("Color must be a nonnegative LDraw color code")


def recognize(data, folder, lib, *, limit=256, selected=None, log=lambda _:None):
    pending = [p for s in data["steps"] for p in s["parts"] if not p.get("confirmed")]
    if not pending:
        return
    ids = candidates(lib.root, limit, selected)
    cat = Catalog(lib, ids, ROOT/".cache/studio-builder/catalog", log)
    data["recognition"] = {"candidateParts":len(ids), "limited":bool(limit or selected),
                           "method":"rendered silhouette/aspect and nearest LDraw palette; uncalibrated"}
    for step in data["steps"]:
        image = read_rgb(Path(folder)/data["pages"][step["page"]]["image"])
        for pi, part in enumerate(step["parts"]):
            thumbnail = crop(image, part["box"])
            part["crop"] = f"crops/{step['id']}-part-{pi+1}.png"
            save_rgb(Path(folder)/part["crop"], thumbnail)
            if part.get("confirmed"):
                continue
            matches = cat.match(thumbnail)
            part["candidates"] = matches
            if matches:
                part["part"], part["color"] = matches[0]["part"], matches[0]["color"]
                part["identityScore"] = matches[0]["score"]
                part["margin"] = matches[0]["shapeScore"] - (matches[1]["shapeScore"] if len(matches)>1 else 0)
    save_json(Path(folder)/"observations.json", data)


def comparison(lib, model, result, rgb, path):
    # solve() expresses its returned view in Picture's working pixel frame.
    pic = Picture.from_rgb(rgb, None, None)
    if result.view is None:
        return None
    depth, label = render(lib, model, result.view, pic.rgb.shape[:2])
    predicted = np.full_like(pic.rgb, 255)
    for k, (_,color,_) in enumerate(model):
        predicted[label==k] = colour_rgb(color)
    foreground = label>=0
    contours,_ = cv2.findContours(foreground.astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(predicted,contours,-1,(25,25,25),1)
    from booklet_mpd.solver.edges import part_edges, sample_segments, visible_points
    for part,_,matrix in model:
        edges=part_edges(lib,part)
        if len(edges):
            world=edges.reshape(-1,3)@matrix[:3,:3].T+matrix[:3,3]
            points=visible_points(sample_segments(result.view.project(world).reshape(-1,2,3)),depth)
            if len(points):
                predicted[points[:,0],points[:,1]]=(25,25,25)
    overlay = cv2.addWeighted(pic.rgb,.55,predicted,.45,0)
    save_rgb(path, np.concatenate([pic.rgb,predicted,overlay],axis=1))
    intersection = int((foreground & pic.foreground).sum())
    union = int((foreground | pic.foreground).sum())
    return intersection/union if union else 0.


def run(inputs, folder, *, observations=None, limit=256, selected=None, max_steps=None,
        ldraw=None, exact_collision=False, log=lambda _:None):
    folder = Path(folder).resolve()
    folder.mkdir(parents=True,exist_ok=True)
    # Remove success artifacts from an earlier attempt before a new run can fail.
    for name in ("model.mpd","report.json","review.html","checkpoint.json"):
        (folder/name).unlink(missing_ok=True)
    lib = load_library(str(ldraw or ROOT/"public/ldraw"))
    if observations is None:
        data = extract(inputs,folder,log)
    else:
        data = json.loads(Path(observations).read_text())
    save_json(folder/"observations.json",data)
    validate(data,folder,lib)
    recognize(data,folder,lib,limit=limit,selected=selected,log=log)
    model,groups,confs,rows = [],[],[],[]
    previous=None
    collider = Collider(lib,use_oracle=exact_collision)
    failed = None
    steps = data["steps"][:max_steps] if max_steps else data["steps"]
    try:
        for si,step in enumerate(steps):
            log({"stage":"building","step":si+1,"steps":len(steps)})
            rgb = crop(read_rgb(folder/data["pages"][step["page"]]["image"]),step["pictureBox"])
            # Bound working resolution independently of page DPI. No LEGO fixed
            # print scale is passed to the solver for Studio pages.
            scale = min(1.,420/max(rgb.shape[:2]))
            if scale < 1:
                rgb = cv2.resize(rgb,(round(rgb.shape[1]*scale),round(rgb.shape[0]*scale)),interpolation=cv2.INTER_AREA)
            picture_path=f"crops/{step['id']}-model.png"
            save_rgb(folder/picture_path,rgb)
            parts = step["parts"]
            unread = [p for p in parts if p.get("part") is None or p.get("color") is None]
            row={"step":si+1,"number":step["number"],"page":step["page"]+1,"picture":picture_path,
                 "status":"review", "placed":0,"issues":list(step.get("notes",[]))}
            unsupported = step.get("repeat",1)!=1 or step.get("scope","main")!="main"
            if unread or unsupported or not parts:
                row["status"]="incomplete"
                row["issues"].append("Unidentified parts, empty parts list, or repeated/callout scope needs correction before continuing.")
                failed=si+1
                rows.append(row)
                break
            new=[(p["part"],p["color"]) for p in parts for _ in range(p["count"])]
            for p in parts:
                if not p.get("confirmed"):
                    row["issues"].append(f"Check {p['count']} × {p['part']}, color {p['color']}; automatic identity score {p.get('identityScore',0):.2f}.")
                if p.get("countConfidence",0)<.8:
                    row["issues"].append("Quantity OCR needs review.")
            # Try the preceding view before a free camera search. solve() releases
            # this prior if the completed image agreement drops, so Studio's per-
            # step scale/orientation changes remain possible. A free search alone
            # can explain an incorrect placement by changing the camera instead.
            prior=(previous.view,previous.orientation_index,previous.completed) if previous and previous.view else None
            result=solve(lib,model,new,rgb,None,collider=collider,camera=prior)
            placed=list(result.placed)
            if result.status!="ok" or len(placed)!=len(new):
                row["status"]="incomplete"
                row["issues"].append(f"Placement stopped: {result.status}; {len(placed)}/{len(new)} pieces.")
                failed=si+1
            else:
                model+=placed
                groups.append(placed)
                # Uncalibrated solver scores are deliberately not emitted as
                # probabilities. All inferred poses are flagged for visual review.
                confs.append([0.]*len(placed))
                row["placed"]=len(placed)
                row["comparison"]=f"comparisons/{step['id']}.png"
                row["silhouetteIoU"]=comparison(lib,model,result,rgb,folder/row["comparison"])
                row["solverScore"]=float(result.completed)
                row["camera"]={"orientation":np.asarray(result.view.orientation).tolist(),"yaw":result.view.yaw,
                               "pitch":result.view.pitch,"scale":result.view.scale,"offset":list(result.view.offset)} if result.view else None
                if row["silhouetteIoU"] is None or row["silhouetteIoU"]<.35:
                    row["status"]="incomplete"
                    row["issues"].append("Low image agreement; remaining steps were not built on this hypothesis.")
                    failed=si+1
                previous=result
            rows.append(row)
            save_json(folder/"checkpoint.json",{"completedSteps":len(groups),"groups":[[(p,c,m.tolist()) for p,c,m in g] for g in groups],"rows":rows})
            if failed:
                break
    finally:
        collider.close()
    if max_steps and max_steps<len(data["steps"]) and failed is None:
        failed=len(groups)+1
    summary=write_flagged_mpd(folder/"model.mpd","studio-rebuild",groups,confs,.5,failed_from_step=failed)
    report={"status":"incomplete" if failed else "review", "verified":False,
            "input":"Studio PDF/page pixels only; no model answer key", "stepsDetected":len(data["steps"]),
            "stepsBuilt":len(groups),"failedFromStep":failed,"collision":"mesh" if collider.exact else "bounding-box approximation",
            "recognition":data.get("recognition"),"diagnostics":data.get("diagnostics",[]),"rows":rows,**summary}
    save_json(folder/"report.json",report)
    cards=[]
    for row in rows:
        issue="; ".join(row["issues"])
        img=row.get("comparison",row["picture"])
        cards.append(f'<section><h2>Step {row["number"]} · {row["status"]}</h2><p>{html.escape(issue)}</p><img src="{img}" alt="Source, reconstructed view and overlay"></section>')
    (folder/"review.html").write_text('<!doctype html><meta charset="utf-8"><title>Studio reconstruction review</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;background:#f4f4f4}section{background:white;padding:20px;margin:20px 0}img{max-width:100%}</style><h1>Studio reconstruction</h1><p>Experimental · every inferred pose requires review. Comparison: source / reconstruction / overlay.</p><a href="model.mpd">Download MPD</a>'+''.join(cards))
    log({"stage":"finished",**report})
    return report
