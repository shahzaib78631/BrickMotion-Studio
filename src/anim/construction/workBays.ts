/**
 * Naming and persistence keys for planner-generated work bays.
 *
 * A generated group ID is `<prefix>:<anchor leaf ID>`. The anchor retains its
 * nesting path (for example `i0/i5`), which is what keeps two uses of the same
 * submodel distinct. `workBayKey` therefore returns the ID unchanged; any
 * suffix-based "normalisation" would merge independent physical bays.
 */
import type { WorkBayKind } from './types';

const KINDS: Record<string, { kind: WorkBayKind; label: string }> = {
    '$upper': { kind: 'upper', label: 'Upper body' },
    '$lower': { kind: 'lower', label: 'Lower body' },
    '$head': { kind: 'head', label: 'Head module' },
    '$mechanical': { kind: 'mechanical', label: 'Mechanical preassembly' },
};

const prefixOf = (id: string): string => {
    const colon = id.indexOf(':');
    return colon < 0 ? id : id.slice(0, colon);
};

/** The subassembly kind, or undefined for authored submodels and composites. */
export function workBayKind(id: string): WorkBayKind | undefined {
    return KINDS[prefixOf(id)]?.kind;
}

/** True only for groups created by `mechanicalSubassemblies`. */
export function isGeneratedWorkBay(id: string): boolean {
    return !!KINDS[prefixOf(id)];
}

/** Exact persistence key: groups with different nesting paths stay independent. */
export function workBayKey(id: string): string {
    return id;
}

/** The group's anchor leaf ID, without the rare `$` collision suffix. */
export function workBayAnchorId(id: string): string {
    const colon = id.indexOf(':');
    return (colon < 0 ? '' : id.slice(colon + 1)).replace(/\$+$/, '');
}

/** Human label; the anchor part keeps duplicate kinds distinguishable. */
export function workBayLabel(id: string, anchorPart?: string): string {
    const base = KINDS[prefixOf(id)]?.label ?? 'Subassembly';
    return anchorPart ? `${base} · ${anchorPart}` : base;
}
