"""Compile visually reviewed booklet artwork into a source-backed, step-wise parts manifest.

No similarity score is promoted into a verification: every artwork group must have an
explicit identification in the review file. PBG inventory aliases and quantities are
checked independently of the image matcher.
"""
from __future__ import annotations
from collections import Counter, defaultdict
import re


def parse_pbg(text: str) -> Counter:
    inventory = Counter()
    in_items = False
    for line in text.splitlines():
        line = line.strip()
        if line == '<items>':
            in_items = True
            continue
        if not in_items or not line or line.startswith(('#', ';')):
            continue
        match = re.match(r'([^:]+)\.dat:(.*)$', line, re.I)
        if not match:
            raise ValueError(f'Unrecognised PBG item: {line}')
        fields = dict(re.findall(r'\[([^=\]]+)=([^\]]+)\]', match[2]))
        if fields.get('sourceInv', 'parts') != 'parts':
            continue
        colour, quantity = int(fields['color']), int(fields['count'])
        if quantity <= 0:
            raise ValueError('Inventory quantities must be positive')
        inventory[(match[1].lower(), colour)] += quantity
    if not inventory:
        raise ValueError('No main inventory items in PBG')
    return inventory


def inventory_identity(record: dict, inventory: Counter, catalog: list[dict] = ()) -> tuple[str, int]:
    colour = record.get('color')
    aliases = {str(p).lower().removesuffix('.dat') for p in [record.get('part'), record.get('ldrawPart'), *(record.get('ldrawAll') or [])] if p}
    # Historical element IDs can have a newer preferred LDraw filename in the set export.
    for other in catalog:
        if other.get('color') == colour and other.get('part') == record.get('part'):
            aliases.update(str(p).lower().removesuffix('.dat') for p in [other.get('ldrawPart'), *(other.get('ldrawAll') or [])] if p)
    candidates = [key for key in inventory if key[1] == colour and key[0] in aliases]
    if len(candidates) != 1:
        raise ValueError(f'Element {record.get("element")}: expected one inventory identity, got {candidates}')
    return candidates[0]


def compile_manifest(audit: dict, review: dict, inventory: Counter, catalog: list[dict]) -> dict:
    if audit['pdfSha256'] != review['pdfSha256'] or (audit['set'], audit['book']) != (review['set'], review['book']):
        raise ValueError('Review belongs to a different source booklet')
    groups = {g['key']: g for g in audit['groups']}
    if groups.keys() != review['identifications'].keys():
        raise ValueError('Every artwork group needs an explicit review, with no stale groups')
    printed = {r['element']: r for r in audit['inventory']}
    printed_inventory = Counter()
    for item in printed.values():
        printed_inventory[inventory_identity(item['catalog'], inventory, catalog)] += item['setQuantity']
    if printed_inventory != inventory:
        raise ValueError('Printed inventory and PBG disagree after documented catalog aliases')
    api_inventory = Counter()
    for item in catalog:
        if not item.get('spare'):
            api_inventory[inventory_identity(item, inventory, catalog)] += item['quantity']
    if api_inventory != inventory:
        raise ValueError('Current Rebrickable inventory and supplied PBG disagree')
    totals, steps, quantities = Counter(), [], 0
    source_labels = set()
    for expected_index, source in enumerate(audit['steps'], 1):
        if source['index'] != expected_index:
            raise ValueError('Step indices must be contiguous')
        if source.get('issues'):
            raise ValueError(f'Step {expected_index} has unresolved extraction issues')
        items = {}
        for callout in source['parts']:
            quantity = callout['quantity']
            if type(quantity) is not int or quantity <= 0 or not callout.get('countBox'):
                raise ValueError(f'Step {expected_index} has an unresolved quantity')
            if abs(callout['countBox'][0] - callout['box'][0]) > 3:
                raise ValueError(f'Step {expected_index}: quantity label does not align with its part artwork')
            label = (source['page'], *callout['countBox'])
            if label in source_labels:
                raise ValueError('A printed quantity label was consumed more than once')
            source_labels.add(label)
            identified = review['identifications'][callout['group']]
            element = identified['element']
            if element not in printed:
                raise ValueError(f'Element {element} absent from printed inventory')
            entry = printed[element]
            record = entry['catalog']
            part, colour = inventory_identity(record, inventory, catalog)
            item = items.setdefault(element, {'elementId': element, 'partId': part,
                'rebrickablePartId': record['part'], 'ldrawPartId': record['ldrawPart'], 'ldrawAliases': sorted({part, record['ldrawPart'], *(record.get('ldrawAll') or [])}),
                'colorId': colour, 'colorName': record['colorName'], 'quantity': 0,
                'inventoryImage': entry['image'], 'evidence': []})
            item['quantity'] += quantity
            item['evidence'].append({'artworkGroup': callout['group'], 'calloutImage': groups[callout['group']]['image'],
                'partBox': callout['box'], 'countBox': callout['countBox'], 'quantity': quantity,
                'sourceAsset': groups[callout['group']]['sourceAsset']})
            totals[(part, colour)] += quantity
            quantities += 1
        steps.append({'index': source['index'], 'sequence': source['section'], 'number': source['step'], 'page': source['page'],
            'key': f"book{audit['book']}:sequence{source['section']}:step{source['step']}",
            'totalPieces': sum(i['quantity'] for i in items.values()), 'assemblyOnly': not items,
            'parts': list(items.values()), 'calloutBoxes': source.get('calloutBoxes', [])})
    overused = {key: count for key, count in totals.items() if count > inventory[key]}
    if overused:
        raise ValueError(f'Booklet uses more than the complete set inventory: {overused}')
    sequences = defaultdict(list)
    for step in steps:
        sequences[step['sequence']].append(step['number'])
    if any(values != list(range(1, len(values) + 1)) for values in sequences.values()):
        raise ValueError('A numbering sequence has missing or duplicate steps')
    return {'format': 'booklet-step-parts-v1', 'set': audit['set'], 'book': audit['book'],
        'status': 'source-artwork-reviewed',
        'quantityBasis': 'Counts printed in main step parts boxes; illustrated subassembly repeat annotations are not multiplied again.',
        'sources': {'bookletPdf': audit['pdf'], 'bookletSha256': audit['pdfSha256'],
            'printedInventory': audit['sourceInventory'], 'rebrickableInventory': 'https://rebrickable.com/sets/21065-1/sagrada-familia/#parts'},
        'verification': {'stepGroups': len(steps), 'numberingSequences': {str(k): len(v) for k, v in sequences.items()},
            'reviewedArtworkGroups': len(groups), 'quantityLabels': quantities, 'unresolvedIdentities': 0, 'unresolvedQuantities': 0,
            'assemblyOnlySteps': sum(s['assemblyOnly'] for s in steps),
            'printedInventoryMatchesPbg': True, 'rebrickableInventoryMatchesPbg': True, 'bookWithinSetInventory': True,
            'wholeSetPartColorEntries': len(inventory), 'wholeSetPieces': sum(inventory.values()),
            'bookPartColorEntries': len(totals), 'bookPieces': sum(totals.values())},
        'steps': steps, 'totals': [{'partId': part, 'colorId': colour, 'quantity': count,
            'setQuantity': inventory[(part, colour)], 'remainingForOtherBooks': inventory[(part, colour)] - count}
            for (part, colour), count in sorted(totals.items())]}
