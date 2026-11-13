"""Propose review patches across a catalog; no proposal is a reviewed label."""
from __future__ import annotations
from pathlib import Path
import argparse,concurrent.futures,hashlib,json,sys,time
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2,numpy as np,pymupdf
from brickheadz.arrow_geometry import red_arrow_tips
cv2.setNumThreads(1)


def propose(book,root):
    path=ROOT/book['path'];out=root/book['set'];out.mkdir(parents=True,exist_ok=True)
    if (out/'proposals.json').exists():return json.loads((out/'proposals.json').read_text())
    document=pymupdf.open(path);candidates=[];negative=None;scanned=[]
    for index in range(4,min(len(document)-4,48)):
        page=document[index];pix=page.get_pixmap(dpi=120,alpha=False,colorspace=pymupdf.csRGB)
        rgb=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,3).copy();h,w=rgb.shape[:2];all_heads=[]
        for colour,channels in [('red',(0,1,2)),('green',(1,0,2))]:
            coloured=rgb[:,:,channels];tips=red_arrow_tips(coloured)
            val=coloured.astype(int);mask=((val[:,:,0]>110)&(val[:,:,0]>1.5*val[:,:,1])&(val[:,:,0]>1.5*val[:,:,2])).astype(np.uint8)
            count,labels,stats,_=cv2.connectedComponentsWithStats(mask)
            for tip in tips:
                x,y=np.rint(tip).astype(int)
                if not 0<=x<w or not 0<=y<h:continue
                component=labels[y,x]
                if not component:continue
                bx,by,bw,bh,area=stats[component];yy,xx=np.where(labels[by:by+bh,bx:bx+bw]==component)
                points=np.column_stack([xx+bx,yy+by]).astype(float);centre=points.mean(0)
                _,eig=np.linalg.eigh(np.cov(points.T));axis=eig[:,-1]
                if axis@(tip-centre)<0:axis=-axis
                all_heads.append({'tip':tip.tolist(),'head_base':(tip-axis*16).tolist(),'colour':colour})
            if negative is None:
                # A contrasting part/component is only a negative PROPOSAL.
                for k in range(1,count):
                    x,y,bw,bh,area=map(int,stats[k])
                    if not 80<area<1000 or not 10<max(bw,bh)<65:continue
                    centre=np.array([x+bw/2,y+bh/2])
                    if any(np.linalg.norm(centre-t)<60 for t in tips):continue
                    if y<h*.2 or y>h*.85:continue
                    negative=(rgb.copy(),centre,index+1);break
        scanned.append(index+1)
        for head in all_heads:
            tip=np.array(head['tip']);x0=int(np.clip(round(tip[0])-48,0,max(0,w-96)));y0=int(np.clip(round(tip[1])-48,0,max(0,h-96)))
            # Include known neighbouring heads; reviewer still checks completeness.
            nearby=[a for a in all_heads if x0<=a['tip'][0]<x0+96 and y0<=a['tip'][1]<y0+96]
            if any(a['page']==index+1 and np.linalg.norm(np.array(a['centre'])-tip)<65 for a in candidates):continue
            candidates.append({'rgb':rgb[y0:y0+96,x0:x0+96].copy(),'page':index+1,'box':[x0,y0,x0+96,y0+96],
                               'centre':tip.tolist(),'arrows':[{'tip':(np.array(a['tip'])-[x0,y0]).tolist(),'head_base':(np.array(a['head_base'])-[x0,y0]).tolist()} for a in nearby]})
        if len(candidates)>=8 and len({r['page'] for r in candidates})>=3:break
    # Spread selected positives across pages/directions, with alternates for rejection.
    chosen=[]
    for c in candidates:
        if c['page'] not in {r['page'] for r in chosen}:chosen.append(c)
        if len(chosen)==3:break
    for c in candidates:
        if len(chosen)>=4:break
        if all(c is not prior for prior in chosen):chosen.append(c)
    rows=[]
    for i,c in enumerate(chosen):
        file=out/f'positive-{i}.png';cv2.imwrite(str(file),cv2.cvtColor(c['rgb'],cv2.COLOR_RGB2BGR))
        rows.append({'id':f"{book['set']}-positive-{i}",'proposal':'positive','image':str(file.relative_to(ROOT)),
                     'pixel_sha256':hashlib.sha256(c['rgb'].tobytes()).hexdigest(),'page':c['page'],'pdfDPI':120,'pageCropPixels':c['box'],
                     'arrows':c['arrows'],'reviewed':False})
    if negative is None:
        page=document[min(5,len(document)-1)];pix=page.get_pixmap(dpi=120,alpha=False,colorspace=pymupdf.csRGB)
        rgb=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,3).copy();negative=(rgb,np.array([rgb.shape[1]-55,rgb.shape[0]*.5]),page.number+1)
    image,centre,page=negative;h,w=image.shape[:2];x0=int(np.clip(centre[0]-48,0,w-96));y0=int(np.clip(centre[1]-48,0,h-96));crop=image[y0:y0+96,x0:x0+96].copy()
    file=out/'negative.png';cv2.imwrite(str(file),cv2.cvtColor(crop,cv2.COLOR_RGB2BGR))
    rows.append({'id':f"{book['set']}-negative",'proposal':'negative','image':str(file.relative_to(ROOT)),'pixel_sha256':hashlib.sha256(crop.tobytes()).hexdigest(),
                 'page':page,'pdfDPI':120,'pageCropPixels':[x0,y0,x0+96,y0+96],'arrows':[],'reviewed':False})
    record={'book':book,'pagesScanned':scanned,'candidateCount':len(candidates),'samples':rows}
    document.close()
    (out/'proposals.json').write_text(json.dumps(record,indent=2));return record


