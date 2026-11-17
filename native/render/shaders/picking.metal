// Picking and selection: each piece's number, and where the selected pieces are.

fragment uint idFragment(BrickOut in [[stage_in]]) { return in.piece + 1; }  // 0 is the background

fragment float maskFragment(BrickOut in [[stage_in]]) { return 1.0; }
