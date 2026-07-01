/**
 * Split an assistant turn's content blocks into ordered prose segments.
 *
 * A single turn can interleave prose and tool calls — "msgA → [tool] → msgB →
 * [tool] → msgC". The membrane accumulates the WHOLE turn (all tool rounds) into
 * one `response.content` array in provider order, so a left-to-right walk that
 * breaks at each tool boundary reconstructs the emission order.
 *
 * Host output routing used to join every text block into a single trailing post,
 * collapsing those distinct messages into one (item 4). This helper instead
 * yields each contiguous run of text — the segments a surface should deliver as
 * separate, ordered messages. Contiguous text blocks merge into one segment;
 * `tool_use` / `tool_result` blocks are segment boundaries; empty or
 * whitespace-only runs are dropped.
 */

import type { ContentBlock } from '@animalabs/membrane';

export function splitProseSegments(content: readonly ContentBlock[]): string[] {
  const segments: string[] = [];
  let buf: string[] = [];

  const flush = (): void => {
    const s = buf.join('\n').trim();
    if (s) segments.push(s);
    buf = [];
  };

  for (const block of content) {
    if (block.type === 'text') {
      buf.push((block as ContentBlock & { type: 'text' }).text);
    } else if (block.type === 'tool_use' || block.type === 'tool_result') {
      flush();
    }
    // Other block types (thinking, redacted_thinking, image, …) are neither
    // prose nor boundaries: they don't reach a channel and don't separate two
    // prose messages, so they're skipped without flushing.
  }
  flush();

  return segments;
}
