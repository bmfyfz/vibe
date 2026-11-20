import type { Message } from "@vibe/sdk";
import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { MENTION_SCHEME, withMentions } from "../lib/text.ts";

/**
 * A message's text, read as Markdown. What people and agents write is never
 * trusted as HTML: the renderer builds elements from the Markdown and drops
 * any HTML in it. A picture in the text is shown as a link to it, since the
 * page loads nothing from other sites.
 */
export const Markdown = memo(function Markdown({
  message,
}: {
  message: Pick<Message, "text" | "mentions">;
}) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // The page's own mention links pass. Everything else goes through the
        // renderer's check, which lets through http, https, mailto and the like.
        urlTransform={(url) => (url.startsWith(MENTION_SCHEME) ? url : defaultUrlTransform(url))}
        components={{
          a({ href, children }) {
            if (href?.startsWith(MENTION_SCHEME))
              return <span className="mention">{children}</span>;
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            const label = alt || "picture";
            return typeof src === "string" && src !== "" ? (
              <a href={src} target="_blank" rel="noreferrer noopener">
                {label}
              </a>
            ) : (
              <span>{label}</span>
            );
          },
          // A long table or a long line of code scrolls in its own box, not the page.
          table({ children }) {
            return (
              <div className="prose-scroll">
                <table>{children}</table>
              </div>
            );
          },
        }}
      >
        {withMentions(message)}
      </ReactMarkdown>
    </div>
  );
});
