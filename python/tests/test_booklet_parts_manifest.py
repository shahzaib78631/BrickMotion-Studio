from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
import pytest
from booklet_mpd.parts_manifest import compile_manifest, inventory_identity, parse_pbg


def fixture():
    record = {'element': '1234567', 'part': '3023', 'ldrawPart': '28653', 'ldrawAll': ['28653', '3023b'],
              'color': 15, 'colorName': 'White', 'quantity': 3, 'spare': False}
    callout = {'group': 'art', 'quantity': 2, 'box': [1, 1, 11, 9], 'countBox': [1, 10, 5, 12]}
    audit = {'set': '21065', 'book': 1, 'pdf': '/book.pdf', 'pdfSha256': 'source', 'sourceInventory': 'inventory.pdf',
        'groups': [{'key': 'art', 'image': 'callout.png', 'sourceAsset': {'xref': 1}}],
        'inventory': [{'element': '1234567', 'setQuantity': 3, 'catalog': record, 'image': 'inventory.png'}],
        'steps': [{'index': 1, 'section': 1, 'step': 1, 'page': 12, 'parts': [callout]},
                  {'index': 2, 'section': 1, 'step': 2, 'page': 13, 'parts': []}]}
    review = {'set': '21065', 'book': 1, 'pdfSha256': 'source', 'identifications': {'art': {'element': '1234567'}}}
    return audit, review, Counter({('3023b', 15): 3}), [record]


def test_pbg_keeps_main_parts_and_excludes_explicit_spares():
    text = '[options]\nkind=basic\n<items>\n3023b.dat:[count=2] [sourceInv=parts] [color=15]\n3023b.dat:[color=15] [count=1]\n3023b.dat:[sourceInv=spares] [color=15] [count=9]\n'
    assert parse_pbg(text) == Counter({('3023b', 15): 3})


def test_inventory_alias_is_explicit_and_preserves_supplied_id():
    a, r, inventory, catalog = fixture()
    assert inventory_identity(catalog[0], inventory) == ('3023b', 15)
    manifest = compile_manifest(a, r, inventory, catalog)
    part = manifest['steps'][0]['parts'][0]
    assert (part['partId'], part['ldrawPartId'], part['quantity']) == ('3023b', '28653', 2)
    assert manifest['steps'][1]['assemblyOnly'] is True
    assert manifest['steps'][1]['parts'] == []


def test_ambiguous_alias_is_not_guessed():
    _, _, inventory, catalog = fixture()
    inventory[('28653', 15)] = 2
    with pytest.raises(ValueError, match='expected one inventory identity'):
        inventory_identity(catalog[0], inventory)


def test_every_artwork_requires_review():
    a, r, inventory, catalog = fixture()
    r['identifications'].clear()
    with pytest.raises(ValueError, match='explicit review'):
        compile_manifest(a, r, inventory, catalog)


def test_review_must_match_source_booklet():
    a, r, inventory, catalog = fixture()
    r['pdfSha256'] = 'another-booklet'
    with pytest.raises(ValueError, match='different source'):
        compile_manifest(a, r, inventory, catalog)


def test_quantity_label_cannot_be_reused():
    a, r, inventory, catalog = fixture()
    a['steps'][0]['parts'].append(deepcopy(a['steps'][0]['parts'][0]))
    with pytest.raises(ValueError, match='more than once'):
        compile_manifest(a, r, inventory, catalog)


def test_overlapping_picture_bounds_do_not_justify_a_far_away_quantity():
    a, r, inventory, catalog = fixture()
    a['steps'][0]['parts'][0]['countBox'] = [10, 10, 14, 12]
    with pytest.raises(ValueError, match='does not align'):
        compile_manifest(a, r, inventory, catalog)


def test_book_cannot_exceed_entire_set_inventory():
    a, r, inventory, catalog = fixture()
    a['steps'][0]['parts'][0]['quantity'] = 4
    with pytest.raises(ValueError, match='more than the complete set'):
        compile_manifest(a, r, inventory, catalog)


def test_nonmatching_inventory_is_not_silently_accepted():
    a, r, inventory, catalog = fixture()
    inventory[('3023b', 15)] = 4
    with pytest.raises(ValueError, match='Printed inventory and PBG disagree'):
        compile_manifest(a, r, inventory, catalog)


def test_real_book_one_preserves_ids_colours_quantities_and_prints():
    root = Path(__file__).resolve().parents[2]
    path = root / 'public/_booklet/21065/book1-parts.json'
    if not path.exists():
        pytest.skip('Reviewed reference artifact not installed')
    manifest = json.loads(path.read_text())
    assert len(manifest['steps']) == 447
    assert sum(s['totalPieces'] for s in manifest['steps']) == 4043
    assert manifest['verification']['numberingSequences'] == {'1': 111, '2': 151, '3': 185}
    first9 = manifest['steps'][:9]
    def parts(step):
        return Counter({(p['partId'], p['colorId']): p['quantity'] for p in step['parts']})
    assert parts(first9[4]) == Counter({('11212', 0): 2, ('2445', 72): 1, ('78329', 0): 2, ('3023b', 15): 1})
    assert parts(first9[8]) == Counter({('3460', 0): 2, ('78329', 0): 3, ('3021', 72): 3})
    assert {'22385pr0149', '22385pr0166'} <= {p['partId'] for s in manifest['steps'] for p in s['parts']}
    for step in manifest['steps']:
        for part in step['parts']:
            for e in part['evidence']:
                assert abs(e['countBox'][0] - e['partBox'][0]) <= 3
