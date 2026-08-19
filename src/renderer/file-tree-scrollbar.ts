// The tree's scrollbar, drawn as an ordinary element over the rows. A native
// one would take its width out of the tree's content box, which is where
// Chromium clips the content: a row's hover band would stop a bar's width
// short of the editor edge. Floating the thumb instead leaves the rows the
// full width, and is what VS Code's explorer does with its own.

// a thumb this short is still something to grab, however long the tree is
const MIN_THUMB_HEIGHT_PX = 24;

type FileTreeScrollbarOptions = {
  treeElement: HTMLElement; // the box that scrolls
  contentElement: HTMLElement; // the rows inside it, however many there are
  thumbElement: HTMLElement;
};

// Returns the way to take it all down again, for the caller's effect.
export function mountFileTreeScrollbar({
  treeElement,
  contentElement,
  thumbElement,
}: FileTreeScrollbarOptions): () => void {
  function drawThumb(): void {
    const visibleHeight = treeElement.clientHeight;
    const scrollableHeight = treeElement.scrollHeight - visibleHeight;
    if (scrollableHeight <= 0) {
      thumbElement.classList.add("hidden");
      return;
    }
    const thumbHeight = Math.max(
      MIN_THUMB_HEIGHT_PX,
      Math.round((visibleHeight * visibleHeight) / treeElement.scrollHeight),
    );
    // the thumb travels the tree's height less its own, so at the end of the
    // scroll its bottom lands on the tree's bottom rather than past it
    const travel = visibleHeight - thumbHeight;
    thumbElement.style.height = `${thumbHeight}px`;
    thumbElement.style.transform = `translateY(${Math.round(
      (treeElement.scrollTop / scrollableHeight) * travel,
    )}px)`;
    thumbElement.classList.remove("hidden");
  }

  // where the drag started, in the two units it has to hold together: the
  // pointer's and the tree's
  let dragStartY = 0;
  let dragStartScrollTop = 0;

  function dragThumb(event: MouseEvent): void {
    const visibleHeight = treeElement.clientHeight;
    const travel = visibleHeight - thumbElement.getBoundingClientRect().height;
    if (travel <= 0) {
      return;
    }
    treeElement.scrollTop =
      dragStartScrollTop +
      ((event.clientY - dragStartY) / travel) *
        (treeElement.scrollHeight - visibleHeight);
  }

  function endDrag(): void {
    document.removeEventListener("mousemove", dragThumb, true);
    document.removeEventListener("mouseup", endDrag, true);
    thumbElement.classList.remove("dragging");
  }

  function startDrag(event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }
    // no text selection under the cursor for the length of the drag
    event.preventDefault();
    // grabbing the bar is not working in the editor: the keyboard stays where
    // it was, the way the resize handle beside it behaves
    event.stopPropagation();
    dragStartY = event.clientY;
    dragStartScrollTop = treeElement.scrollTop;
    thumbElement.classList.add("dragging");
    // on the document, in the capture phase: the pointer spends the drag over
    // the rows and Monaco, both of which handle mouse events themselves
    document.addEventListener("mousemove", dragThumb, true);
    document.addEventListener("mouseup", endDrag, true);
  }

  thumbElement.addEventListener("mousedown", startDrag);
  treeElement.addEventListener("scroll", drawThumb);
  // Both heights the thumb is a ratio of: what the tree can show, which the
  // window and the resize handle change, and what it has to show, which every
  // expand, collapse and reload changes. Watching the rows' box rather than
  // the writes that produce it keeps this out of React's way.
  const observer = new ResizeObserver(drawThumb);
  observer.observe(treeElement);
  observer.observe(contentElement);
  drawThumb();

  return () => {
    observer.disconnect();
    treeElement.removeEventListener("scroll", drawThumb);
    thumbElement.removeEventListener("mousedown", startDrag);
  };
}
