/** JSON written by the Python side (`python -m instructions_pdf`). Coordinates are PDF points. */
export type Box = [number, number, number, number];
export type CalloutPart = { crop: string; count: number; countFound: boolean; box: Box };
export type ExtractedStep = {
  page: number;
  number: number;
  section?: number;
  picture: string | null;
  pictureBox?: Box;
  callout: CalloutPart[];
  substeps: number[];
  /** "build this N times" marker of a sub-build on the step */
  repeat?: number;
};
export type InventoryEntry = { element: string; count: number; crop: string | null };
export type ExtractionDiagnostic = { page?: number; code: string; message: string };
export type Booklet = { sourceHash?: string; visualHash?: string; diagnostics?: ExtractionDiagnostic[]; rasterPages?: number[]; unparsedPages?: number[]; id: string; textHash: string; pages: number; steps: ExtractedStep[]; inventory: InventoryEntry[] };

export type Match = {
  booklet: string;
  page?: number;
  step: number;
  index: number;
  element: string | null;
  score: number;
  alternatives: { element: string; score: number }[];
};
export type Matches = {
  matches: Match[];
  overUse: { element: string; used: number; inventory: number }[];
  unused: { element: string; left: number }[];
  /** callout-to-inventory drawn-size ratio the matcher learned, or null */
  scale?: number | null;
};
