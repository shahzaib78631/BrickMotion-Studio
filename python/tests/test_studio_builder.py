import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from studio_builder.source import crop, layout, pages, read_rgb, save_rgb


def test_layout_recovers_two_steps_and_quantities_without_inference():
    rgb=np.full((800,600,3),255,np.uint8)
    def word(text,box):
        return {"text":text,"box":box,"confidence":95}
    text=[word("1",[20,30,40,60]),word("2x",[160,120,180,135]),
          word("2",[20,420,40,450]),word("1x",[160,510,180,525]),
          word("99",[280,770,300,780])]
    result=layout(rgb,text)
    assert [s["number"] for s in result]==[1,2]
    assert [s["parts"][0]["count"] for s in result]==[2,1]
    assert result[0]["pictureBox"][3]<result[1]["pictureBox"][1]
    assert layout(rgb,[])==[]


def test_pdf_and_image_preserve_native_page_pixels(tmp_path):
    import pymupdf
    rgb=np.full((200,300,3),255,np.uint8)
    rgb[20:90,30:160]=(200,10,15)
    image=tmp_path/"source.png"
    save_rgb(image,rgb)
    doc=pymupdf.open()
    page=doc.new_page(width=300,height=200)
    page.insert_image(page.rect,filename=str(image))
    doc.save(tmp_path/"source.pdf")
    doc.close()
    result=pages([tmp_path/"source.pdf",image],tmp_path/"out")
    for row in result:
        assert row["pixelSHA256"]==hashlib.sha256(rgb.tobytes()).hexdigest()
        assert np.array_equal(read_rgb(tmp_path/"out"/row["image"]),rgb)
    with pytest.raises(ValueError):
        crop(rgb,[-1,0,20,20])


def test_catalog_matches_rendered_shape_and_color(tmp_path):
    from assembly_model.ldraw import load_library
    from studio_builder.build import ROOT
    from studio_builder.catalog import Catalog
    from studio_builder.demo import illustration
    lib=load_library(str(ROOT/"public/ldraw"))
    cat=Catalog(lib,["3001","3004","3020"],tmp_path)
    image=illustration(lib,[("3001",4,np.eye(4))],(112,160))
    result=cat.match(image)
    assert result[0]["part"]=="3001"
    assert result[0]["color"]==4
    assert result[0]["shapeScore"]>.85
    # Cache reload must retain all hypotheses and their ranking.
    assert Catalog(lib,["3001","3004","3020"],tmp_path).match(image)==result


def test_builder_reconstructs_raster_booklet_without_model_input(tmp_path):
    import shutil
    if not shutil.which("tesseract"):
        pytest.skip("Tesseract not installed")
    from studio_builder.demo import generate
    from studio_builder.build import run
    from booklet_mpd.solver.mepnet import parse_mpd, flatten
    source=generate(tmp_path/"source")
    result=run([source],tmp_path/"build",selected=["3001","3004","3020"])
    observations=json.loads((tmp_path/"build/observations.json").read_text())
    assert [s["number"] for s in observations["steps"]]==[1,2]
    assert [s["parts"][0]["part"] for s in observations["steps"]]==["3001","3004"]
    assert result["stepsBuilt"]==2,result
    assert result["parts"]==2
    assert result["verified"] is False
    text=(tmp_path/"build/model.mpd").read_text()
    assert text.count("0 STEP")==2
    files=parse_mpd(text)
    model=flatten(files,"studio-rebuild.ldr",np.eye(4))
    assert [(p,c) for p,c,_ in model]==[("3001",4),("3004",1)]
    # Model positions must be actual connected placements, not the callout layout.
    assert np.allclose(model[1][2][:3,3],[0,-24,-10],atol=.01)
    assert np.allclose(model[1][2][:3,1],[0,1,0])
    assert all(r["silhouetteIoU"]>.90 for r in result["rows"]),result
    assert (tmp_path/"build/comparisons/step-0002.png").is_file()


def test_corrections_reject_changed_source_and_unsafe_part_id(tmp_path):
    from assembly_model.ldraw import load_library
    from studio_builder.build import ROOT, validate
    image=np.full((100,100,3),255,np.uint8)
    save_rgb(tmp_path/"p.png",image)
    data={"format":"brickmotion-studio-observations","version":1,
          "pages":[{"image":"p.png","pixelSHA256":hashlib.sha256(image.tobytes()).hexdigest()}],
          "steps":[{"id":"step-1","number":1,"page":0,"pictureBox":[0,0,100,100],"parts":[{"box":[0,0,50,50],"count":1,"part":"../../bad","color":4}]}]}
    lib=load_library(str(ROOT/"public/ldraw"))
    with pytest.raises(ValueError,match="Unknown local part"):
        validate(data,tmp_path,lib)
    data["steps"][0]["parts"][0]["part"]="3001"
    image[0,0]=0
    save_rgb(tmp_path/"p.png",image)
    with pytest.raises(ValueError,match="pixels changed"):
        validate(data,tmp_path,lib)


def test_unsupported_repeat_stops_without_reusing_old_success(tmp_path):
    from studio_builder.build import run
    image=np.full((100,100,3),255,np.uint8)
    save_rgb(tmp_path/"page.png",image)
    data={"format":"brickmotion-studio-observations","version":1,
          "pages":[{"image":"page.png","pixelSHA256":hashlib.sha256(image.tobytes()).hexdigest()}],
          "steps":[{"id":"step-1","number":1,"page":0,"pictureBox":[0,0,100,100],"repeat":2,
                    "parts":[{"box":[0,0,50,50],"count":1,"part":"3001","color":4,"confirmed":True}]}]}
    (tmp_path/"observations.json").write_text(json.dumps(data))
    (tmp_path/"model.mpd").write_text("old-success")
    result=run([],tmp_path,observations=tmp_path/"observations.json")
    assert result["status"]=="incomplete" and result["parts"]==0
    assert result["failedFromStep"]==1
    text=(tmp_path/"model.mpd").read_text()
    assert "old-success" not in text and "INCOMPLETE" in text