def sheets(records,root):
    # 4 positive alternatives and 1 negative per booklet; 6 booklets per sheet.
    for start in range(0,len(records),6):
        subset=records[start:start+6];canvas=np.full((len(subset)*216,5*192,3),255,np.uint8)
        for row,record in enumerate(subset):
            for col,sample in enumerate(record['samples']):
                im=cv2.imread(str(ROOT/sample['image']))
                for head in sample['arrows']:
                    cv2.arrowedLine(im,tuple(np.rint(head['head_base']).astype(int)),tuple(np.rint(head['tip']).astype(int)),(255,0,255),1,tipLength=.2)
                    cv2.circle(im,tuple(np.rint(head['tip']).astype(int)),2,(0,180,0),1)
                im=cv2.resize(im,(192,192),interpolation=cv2.INTER_NEAREST);y=row*216;x=col*192
                canvas[y:y+192,x:x+192]=im;cv2.putText(canvas,sample['id'],(x+2,y+207),0,.4,(0,0,0),1)
        cv2.imwrite(str(root/f'review-{start//6+1:02d}.jpg'),canvas)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--catalog',type=Path,default=ROOT/'.cache/instructions/arrow-catalog-100/catalog.json')
    p.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/arrow-catalog-100/annotations');p.add_argument('--workers',type=int,default=4)
    args=p.parse_args();args.out.mkdir(parents=True,exist_ok=True);books=json.loads(args.catalog.read_text())['booklets'];records=[]
    pending=[]
    for book in books:
        cached=args.out/book['set']/'proposals.json'
        if cached.exists():
            record=json.loads(cached.read_text());record['book']=book;records.append(record)
        else:pending.append(book)
    if pending:
        with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures={pool.submit(propose,book,args.out):book for book in pending}
            for future in concurrent.futures.as_completed(futures):
                record=future.result();records.append(record);print(record['book']['set'],len(records),len(record['samples']),flush=True)
    records.sort(key=lambda r:int(r['book']['set']));(args.out/'proposals.json').write_text(json.dumps({'reviewed':False,'booklets':records},indent=2))
    sheets(records,args.out);print('sheets',len(records),flush=True)

if __name__=='__main__':main()
