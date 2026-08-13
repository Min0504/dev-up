/** Terminal UI helpers: colors, symbols, tables (Korean-width aware). */

let colorOn = process.stdout.isTTY === true && !process.env.NO_COLOR;

export function forceColor(on: boolean): void {
  colorOn = on;
}

function wrap(code: string, s: string): string {
  return colorOn ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  bold: (s: string): string => wrap("1", s),
  dim: (s: string): string => wrap("2", s),
  red: (s: string): string => wrap("31", s),
  green: (s: string): string => wrap("32", s),
  yellow: (s: string): string => wrap("33", s),
  blue: (s: string): string => wrap("34", s),
  magenta: (s: string): string => wrap("35", s),
  cyan: (s: string): string => wrap("36", s),
  gray: (s: string): string => wrap("90", s),
};

export const sym = {
  ok: (): string => c.green("✓"),
  warn: (): string => c.yellow("⚠"),
  fail: (): string => c.red("✗"),
  dotOn: (): string => c.green("●"),
  dotHalf: (): string => c.yellow("●"),
  dotOff: (): string => c.gray("○"),
  dotErr: (): string => c.red("●"),
};

let verboseOn = false;
export function setVerbose(v: boolean): void {
  verboseOn = v;
}
export function isVerbose(): boolean {
  return verboseOn;
}

export const log = {
  info(msg: string): void {
    process.stdout.write(`${msg}\n`);
  },
  step(scope: string, msg: string): void {
    process.stdout.write(`${c.cyan(`[${scope}]`)} ${msg}\n`);
  },
  warn(msg: string): void {
    process.stdout.write(`${sym.warn()} ${msg}\n`);
  },
  error(msg: string): void {
    process.stderr.write(`${sym.fail()} ${msg}\n`);
  },
  debug(msg: string): void {
    if (verboseOn) process.stderr.write(c.gray(`· ${msg}\n`));
  },
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Approximate display width; CJK/Hangul count as 2 columns. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, symbols
      (cp >= 0x3041 && cp <= 0x33ff) || // Kana, CJK compat
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK ideographs
      (cp >= 0xa960 && cp <= 0xa97f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function padEndVisible(s: string, width: number): string {
  const pad = width - visibleWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

/** Render rows as an aligned table string. */
export function table(rows: string[][], opts?: { indent?: string; gap?: number }): string {
  const indent = opts?.indent ?? "";
  const gap = " ".repeat(opts?.gap ?? 2);
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleWidth(cell));
    });
  }
  return rows
    .map(
      (row) =>
        indent +
        row
          .map((cell, i) => (i === row.length - 1 ? cell : padEndVisible(cell, widths[i] ?? 0)))
          .join(gap)
          .trimEnd(),
    )
    .join("\n");
}

export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function shortenHome(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}
