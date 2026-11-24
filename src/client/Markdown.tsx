/**
 * An assistant reply's markdown as React elements (COD-190), from the parse shared with Telegram (`src/lib/markdown.ts`).
 * React escapes every string, so text in a reply (HTML, a script tag) shows as text and never becomes markup. Links
 * are http(s) only, open in a new tab, and carry no referrer.
 */
import { Fragment, type ReactNode } from "react";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown.ts";

function InlineNodes({ nodes }: { readonly nodes: readonly Inline[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "link":
        return (
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer">
            <InlineNodes nodes={node.children} />
          </a>
        );
      case "strong":
        return (
          <strong key={index}>
            <InlineNodes nodes={node.children} />
          </strong>
        );
      case "em":
        return (
          <em key={index}>
            <InlineNodes nodes={node.children} />
          </em>
        );
      case "strike":
        return (
          <s key={index}>
            <InlineNodes nodes={node.children} />
          </s>
        );
      default: {
        const _: never = node;
        throw new Error("Unknown inline node");
      }
    }
  });
}

function BlockNode({ block }: { readonly block: Block }): ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <p>
          {block.lines.map((line, index) => (
            <Fragment key={index}>
              {index === 0 ? null : <br />}
              <InlineNodes nodes={line} />
            </Fragment>
          ))}
        </p>
      );
    case "heading": {
      const Heading = `h${block.level}` as const;
      return (
        <Heading>
          <InlineNodes nodes={block.children} />
        </Heading>
      );
    }
    case "code":
      return (
        <pre>
          <code className={block.language === undefined ? undefined : `language-${block.language}`}>
            {block.text}
          </code>
        </pre>
      );
    case "quote":
      return (
        <blockquote>
          <Blocks blocks={block.blocks} />
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <InlineNodes nodes={item} />
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start === 1 ? undefined : block.start}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case "rule":
      return <hr />;
    default: {
      const _: never = block;
      throw new Error("Unknown markdown block");
    }
  }
}

function Blocks({ blocks }: { readonly blocks: readonly Block[] }): ReactNode {
  return blocks.map((block, index) => <BlockNode key={index} block={block} />);
}

/** A reply's markdown, formatted. */
export function Markdown({ text }: { readonly text: string }) {
  return (
    <div className="markdown">
      <Blocks blocks={parseMarkdown(text)} />
    </div>
  );
}
