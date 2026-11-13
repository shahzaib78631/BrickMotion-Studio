"""Audit 21065 book-one callouts from visible PDF artwork, retaining per-item source evidence."""
from __future__ import annotations
import argparse, hashlib, json, sys
from collections import Counter, defaultdict
from pathlib import Path
import cv2
import numpy as np
import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'python'))
from instructions_pdf.extract import _spans, COUNT, ELEMENT, MAIN, NUM
from booklet_mpd.solver.parts import element_index

BOOK = ROOT/'.cache/instructions/21065/pdf/21065-6655036.pdf'
INVENTORY = ROOT/'.cache/instructions/21065/pdf/21065-6655038.pdf'
OUT = ROOT/'output/book1-parts'
BG = np.array([.537,.563,.578])*255


def artwork(rgb):
    border=np.concatenate([rgb[0],rgb[-1],rgb[:,0],rgb[:,-1]])
    vals,counts=np.unique((border//8).astype(int),axis=0,return_counts=True)
    bg=vals[counts.argmax()]*8+4
    fg=(np.linalg.norm(rgb.astype(float)-bg,axis=2)>24).astype(np.uint8)
    return fg


def normal(rgb, mask=None, size=80):
    if mask is None:mask=artwork(rgb)
    ys,xs=np.where(mask)
    if not len(xs):return np.full((size,size,3),.55,np.float32)
    rgb=rgb[ys.min():ys.max()+1,xs.min():xs.max()+1].copy()
    mask=mask[ys.min():ys.max()+1,xs.min():xs.max()+1]
    rgb[mask==0]=[137,144,147]
    factor=(size-6)/max(rgb.shape[:2]);h,w=[max(1,round(s*factor)) for s in rgb.shape[:2]]
    out=np.full((size,size,3),[137,144,147],np.uint8);im=cv2.resize(rgb,(w,h),interpolation=cv2.INTER_AREA if factor<1 else cv2.INTER_CUBIC)
    y,x=(size-h)//2,(size-w)//2;out[y:y+h,x:x+w]=im
    return out.astype(np.float32)/255


def inventory(doc, index):
    records=[];scale=4
    for pi in range(298,303):
        page=doc[pi];spans=_spans(page)
        counts=[s for s in spans if COUNT.match(s['text']) and s['size']<12]
        elements=[s for s in spans if ELEMENT.match(s['text'])]
        pix=page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),alpha=False)
        rgb=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,3).copy()
        mask=(np.linalg.norm(rgb.astype(float)-BG,axis=2)>30).astype(np.uint8)
        for label in spans:
            bb=label['bbox'];x0=max(0,int(bb[0]*scale)-1);x1=min(pix.width,int(np.ceil(bb[2]*scale))+1);y0=max(0,int(bb[1]*scale)-1);y1=min(pix.height,int(np.ceil(bb[3]*scale))+1);mask[y0:y1,x0:x1]=0
        mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
        n,cc,stats,_=cv2.connectedComponentsWithStats(mask,8)
        components=[]
        for k in range(1,n):
            x,y,w,h,area=stats[k]
            if area<scale*scale*3 or w<scale*2 or h<scale*2:continue
            components.append((k,[x/scale,y/scale,(x+w)/scale,(y+h)/scale],(x,y,w,h)))
        used=set()
        for c in counts:
            cx=(c['bbox'][0]+c['bbox'][2])/2
            es=[e for e in elements if 0<=e['bbox'][1]-c['bbox'][1]<=18 and abs(e['bbox'][0]-c['bbox'][0])<=12]
            if not es:continue
            e=min(es,key=lambda e:e['bbox'][1]);above=[i for i in components if i[1][3]<=c['bbox'][1]+2 and i[1][0]-5<=cx<=i[1][2]+5]
            if not above:raise ValueError(f"inventory element {e['text']}: no visible artwork")
            k,box,(x,y,w,h)=min(above,key=lambda i:c['bbox'][1]-i[1][3])
            if k in used:print('WARNING reused inventory component',pi+1,e['text'],flush=True)
            used.add(k)
            crop=rgb[y:y+h,x:x+w].copy();cmask=(cc[y:y+h,x:x+w]==k).astype(np.uint8);crop[cmask==0]=[137,144,147]
            rec={'element':e['text'],'setQuantity':int(c['text'][:-1]),'page':pi+1,'box':box,'countBox':list(c['bbox']),'elementBox':list(e['bbox']),'catalog':index.get(e['text'])}
            path=f"inventory/{e['text']}.png";cv2.imwrite(str(OUT/path),cv2.cvtColor(crop,cv2.COLOR_RGB2BGR));rec['image']=path
            rec['_norm']=normal(crop,cmask);rec['_size']=[w/scale,h/scale];rec['sizePt']=rec['_size']
            records.append(rec)
    return records


