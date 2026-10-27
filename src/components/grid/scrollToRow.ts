/**
 * Scrolls a Glide grid so `row` sits near the top of the view.
 *
 * Browsers cap element heights (~33M px), far less than 50M rows × 28 px.
 * Glide works around that by mapping the real scrollTop to a virtual
 * position *proportionally* after every jump of more than 2,000 px, and
 * linearly for smaller moves. Its own `scrollTo` adds a relative delta, which
 * that mapping then misinterprets for big tables. Here we compute the real
 * scrollTop that maps to the wanted virtual position, making sure Glide sees a
 * jump large enough to use the proportional mapping.
 */
export function scrollToRow(
  scroller: HTMLElement,
  row: number,
  rowHeight: number,
  headerHeight: number,
  rowCount: number,
  /** Rows to keep above the target, so it isn't hidden under the header. */
  context = 2,
): void {
  const virtualHeight = headerHeight + rowCount * rowHeight;
  const clientHeight = scroller.clientHeight;
  const target = Math.max(0, row - context) * rowHeight;
  const fire = (top: number) => {
    scroller.scrollTop = top;
    // Glide reads scrollTop in its scroll handler; run it for each step.
    scroller.dispatchEvent(new Event("scroll"));
  };
  const realScrollable = scroller.scrollHeight - clientHeight;
  if (virtualHeight <= scroller.scrollHeight + 5 || realScrollable <= 0) {
    fire(target); // no height cap: positions are 1:1
    return;
  }
  const virtualScrollable = virtualHeight - clientHeight;
  const real = Math.min(realScrollable, (target / virtualScrollable) * realScrollable);
  if (Math.abs(real - scroller.scrollTop) <= 2000) {
    // Too small a jump for Glide to remap: hop away first.
    fire(real > realScrollable / 2 ? real - 5000 : real + 5000);
  }
  fire(real);
}
