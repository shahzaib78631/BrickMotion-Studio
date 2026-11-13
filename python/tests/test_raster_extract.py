"""Raster pages, quantity panels and obscured sequence recovery regressions."""
import shutil

import numpy as np
import pymupdf
import pytest

from instructions_pdf.extract import extract_booklet
from instructions_pdf.raster import components, recover_raster_sequence


def test_components_keep_holes_and_diagonal_regions_separate():
    mask = np.array([[1,1,1,0],[1,0,1,0],[1,1,1,0],[0,0,0,1]],bool)
    assert sorted(components(mask)) == [[0,0,3,3,8],[3,3,4,4,1]]


@pytest.mark.skipif(not shutil.which('tesseract'), reason='Tesseract required for raster input')
def test_raster_booklet_keeps_panel_free_steps_and_quantity_crops(tmp_path):
    source = pymupdf.open()
    for number in range(1,4):
        p = source.new_page(width=842,height=596)
        p.insert_text((50,92),str(number),fontsize=56)
        if number != 2:
            p.draw_rect(pymupdf.Rect(100,48,240,148),fill=(.83,.93,.99))
            p.draw_rect(pymupdf.Rect(115,65,175,105),fill=(.6,.2,.1))
            p.insert_text((115,132),'2x',fontsize=14)
        p.draw_rect(pymupdf.Rect(300,250,500,400),fill=(.6,.2,.1))
    raster = pymupdf.open()
    for p in source:
        rp = raster.new_page(width=842,height=596)
        rp.insert_image(rp.rect,stream=p.get_pixmap(dpi=144).tobytes('png'))
    path=tmp_path/'raster.pdf';raster.save(path)
    b=extract_booklet(str(path),str(tmp_path/'out'))
    assert [s['number'] for s in b['steps']] == [1,2,3]
    assert b['steps'][1]['callout'] == []
    for s in (b['steps'][0],b['steps'][2]):
        assert s['callout'][0]['count'] == 2
        assert s['callout'][0]['countFound']
        assert s['callout'][0]['box'][3] < 130  # count glyph excluded
    assert b['rasterPages'] == [1,2,3]
    assert len(b['sourceHash']) == len(b['visualHash']) == 64


def test_sequence_inference_is_bounded_and_keeps_observed_label():
    steps=[{'page':p,'number':n,'source':'raster-ocr'} for p,n in [(2,1),(3,2),(4,9),(5,4),(6,5)]]
    diagnostics=[]
    recover_raster_sequence(None,steps,[1,2,3,4,5,6,7],[],diagnostics,'unused')
    assert [s['number'] for s in steps] == [1,2,3,4,5]
    assert steps[2]['observedNumber'] == 9
    assert steps[2]['numberSource'] == 'sequence-inferred'
    assert diagnostics[0]['code'] == 'inferred-step'


def test_sequence_does_not_bridge_numbering_restart():
    steps=[{'page':p,'number':n,'source':'raster-ocr'} for p,n in [(1,10),(2,11),(3,99),(4,1),(5,2)]]
    diagnostics=[]
    recover_raster_sequence(None,steps,[1,2,3,4,5],[],diagnostics,'unused')
    assert steps[2]['number']==99 and not diagnostics
