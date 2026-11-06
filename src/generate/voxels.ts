/**
 * A coarse shape on the stud grid: one cell per stud across (x, z) and per plate up (y),
 * each empty or an LDraw colour number. This is what a generator sketches and what
 * brickify turns into real bricks. A plate is 8 LDU and a stud 20 LDU, so a cube of
 * n studs is 2.5·n plates tall.
 */
export class Voxels {
  private readonly cells: Int32Array;

  constructor(readonly w: number, readonly d: number, readonly h: number) {
    this.cells = new Int32Array(w * d * h).fill(-1);
  }

  /** Build from a function of the cell: a colour, or null for empty. */
  static from(w: number, d: number, h: number, f: (x: number, y: number, z: number) => number | null): Voxels {
    const v = new Voxels(w, d, h);
    for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
      const c = f(x, y, z);
      if (c !== null && c >= 0) v.set(x, y, z, c);
    }
    return v;
  }

  private index(x: number, y: number, z: number): number {
    return x + this.w * (z + this.d * y);
  }

  inside(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.w && y < this.h && z < this.d;
  }

  /** The cell's colour, or −1 when empty or outside. */
  get(x: number, y: number, z: number): number {
    return this.inside(x, y, z) ? this.cells[this.index(x, y, z)] : -1;
  }

  set(x: number, y: number, z: number, color: number): void {
    if (this.inside(x, y, z)) this.cells[this.index(x, y, z)] = color;
  }

  forEach(f: (x: number, y: number, z: number, color: number) => void): void {
    for (let y = 0; y < this.h; y++) for (let z = 0; z < this.d; z++) for (let x = 0; x < this.w; x++) {
      const c = this.cells[this.index(x, y, z)];
      if (c >= 0) f(x, y, z, c);
    }
  }

  count(): number {
    let n = 0;
    for (const c of this.cells) if (c >= 0) n++;
    return n;
  }
}

/** Plates in a height of `studs` studs (2.5 plates per stud, rounded). */
export const platesFor = (studs: number) => Math.round(studs * 2.5);

/** A solid ball `diameter` studs across. */
export function sphere(diameter: number, color: number): Voxels {
  const h = platesFor(diameter);
  const r = diameter / 2;
  return Voxels.from(diameter, diameter, h, (x, y, z) => {
    const dx = x + 0.5 - r;
    const dz = z + 0.5 - r;
    const dy = (y + 0.5) / 2.5 - r; // plates to studs
    return dx * dx + dy * dy + dz * dz <= r * r ? color : null;
  });
}
