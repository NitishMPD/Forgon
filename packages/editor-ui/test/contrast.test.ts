import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Contrast is computed from the shipped tokens in studio.css, so a token change is tested directly.
const css = readFileSync(fileURLToPath(new URL('../src/theme/studio.css', import.meta.url)), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!match?.[1]) throw new Error(`Missing token ${name}`);
  return match[1].trim();
}

// oklch(L C h [/ alpha]) to linear sRGB, clipped to gamut. Alpha tokens are excluded from contrast checks.
function oklchToLinearSrgb(value: string): [number, number, number] {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!match) throw new Error(`Unsupported colour ${value}`);
  const L = Number(match[1]);
  const C = Number(match[2]);
  const h = (Number(match[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear: [number, number, number] = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map(channel => Math.min(1, Math.max(0, channel))) as [number, number, number];
}

// Accepts a token name from studio.css or a literal oklch() value.
function colour(nameOrValue: string): string {
  return nameOrValue.startsWith('oklch(') ? nameOrValue : token(nameOrValue);
}

function luminance(nameOrValue: string): number {
  const [r, g, b] = oklchToLinearSrgb(colour(nameOrValue));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const surfaces = ['surface-canvas', 'surface-app', 'surface-panel', 'surface-raised', 'surface-hover'];

test('primary and secondary text meet WCAG AA normal-text contrast on every surface', () => {
  for (const surface of surfaces) {
    assert.ok(contrast('text-primary', surface) >= 4.5, `text-primary on ${surface}`);
    assert.ok(contrast('text-secondary', surface) >= 4.5, `text-secondary on ${surface}`);
  }
});

test('muted helper text meets WCAG AA normal-text contrast on every surface', () => {
  for (const surface of surfaces) {
    assert.ok(contrast('text-muted', surface) >= 4.5, `text-muted on ${surface}`);
  }
});

test('status words meet normal-text contrast on panel and canvas surfaces', () => {
  for (const tone of ['state-info', 'state-success', 'state-warning', 'state-danger', 'accent']) {
    for (const surface of ['surface-canvas', 'surface-panel']) {
      assert.ok(contrast(tone, surface) >= 4.5, `${tone} on ${surface}`);
    }
  }
});

test('primary button text and danger button text meet normal-text contrast', () => {
  assert.ok(contrast('accent-fg', 'accent') >= 4.5, 'primary button label');
  assert.ok(contrast('oklch(0.15 0.01 25)', 'state-danger') >= 4.5, 'danger button label (fg-button-danger)');
  assert.ok(contrast('state-danger', 'surface-app') >= 4.5, 'danger text on app surface');
});

test('focus rings and separators meet the 3:1 non-text contrast requirement', () => {
  for (const surface of surfaces) {
    assert.ok(contrast('accent', surface) >= 3, `focus ring on ${surface}`);
  }
});

test('the token file defines every colour used by these checks', () => {
  for (const name of ['surface-canvas', 'surface-app', 'surface-panel', 'surface-raised', 'surface-hover', 'text-primary', 'text-secondary', 'text-muted', 'accent', 'accent-fg', 'accent-hover', 'state-info', 'state-success', 'state-warning', 'state-danger']) {
    assert.match(token(name), /^oklch\(/, name);
  }
});

function overrides(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return {};
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));
}

test('Light theme text meets AA and all theme/accent pairs keep readable buttons and visible focus', () => {
  for (const theme of ['dark', 'oled', 'light']) {
    for (const accent of ['ember', 'blue', 'violet', 'green', 'rose', 'amber']) {
      const tokens = { ...overrides(':root'), ...overrides(`:root[data-accent="${accent}"]`),
        ...overrides(`:root[data-theme="${theme}"]`), ...overrides(`:root[data-theme="${theme}"][data-accent="${accent}"]`) };
      const ratio = (foreground: string, background: string): number => contrast(tokens[foreground]!, tokens[background]!);
      for (const surface of surfaces) {
        for (const text of ['text-primary', 'text-secondary', 'text-muted']) {
          assert.ok(ratio(text, surface) >= 4.5, `${theme}/${accent}: ${text} on ${surface}: ${ratio(text, surface)}`);
        }
        assert.ok(ratio('accent', surface) >= 3, `${theme}/${accent}: focus on ${surface}`);
      }
      for (const state of ['state-info', 'state-success', 'state-warning', 'state-danger', 'accent']) {
        for (const surface of ['surface-canvas', 'surface-panel']) assert.ok(ratio(state, surface) >= 4.5, `${theme}/${accent}: ${state} on ${surface}`);
      }
      assert.ok(ratio('accent-fg', 'accent') >= 4.5, `${theme}/${accent}: button label`);
      assert.ok(ratio('accent-fg', 'accent-hover') >= 4.5, `${theme}/${accent}: hovered button label`);
      assert.ok(ratio('danger-fg', 'state-danger') >= 4.5, `${theme}/${accent}: danger button label`);
    }
  }
});
