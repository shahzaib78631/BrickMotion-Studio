/**
 * Truncated multivariate power series around 0: every coefficient up to a
 * total degree D in n variables. Used to expand the loop-closure equations at
 * the assembly pose to the order the local dimension test needs. All the
 * series we build have a zero constant term in their arguments, so sin, cos
 * and the matrix exponential are finite sums here (higher powers vanish).
 */
export class SeriesSpace {
  readonly monomials: number[][];
  readonly degree: number[];
  private readonly index = new Map<string, number>();
  /** Product table: for every pair (i, j) whose degrees add to <= D, the target k. */
  private readonly products: Int32Array;

  constructor(readonly vars: number, readonly order: number) {
    const mons: number[][] = [];
    // Every exponent vector with total degree <= order, lowest degree first.
    const build = (prefix: number[], left: number) => {
      if (prefix.length === vars) { mons.push(prefix); return; }
      for (let e = 0; e <= left; e++) build([...prefix, e], left - e);
    };
    build([], order);
    this.monomials = mons.sort((a, b) => sum(a) - sum(b));
    this.monomials.forEach((m, i) => this.index.set(m.join(','), i));
    this.degree = this.monomials.map(sum);
    const triples: number[] = [];
    for (let i = 0; i < this.monomials.length; i++) for (let j = 0; j < this.monomials.length; j++) {
      if (this.degree[i] + this.degree[j] > order) continue;
      triples.push(i, j, this.index.get(this.monomials[i].map((e, k) => e + this.monomials[j][k]).join(','))!);
    }
    this.products = Int32Array.from(triples);
  }

  get size() { return this.monomials.length; }
  indexOf(exponents: readonly number[]): number | undefined { return this.index.get(exponents.join(',')); }

  zero(): Series { return new Series(this, new Float64Array(this.size)); }
  constant(c: number): Series { const s = this.zero(); s.c[0] = c; return s; }
  /** The series of variable k (coefficient 1 on x_k). */
  variable(k: number): Series {
    const s = this.zero(), e = Array(this.vars).fill(0); e[k] = 1;
    s.c[this.indexOf(e)!] = 1;
    return s;
  }
  linear(coefficients: readonly number[]): Series {
    const s = this.zero();
    coefficients.forEach((a, k) => { if (a) { const e = Array(this.vars).fill(0); e[k] = 1; s.c[this.indexOf(e)!] = a; } });
    return s;
  }
  multiply(a: Series, b: Series): Series {
    const out = new Float64Array(this.size), t = this.products, ac = a.c, bc = b.c;
    for (let n = 0; n < t.length; n += 3) {
      const x = ac[t[n]];
      if (x === 0) continue;
      const y = bc[t[n + 1]];
      if (y !== 0) out[t[n + 2]] += x * y;
    }
    return new Series(this, out);
  }
  /** sum_n coefficients[n] * x^n for a series x with zero constant term. */
  power(x: Series, coefficients: readonly number[]): Series {
    if (Math.abs(x.c[0]) > 1e-12) throw Error('power series argument must vanish at 0');
    let out = this.constant(coefficients[0] ?? 0), p = this.constant(1);
    for (let n = 1; n < coefficients.length && n <= this.order; n++) {
      p = this.multiply(p, x);
      if (coefficients[n]) out = out.plus(p.times(coefficients[n]));
    }
    return out;
  }
}

const sum = (m: readonly number[]) => m.reduce((s, x) => s + x, 0);

export class Series {
  constructor(readonly space: SeriesSpace, readonly c: Float64Array) {}
  plus(o: Series): Series { const r = new Float64Array(this.c); for (let i = 0; i < r.length; i++) r[i] += o.c[i]; return new Series(this.space, r); }
  minus(o: Series): Series { const r = new Float64Array(this.c); for (let i = 0; i < r.length; i++) r[i] -= o.c[i]; return new Series(this.space, r); }
  times(s: number): Series { return new Series(this.space, this.c.map(x => x * s)); }
  mul(o: Series): Series { return this.space.multiply(this, o); }
  /** Largest coefficient magnitude of total degree in [from, to]. */
  size(from = 0, to = this.space.order): number {
    let m = 0;
    for (let i = 0; i < this.c.length; i++) if (this.space.degree[i] >= from && this.space.degree[i] <= to) m = Math.max(m, Math.abs(this.c[i]));
    return m;
  }
}
