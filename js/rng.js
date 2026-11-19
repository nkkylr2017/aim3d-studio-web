// Ruby-exact random numbers, so the web build makes the very same folds, pillows and layouts as the
// SketchUp extension for the same seed. Ruby's Random is MT19937: a seed that fits one 32-bit word goes
// through init_genrand, a bigger one through init_by_array of its 32-bit words (low word first).
// rand -> genrand_res53; Array#shuffle(random:) -> limited_rand with a bit mask and retry (32-bit long on Windows).

const N = 624;
const M = 397;

export class RubyRandom {
  constructor(seed) {
    this.mt = new Uint32Array(N);
    this.mti = N + 1;
    let s = Math.abs(Math.trunc(Number(seed)));
    if (!Number.isFinite(s)) s = 0;
    if (s <= 0xffffffff) {
      this.initGenrand(s >>> 0);
    } else {
      const key = [];
      while (s > 0) { key.push(s % 4294967296); s = Math.floor(s / 4294967296); }
      // Ruby drops a top word of 1 (its "leading-zero guard"), then always seeds by array; measured in
      // SketchUp's Ruby 3.2.2: 2^32 -> init_by_array([0]), 2^33+5 -> init_by_array([5, 2])
      if (key[key.length - 1] === 1) key.pop();
      this.initByArray(key);
    }
  }

  initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      // 1812433253 * prev + i, in 32 bits
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  initByArray(key) {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    const len = key.length;
    for (let k = Math.max(N, len); k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= len) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
    this.mti = N;
  }

  nextUint32() {
    const mt = this.mt;
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (; kk < N - 1; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      const y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  }

  // Ruby's Random#rand with no argument: a float in [0, 1) with 53 random bits.
  rand() {
    const a = this.nextUint32() >>> 5;
    const b = this.nextUint32() >>> 6;
    return (a * 67108864 + b) * (1.0 / 9007199254740992);
  }

  // Ruby's limited_rand: an integer in 0..limit (limit < 2^32).
  limited(limit) {
    if (limit === 0) return 0;
    let mask = limit;
    mask |= mask >>> 1; mask |= mask >>> 2; mask |= mask >>> 4; mask |= mask >>> 8; mask |= mask >>> 16;
    mask >>>= 0;
    for (;;) {
      const v = (this.nextUint32() & mask) >>> 0;
      if (v <= limit) return v;
    }
  }

  // Array#shuffle(random: self), on a copy.
  shuffle(arr) {
    const a = arr.slice();
    let i = a.length;
    while (i) {
      const j = this.limited(i - 1);
      i--;
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// Zlib.crc32 of a string (UTF-8) or bytes.
export function crc32(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Ruby Float#round (half away from zero) to an integer.
export function rround(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

// Ruby's % on floats/integers: the result takes the sign of the divisor.
export function rmod(a, b) {
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}

// Ruby's <=> 0.
export function sgn(x) {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}
