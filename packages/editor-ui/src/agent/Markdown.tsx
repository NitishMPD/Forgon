import { createElement, useMemo, useState, type ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import { Check, Copy } from 'lucide-react';
import { IconButton } from '../primitives/primitives.js';

// Only explicit external protocols are navigable. No remote images or raw HTML are mounted.
export function markdownLink(href: string): string | null {
  try {
    const url = new URL(href);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function CodeBlock({ text, language }: { text: string; language?: string }) {
  const [copyResult, setCopyResult] = useState<{ text: string; state: 'copied' | 'failed' } | null>(null);
  const copyState = copyResult?.text === text ? copyResult.state : 'idle';
  return <div className="fg-markdown-code">
    <div className="fg-markdown-code-head"><span>{language?.split(/\s/)[0] || 'Code'}</span>
      <IconButton label="Copy code" title={copyState === 'copied' ? 'Copied' : 'Copy code'} onClick={() => {
        void Promise.resolve().then(() => navigator.clipboard.writeText(text))
          .then(() => setCopyResult({ text, state: 'copied' }), () => setCopyResult({ text, state: 'failed' }));
      }}>{copyState === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</IconButton>
    </div>
    {copyState === 'failed' ? <span role="status" className="fg-small">Could not copy. Select and copy the code below.</span> : null}
    {copyState === 'copied' ? <span role="status" className="fg-sr-only">Code copied</span> : null}
    <pre tabIndex={0} aria-label="Code block"><code>{text}</code></pre>
  </div>;
}

function renderTokens(tokens: readonly Token[]): ReactNode {
  return tokens.map((token, index) => {
    const children = 'tokens' in token && token.tokens ? renderTokens(token.tokens as Token[]) : null;
    switch (token.type) {
      case 'space': return null;
      case 'heading': return createElement(`h${(token as Tokens.Heading).depth}`, { key: index }, children);
      case 'paragraph': return <p key={index}>{children}</p>;
      case 'text': return <span key={index}>{children ?? token.text}</span>;
      case 'escape': return <span key={index}>{token.text}</span>;
      case 'html': return <span key={index}>{token.raw}</span>;
      case 'strong': return <strong key={index}>{children}</strong>;
      case 'em': return <em key={index}>{children}</em>;
      case 'del': return <del key={index}>{children}</del>;
      case 'codespan': return <code key={index}>{token.text}</code>;
      case 'code': return <CodeBlock key={index} text={token.text} language={token.lang} />;
      case 'br': return <br key={index} />;
      case 'hr': return <hr key={index} />;
      case 'blockquote': return <blockquote key={index}>{children}</blockquote>;
      case 'link': {
        const href = markdownLink(token.href);
        return href ? <a key={index} href={href} title={token.title ?? undefined} target="_blank" rel="noreferrer">{children}</a> : <span key={index}>{children}</span>;
      }
      case 'image': return <span key={index}>{token.text || 'Image'}</span>;
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item, itemIndex) => <li key={itemIndex}>
          {item.task ? <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? 'Completed task' : 'Incomplete task'} /> : null}
          {renderTokens(item.tokens)}
        </li>);
        return list.ordered ? <ol key={index} start={typeof list.start === 'number' ? list.start : undefined}>{items}</ol> : <ul key={index}>{items}</ul>;
      }
      case 'table': {
        const table = token as Tokens.Table;
        return <div key={index} className="fg-markdown-table" tabIndex={0} role="region" aria-label="Markdown table"><table>
          <thead><tr>{table.header.map((cell, i) => <th key={i} style={{ textAlign: table.align[i] ?? undefined }}>{renderTokens(cell.tokens)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} style={{ textAlign: table.align[j] ?? undefined }}>{renderTokens(cell.tokens)}</td>)}</tr>)}</tbody>
        </table></div>;
      }
      default: return <span key={index}>{token.raw}</span>;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  const content = useMemo(() => {
    try {
      return renderTokens(marked.lexer(text, { gfm: true }));
    } catch {
      // Keep an interrupted or malformed streaming response readable.
      return text;
    }
  }, [text]);
  return <div className="fg-markdown">{content}</div>;
}
