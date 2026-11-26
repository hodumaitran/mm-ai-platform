'use client';

import { useState, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../lib/markdown.ts';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = 'Sao chép' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const onClick = async (): Promise<void> => {
    setState((await copyText(text)) ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 1800);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-slate-400"
    >
      {state === 'copied' ? 'Đã sao chép' : state === 'failed' ? 'Không sao chép được' : label}
    </button>
  );
}

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.t) {
      case 'text':
        return node.v;
      case 'code':
        return (
          <code key={index} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em]">
            {node.v}
          </code>
        );
      case 'strong':
        return <strong key={index}>{renderInline(node.c)}</strong>;
      case 'em':
        return <em key={index}>{renderInline(node.c)}</em>;
      case 'link':
        return (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-blue-700 underline underline-offset-2"
          >
            {renderInline(node.c)}
          </a>
        );
    }
  });
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.t) {
    case 'p':
      return (
        <p key={index} className="whitespace-pre-wrap">
          {renderInline(block.c)}
        </p>
      );
    case 'h':
      return (
        <p key={index} className={block.level <= 2 ? 'text-base font-semibold' : 'font-semibold'}>
          {renderInline(block.c)}
        </p>
      );
    case 'code':
      return (
        <div key={index} className="overflow-hidden rounded-md border border-slate-200">
          <div className="flex items-center justify-between bg-slate-100 px-3 py-1">
            <span className="font-mono text-xs text-slate-500">{block.lang || 'văn bản'}</span>
            <CopyButton text={block.v} label="Sao chép mã" />
          </div>
          <pre className="overflow-x-auto bg-slate-50 p-3 font-mono text-[13px] leading-5">
            <code>{block.v}</code>
          </pre>
        </div>
      );
    case 'ul':
      return (
        <ul key={index} className="list-disc space-y-1 pl-6">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={index} className="list-decimal space-y-1 pl-6">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote
          key={index}
          className="border-l-2 border-slate-300 pl-3 whitespace-pre-wrap text-slate-600"
        >
          {renderInline(block.c)}
        </blockquote>
      );
    case 'hr':
      return <hr key={index} className="border-slate-200" />;
  }
}

/** Renders model output as React elements only; raw HTML in the text is shown literally. */
export function Markdown({ text }: { text: string }) {
  return <div className="space-y-3 break-words">{parseMarkdown(text).map(renderBlock)}</div>;
}
