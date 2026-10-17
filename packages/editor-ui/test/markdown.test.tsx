import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeBlock, Markdown, markdownLink } from '../src/agent/Markdown.js';

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

test('assistant markdown renders headings, emphasis, nested lists, code, quotes, tables and rules', () => {
  const html = render('# Heading\n\n**Bold** and *italic* with `inline`\n\n- First\n  - Nested\n- Second\n\n1. Ordered\n2. Next\n\n```ts\nconst x = "<safe>";\n```\n\n> Quote\n\n| Name | Value |\n| --- | ---: |\n| One | 1 |\n\n---\n\n[Link](https://example.com/path "Title")');
  for (const tag of ['h1', 'strong', 'em', 'code', 'ul', 'ol', 'blockquote', 'table', 'thead', 'th', 'tbody', 'td', 'hr']) {
    assert.match(html, new RegExp(`<${tag}[ >/]`), tag);
  }
  assert.match(html, /<ul>.*<li>.*<ul>/s);
  assert.match(html, /aria-label="Copy code"/);
  assert.match(html, /<pre[^>]*tabindex="0"[^>]*><code>const x = &quot;&lt;safe&gt;&quot;;<\/code><\/pre>/);
  assert.match(html, /href="https:\/\/example.com\/path" title="Title" target="_blank" rel="noreferrer"/);
  assert.match(html, /text-align:right/);
  assert.doesNotMatch(html, /\*\*Bold\*\*|```/);
});

test('code copy writes the original code text and handles clipboard failure', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const copied: string[] = [];
  let fail = false;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { async writeText(text: string) {
    if (fail) throw new Error('Clipboard denied');
    copied.push(text);
  } } } });
  function findCopy(node: ReactNode): ReactElement<Record<string, any>> | undefined {
    for (const child of Children.toArray(node)) {
      if (!isValidElement<Record<string, any>>(child)) continue;
      if (child.props.label === 'Copy code') return child;
      const found = findCopy(child.props.children);
      if (found) return found;
    }
    return undefined;
  }
  try {
    let block!: ReactElement;
    function Probe() { block = CodeBlock({ text: '<tag>\n  literal & code' }); return block; }
    renderToStaticMarkup(<Probe />);
    const button = findCopy(block);
    assert.ok(button);
    button.props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(copied, ['<tag>\n  literal & code']);
    fail = true;
    button.props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(copied.length, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('raw HTML stays escaped text and cannot mount script, image, style, iframe or event attributes', () => {
  const html = render('<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>\n\n<style>body{display:none}</style>\n\n<iframe src="https://evil.test"></iframe>\n\n<a onclick="alert(1)" href="javascript:alert(1)">Click</a>');
  assert.doesNotMatch(html, /<(?:img|script|style|iframe|a)(?:\s|>)/i);
  assert.match(html, /&lt;img src=x onerror=/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('untrusted links allow only explicit http, https and mailto protocols, and images never fetch', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,hi', 'file:///C:/secret', 'vbscript:msgbox(1)', '//evil.test', '/local', 'java&#x73;cript:alert(1)']) {
    assert.equal(markdownLink(href), null, href);
  }
  const html = render('[bad](javascript:alert%281%29) [encoded](java&#x73;cript:alert%281%29) [data](data:text/html,hello) ![picture](https://tracking.test/a.png)');
  assert.doesNotMatch(html, /<a |<img /);
  assert.match(html, /picture/);
  assert.equal(markdownLink('https://example.com'), 'https://example.com/');
  assert.equal(markdownLink('mailto:a@example.com'), 'mailto:a@example.com');
});

test('every streaming prefix of mixed markdown remains renderable and safe', () => {
  const text = '**bold**\n\n- item\n  - nested\n\n```ts\nconst x = "<img onerror=x>";\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[link](https://example.com)\n\n<script>alert(1)</script>';
  for (let length = 0; length <= text.length; length++) {
    const html = render(text.slice(0, length));
    assert.doesNotMatch(html, /<script[ >]|<img[ >]/i, `prefix ${length}`);
  }
});
