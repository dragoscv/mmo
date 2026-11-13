// SVG path helpers for the brand generator. Absolute commands only (M L H V C Q A Z), which is what
// brand/src/marks.mjs and brand/src/lettering.json contain. Everything is normalised to M / L / C / Z.

const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

function arcToCubics(x1, y1, rx, ry, phiDeg, large, sweep, x2, y2) {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{ c: 'L', x: x2, y: y2 }];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (Boolean(large) === Boolean(sweep)) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const start = angle(1, 0, ux, uy);
  let delta = angle(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / count;
  const t = (4 / 3) * Math.tan(step / 4);
  const map = (px, py) => [cos * rx * px - sin * ry * py + cx, sin * rx * px + cos * ry * py + cy];
  const out = [];
  let a = start;
  for (let i = 0; i < count; i++) {
    const b = a + step;
    const [c1, s1, c2, s2] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
    const [X1, Y1] = map(c1 - t * s1, s1 + t * c1);
    const [X2, Y2] = map(c2 + t * s2, s2 - t * c2);
    const [X, Y] = map(c2, s2);
    out.push({ c: 'C', x1: X1, y1: Y1, x2: X2, y2: Y2, x: X, y: Y });
    a = b;
  }
  out[out.length - 1].x = x2;
  out[out.length - 1].y = y2;
  return out;
}

/** Parse path data into segments `{c:'M'|'L'|'C'|'Z', …}` (H, V, Q and A are converted). */
export function parse(d) {
  if (/[a-df-z]/.test(d) || /[ST]/.test(d)) throw new Error(`unsupported path command in: ${d}`);
  const out = [];
  const re = /([MLHVCQAZ])([^MLHVCQAZ]*)/g;
  let m;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  while ((m = re.exec(d))) {
    const c = m[1];
    const nums = (m[2].match(NUM) || []).map(Number);
    const take = (k) => {
      if (k === 0 ? nums.length : nums.length % k || nums.length === 0) throw new Error(`bad argument count for ${c} in: ${d}`);
      const rows = [];
      for (let i = 0; i < nums.length; i += k) rows.push(nums.slice(i, i + k));
      return rows;
    };
    if (c === 'M') {
      take(2).forEach(([px, py], i) => {
        out.push({ c: i ? 'L' : 'M', x: px, y: py });
        x = px;
        y = py;
        if (!i) {
          sx = px;
          sy = py;
        }
      });
    } else if (c === 'L') {
      for (const [px, py] of take(2)) {
        out.push({ c: 'L', x: px, y: py });
        x = px;
        y = py;
      }
    } else if (c === 'H') {
      for (const [px] of take(1)) {
        out.push({ c: 'L', x: px, y });
        x = px;
      }
    } else if (c === 'V') {
      for (const [py] of take(1)) {
        out.push({ c: 'L', x, y: py });
        y = py;
      }
    } else if (c === 'C') {
      for (const [x1, y1, x2, y2, px, py] of take(6)) {
        out.push({ c: 'C', x1, y1, x2, y2, x: px, y: py });
        x = px;
        y = py;
      }
    } else if (c === 'Q') {
      for (const [qx, qy, px, py] of take(4)) {
        out.push({ c: 'C', x1: x + (2 / 3) * (qx - x), y1: y + (2 / 3) * (qy - y), x2: px + (2 / 3) * (qx - px), y2: py + (2 / 3) * (qy - py), x: px, y: py });
        x = px;
        y = py;
      }
    } else if (c === 'A') {
      for (const [rx, ry, rot, large, sweep, px, py] of take(7)) {
        for (const s of arcToCubics(x, y, rx, ry, rot, large, sweep, px, py)) out.push(s);
        x = px;
        y = py;
      }
    } else {
      take(0);
      out.push({ c: 'Z' });
      x = sx;
      y = sy;
    }
  }
  if (!out.length || out[0].c !== 'M') throw new Error(`path must start with M: ${d}`);
  return out;
}

/** Apply `fn(x, y) -> [x, y]` to every point. */
export function mapPoints(segs, fn) {
  return segs.map((s) => {
    if (s.c === 'Z') return s;
    const [x, y] = fn(s.x, s.y);
    if (s.c !== 'C') return { c: s.c, x, y };
    const [x1, y1] = fn(s.x1, s.y1);
    const [x2, y2] = fn(s.x2, s.y2);
    return { c: 'C', x1, y1, x2, y2, x, y };
  });
}

const num = (v, digits) => {
  const s = Number(v).toFixed(digits);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** Segments back to path data (M / L / C / Z, absolute). */
export function format(segs, digits = 2) {
  const f = (v) => num(v, digits);
  return segs
    .map((s) => (s.c === 'Z' ? 'Z' : s.c === 'C' ? `C${f(s.x1)} ${f(s.y1)} ${f(s.x2)} ${f(s.y2)} ${f(s.x)} ${f(s.y)}` : `${s.c}${f(s.x)} ${f(s.y)}`))
    .join('');
}

const cubicAt = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/** Polyline approximation: array of sub-paths, each an array of [x, y]. */
export function flatten(segs, steps = 24) {
  const subs = [];
  let cur = null;
  let start = null;
  let x = 0;
  let y = 0;
  for (const s of segs) {
    if (s.c === 'M') {
      cur = [[s.x, s.y]];
      subs.push(cur);
      start = [s.x, s.y];
    } else if (s.c === 'L') cur.push([s.x, s.y]);
    else if (s.c === 'C') for (let i = 1; i <= steps; i++) cur.push([cubicAt(x, s.x1, s.x2, s.x, i / steps), cubicAt(y, s.y1, s.y2, s.y, i / steps)]);
    else {
      cur.push(start);
      [x, y] = start;
      continue;
    }
    x = s.x;
    y = s.y;
  }
  return subs;
}

/** Length of the path (all sub-paths). */
export function length(segs) {
  let total = 0;
  for (const sub of flatten(segs, 48)) for (let i = 1; i < sub.length; i++) total += Math.hypot(sub[i][0] - sub[i - 1][0], sub[i][1] - sub[i - 1][1]);
  return total;
}

/** Bounding box `[minX, minY, maxX, maxY]` of the path outline (no stroke). */
export function bbox(segs) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const sub of flatten(segs)) for (const [px, py] of sub) {
    b[0] = Math.min(b[0], px);
    b[1] = Math.min(b[1], py);
    b[2] = Math.max(b[2], px);
    b[3] = Math.max(b[3], py);
  }
  return b;
}

/** Rounded rectangle as path data (absolute, arcs). */
export function roundRect(x, y, w, h, r) {
  if (!r) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

/** Circle as path data (two arcs). */
export function circlePath(cx, cy, r) {
  return `M${num(cx - r, 3)} ${num(cy, 3)}A${num(r, 3)} ${num(r, 3)} 0 1 0 ${num(cx + r, 3)} ${num(cy, 3)}A${num(r, 3)} ${num(r, 3)} 0 1 0 ${num(cx - r, 3)} ${num(cy, 3)}Z`;
}
