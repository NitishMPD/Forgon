import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('desktop leaves HTML drag and drop to the editor on Windows', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const studio = config.app.windows.find((window: { label: string }) => window.label === 'studio');
  assert.ok(studio);
  // Tauri's default native handler replaces WebView2's HTML drag/drop handler.
  assert.equal(studio.dragDropEnabled, false);
});
