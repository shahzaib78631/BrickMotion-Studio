/** Measurement-only resolver. Standard files always win. High-resolution
 * primitives are a recorded substitution, never a reason to modify app data. */
export function measurementPaths(name: string): string[] {
  return [
    `parts/${name}`, `p/${name}`, `models/${name}`, name,
    ...(!name.includes('/') ? [`p/48/${name}`] : []),
    // The local formed-sticker assemblies omit s/; the candidate retains the
    // exact basename and its header identifies Name: s\88930b01.dat.
    ...(name === '88930b01.dat' ? ['parts/s/88930b01.dat'] : []),
  ];
}