def callouts(doc, pages=None):
    steps=[];section=0;previous=999;groups={};scale=4
    for pi,page in enumerate(doc):
        spans=_spans(page);infos=page.get_image_info(xrefs=True);mains=sorted([s for s in spans if NUM.match(s['text']) and MAIN[0]<=s['size']<=MAIN[1]],key=lambda s:int(s['text']))
        if not mains:continue
        page_steps=[]
        for m in mains:
            number=int(m['text'])
            if number<=previous:section+=1
            previous=number
            st={'index':len(steps)+len(page_steps)+1,'section':section,'step':number,'page':pi+1,'parts':[],'_label':m['bbox']};page_steps.append(st)
        if pages and pi+1 not in pages:
            steps+=page_steps;continue
        boxes=[]
        for d in page.get_drawings():
            r=d['rect'];fill=d.get('fill')
            if not fill or len(fill)!=3 or max(abs(fill[i]-BG[i]/255) for i in range(3))>.02:continue
            if r.width<20 or r.height<15 or r.get_area()>page.rect.get_area()*.6:continue
            labels=[s for s in spans if COUNT.match(s['text']) and s['size']<12 and r.contains(pymupdf.Point(s['bbox'][0]+1,(s['bbox'][1]+s['bbox'][3])/2))]
            if labels and not any((r&old).get_area()>.98*r.get_area() for old,_ in boxes):boxes.append((r,labels))
        for bi,(box,labels) in enumerate(boxes):
            below=[s for s in page_steps if s['_label'][1]>=box.y1-2]
            owner=min(below or page_steps,key=lambda s:np.hypot(s['_label'][0]-box.x0,s['_label'][1]-box.y1))
            pix=page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),clip=box,alpha=False)
            rgb=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,3).copy()
            mask=(np.linalg.norm(rgb.astype(float)-BG,axis=2)>30).astype(np.uint8)
            for label in labels:
                b=label['bbox'];x0=max(0,int(b[0]*scale)-pix.x-1);x1=min(pix.width,int(np.ceil(b[2]*scale))-pix.x+1);y0=max(0,int(b[1]*scale)-pix.y-1);y1=min(pix.height,int(np.ceil(b[3]*scale))-pix.y+1);mask[y0:y1,x0:x1]=0
            # Remove the white border, not the artwork inside it.
            mask[:3]=0;mask[-3:]=0;mask[:,:3]=0;mask[:,-3:]=0
            mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
            n,cc,stats,_=cv2.connectedComponentsWithStats(mask,8)
            components=[]
            for k in range(1,n):
                x,y,w,h,area=stats[k]
                if area<scale*scale*3 or w<scale*2 or h<scale*2:continue
                bb=[(x+pix.x)/scale,(y+pix.y)/scale,(x+w+pix.x)/scale,(y+h+pix.y)/scale]
                components.append((k,bb,(x,y,w,h)))
            pairs=[]
            for ci,(_,b,_) in enumerate(components):
                for li,l in enumerate(labels):
                    lb=l['bbox'];gap=lb[1]-b[3]
                    if gap < -3 or gap > 25:continue
                    horizontal=abs(b[0]-lb[0])
                    pairs.append((max(gap,0)+4*horizontal,ci,li))
            matches={};used=set()
            for _,ci,li in sorted(pairs):
                if ci not in matches and li not in used:matches[ci]=li;used.add(li)
            for ci,(k,bb,(x,y,w,h)) in enumerate(components):
                crop=rgb[max(0,y-1):y+h+1,max(0,x-1):x+w+1].copy();cmask=(cc[max(0,y-1):y+h+1,max(0,x-1):x+w+1]==k).astype(np.uint8);crop[cmask==0]=[137,144,147]
                normalized=normal(crop,cmask)
                def iou(info):
                    a=info['bbox'];inter=max(0,min(a[2],bb[2])-max(a[0],bb[0]))*max(0,min(a[3],bb[3])-max(a[1],bb[1]));return inter/max(1e-6,(a[2]-a[0])*(a[3]-a[1])+(bb[2]-bb[0])*(bb[3]-bb[1])-inter)
                asset=max(infos,key=iou);ab=asset['bbox']
                region=[round(((bb[0]+bb[2])/2-ab[0])/(ab[2]-ab[0]),1),round(((bb[1]+bb[3])/2-ab[1])/(ab[3]-ab[1]),1)]
                signature=f"{asset['xref']}:{region}"
                key=hashlib.sha256(signature.encode()).hexdigest()[:16]
                # The same template may be JPEG-resampled differently; cluster after matching.
                if key not in groups:
                    image=f'callouts/{key}.png';cv2.imwrite(str(OUT/image),cv2.cvtColor(crop,cv2.COLOR_RGB2BGR));groups[key]={'key':key,'image':image,'_norm':normalized,'_size':[w/scale,h/scale],'sizePt':[w/scale,h/scale],'sourceAsset':{'xref':asset['xref'],'region':region},'occurrences':[]}
                label=labels[matches[ci]] if ci in matches else None
                item={'group':key,'quantity':int(COUNT.match(label['text']).group(1)) if label else None,'box':bb,'countBox':list(label['bbox']) if label else None}
                owner['parts'].append(item);groups[key]['occurrences'].append({'index':owner['index'],'page':pi+1,'step':owner['step'],'quantity':item['quantity']})
            unused=[labels[i] for i in range(len(labels)) if i not in used]
            if unused:owner.setdefault('issues',[]).append({'code':'unmatched-count-labels','box':list(box),'labels':unused})
            owner.setdefault('calloutBoxes',[]).append(list(box))
        steps+=page_steps
        if (pi+1)%30==0:print('segmented page',pi+1,flush=True)
    return steps,groups


