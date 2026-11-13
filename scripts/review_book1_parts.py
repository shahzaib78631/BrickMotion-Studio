from pathlib import Path
import json,math
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'output/book1-parts';r=json.loads((OUT/'audit.json').read_text());groups=sorted(r['groups'],key=lambda g:-g['best']['score']);(OUT/'review').mkdir(exist_ok=True)
font=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',12);small=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',10)
for i,g in enumerate(groups):g['reviewId']=i+1
(OUT/'review-order.json').write_text(json.dumps([{'id':g['reviewId'],'key':g['key']} for g in groups],indent=1))
for start in range(0,len(groups),25):
 im=Image.new('RGB',(1350,850),'#20252e');draw=ImageDraw.Draw(im)
 for offset,g in enumerate(groups[start:start+25]):
  x=(offset%5)*270;y=(offset//5)*170;b=g['best'];occ=g['occurrences'][0]
  draw.text((x+6,y+5),f"#{g['reviewId']} {b['part']} c{b['color']} {b['colorName'][:16]}",font=font,fill='white')
  draw.text((x+6,y+23),f"p{occ['page']} s{occ['step']} score {b['score']:.3f} gap {g['margin']:.3f}",font=small,fill='#b5c8dd')
  for j,p in enumerate([g['image'],b['image']]):
   src=Image.open(OUT/p).convert('RGB');src.thumbnail((124,110),Image.Resampling.NEAREST);im.paste(src,(x+8+j*130+(124-src.width)//2,y+44+(110-src.height)//2))
  draw.text((x+6,y+155),f"{g['key'][:8]} -> {b['element']}",font=small,fill='#aabccc')
 im.save(OUT/f'review/sheet-{start//25+1:02d}.png')
print(len(groups),'groups',math.ceil(len(groups)/25),'sheets')
