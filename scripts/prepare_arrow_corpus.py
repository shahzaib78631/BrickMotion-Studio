"""Create unreviewed colour-component annotation proposals from pinned LEGO PDFs.

This script never marks a proposal reviewed. Its output requires visual review
before any sample is admitted to the training/evaluation manifest.
"""
from pathlib import Path
import argparse,hashlib,json,sys
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'python'))
import cv2,numpy as np,pymupdf


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--sources',type=Path,default=ROOT/'benchmarks/instructions/arrow-corpus-sources.json')
    p.add_argument('--out',type=Path,default=ROOT/'.cache/instructions/arrow-corpus/proposals');p.add_argument('--dpi',type=int,default=120)
    args=p.parse_args();args.out.mkdir(parents=True,exist_ok=True);rows=[]
    for book in json.loads(args.sources.read_text())['booklets']:
        path=ROOT/book['path']
        if hashlib.sha256(path.read_bytes()).hexdigest()!=book['sha256']:raise ValueError('Source PDF hash changed')
        doc=pymupdf.open(path);count=0
        for page in doc:
            if page.number<4 or page.number>=len(doc)-4:continue
            pix=page.get_pixmap(dpi=args.dpi,alpha=False,colorspace=pymupdf.csRGB)
            rgb=np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width,3).copy();v=rgb.astype(int)
            masks=[('red',(v[:,:,0]>100)&(v[:,:,0]>1.5*v[:,:,1])&(v[:,:,0]>1.5*v[:,:,2])),
                   ('green',(v[:,:,1]>80)&(v[:,:,1]>1.5*v[:,:,0])&(v[:,:,1]>1.3*v[:,:,2]))]
            for colour,mask in masks:
                n,labels,stats,_=cv2.connectedComponentsWithStats(mask.astype(np.uint8))
                for index in range(1,n):
                    x,y,w,h,area=map(int,stats[index])
                    if area<16 or area>1800 or max(w,h)<12 or max(w,h)>180:continue
                    yy,xx=np.where(labels[y:y+h,x:x+w]==index);points=np.column_stack([xx+x,yy+y]).astype(float)
                    centre=points.mean(0);ev,axes=np.linalg.eigh(np.cov(points.T))
                    if ev[-1]/max(ev[0],.1)<3:continue
                    axis=axes[:,-1];q=points@axis;endpoints=[points[q<=q.min()+.8].mean(0),points[q>=q.max()-.8].mean(0)]
                    # Proposal only: filled head often puts mass near the tip.
                    tip=min(endpoints,key=lambda z:np.linalg.norm(z-centre));direction=tip-centre;direction/=np.linalg.norm(direction)
                    base=tip-direction*min(20,max(7,(q.max()-q.min())*.3))
                    x0=max(0,int(centre[0])-110);y0=max(0,int(centre[1])-110);x1=min(rgb.shape[1],x0+220);y1=min(rgb.shape[0],y0+220)
                    crop=rgb[y0:y1,x0:x1].copy();identity=f"{book['set']}-p{page.number+1}-{colour}-{index}"
                    image=args.out/(identity+'.png');cv2.imwrite(str(image),cv2.cvtColor(crop,cv2.COLOR_RGB2BGR))
                    row={'id':identity,'booklet':book['booklet'],'set':book['set'],'split':book['split'],'page':page.number+1,'image':str(image.relative_to(ROOT)),
                         'pixel_sha256':hashlib.sha256(crop.tobytes()).hexdigest(),'size':[crop.shape[1],crop.shape[0]],'pdfDPI':args.dpi,'pageCropPixels':[x0,y0,x1,y1],
                         'sourcePDFSHA256':book['sha256'],'sourceURL':book['sourceURL'],'proposalTip':(tip-[x0,y0]).tolist(),'proposalHeadBase':(base-[x0,y0]).tolist(),
                         'endpoints':[(z-[x0,y0]).tolist() for z in endpoints],'reviewed':False,'colour':colour}
                    rows.append(row);count+=1
        print(book['set'],count,flush=True)
    (args.out/'proposals.json').write_text(json.dumps({'caveat':'Unreviewed proposals, not training labels','samples':rows},indent=2))
    for book in sorted({r['set'] for r in rows}):
        subset=[r for r in rows if r['set']==book]
        for start in range(0,len(subset),30):
            selected=subset[start:start+30];canvas=np.full((((len(selected)+5)//6)*240,6*220,3),255,np.uint8)
            for i,row in enumerate(selected):
                im=cv2.imread(str(ROOT/row['image']));a=tuple(np.rint(row['proposalHeadBase']).astype(int));b=tuple(np.rint(row['proposalTip']).astype(int))
                cv2.arrowedLine(im,a,b,(255,0,255),1,tipLength=.2);x=i%6*220;y=i//6*240;canvas[y:y+im.shape[0],x:x+im.shape[1]]=im
                cv2.putText(canvas,f"{start+i}: {row['id']}",(x+2,y+234),0,.32,(0,0,0),1)
            cv2.imwrite(str(args.out/f'{book}-review-{start//30+1:02d}.jpg'),canvas)
    print('total',len(rows),flush=True)

if __name__=='__main__':main()