def colour_feature(image):
    rgb=np.round(image*255).astype(np.uint8); hsv=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV)
    # Chromatic body pixels distinguish tan, nougat and green even when tiny round
    # parts contain mostly dark outlines and holes. Neutral bodies stay neutral.
    valid=(hsv[:,:,1]>35)&(hsv[:,:,2]>70)
    if valid.sum()<8:return np.ones(3)
    pixels=rgb[valid].astype(float);ratios=pixels/np.maximum(pixels.max(1,keepdims=True),1)
    return np.median(ratios,axis=0)


def identify(groups, inv):
    templates=np.stack([r['_norm'] for r in inv]);colours=np.stack([colour_feature(r['_norm']) for r in inv]);dims=np.array([r['_size'] for r in inv])
    for group in groups.values():
        # The booklet consistently prints callouts 4/3 the inventory drawing size.
        size=np.array(group['_size']);dimension=np.mean(np.abs(np.log(size/(dims*4/3))),axis=1)
        visual=np.mean(np.abs(templates-group['_norm']),axis=(1,2,3))
        colour=np.linalg.norm(colours-colour_feature(group['_norm']),axis=1)/np.sqrt(3)
        combined=visual+.12*dimension+.18*colour
        top=np.argsort(combined)[:5]
        group['candidates']=[{'element':inv[i]['element'],'part':inv[i]['catalog'].get('ldrawPart') if inv[i]['catalog'] else None,'rebrickablePart':inv[i]['catalog'].get('part') if inv[i]['catalog'] else None,'color':inv[i]['catalog'].get('color') if inv[i]['catalog'] else None,'colorName':inv[i]['catalog'].get('colorName') if inv[i]['catalog'] else None,'score':round(float(combined[i]),5),'visualError':round(float(visual[i]),5),'colourError':round(float(colour[i]),5),'dimensionError':round(float(dimension[i]),5),'image':inv[i]['image']} for i in top]
        group['best']=group['candidates'][0];group['margin']=round(float(combined[top[1]]-combined[top[0]]),5)


def clean(x):
    if isinstance(x,dict):return {k:clean(v) for k,v in x.items() if not k.startswith('_')}
    if isinstance(x,list):return [clean(v) for v in x]
    return x


def main():
    global BOOK, OUT
    parser=argparse.ArgumentParser();parser.add_argument('--pages');parser.add_argument('--book',type=int,choices=[1,2,3],default=1);args=parser.parse_args();pages=set(map(int,args.pages.split(','))) if args.pages else None
    if args.book != 1:
        BOOK=ROOT/f'.cache/instructions/21065/pdf/21065-{6655035+args.book}.pdf'
        OUT=ROOT/f'.cache/booklet-mpd/parts-crosscheck/21065/book{args.book}'
    for name in ['inventory','callouts']: (OUT/name).mkdir(parents=True,exist_ok=True)
    doc=pymupdf.open(BOOK); inv=inventory(pymupdf.open(INVENTORY),element_index());steps,groups=callouts(doc,pages);identify(groups,inv)
    for st in steps:
        for p in st['parts']:p['match']=groups[p['group']]['best'];p['margin']=groups[p['group']]['margin']
    report=clean({'set':'21065','book':args.book,'pdf':str(BOOK),'pdfSha256':hashlib.sha256(BOOK.read_bytes()).hexdigest(),'sourceInventory':'https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6655038.pdf','steps':steps,'groups':list(groups.values()),'inventory':inv})
    (OUT/'audit.json').write_text(json.dumps(report,indent=2));print('steps',len(steps),'groups',len(groups),'items',sum(len(s['parts']) for s in steps),'missing quantities',sum(p['quantity'] is None for s in steps for p in s['parts']),flush=True)
    print('first9',[(s['step'],[(p['match']['part'],p['match']['color'],p['quantity']) for p in s['parts']]) for s in steps[:9]])

if __name__=='__main__':main()
