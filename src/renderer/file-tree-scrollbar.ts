// The tree's scrollbar, drawn as an ordinary element over the rows. A native
// one would take its width out of the tree's content box, which is where
// Chromium clips the content: a row's hover band would stop a bar's width
// short of the editor edge. Floating the thumb instead leaves the rows the
// full width, and is what VS Code's explorer does with its own.
import { installDragSession } from "./dom.ts";

// a thumb this short is still something to grab, however long the tree is
const MIN_THUMB_HEIGHT_PX = 24;

type FileTreeScrollbarOptions = {
  treeElement: HTMLElement;
  thumbElement: HTMLElement;
};

export function mountFileTreeScrollbar({
  treeElement,
  thumbElement,
}: FileTreeScrollbarOptions): void {
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

  installDragSession({
    handleElement: thumbElement,
    // grabbing the bar is not working in the editor: the keyboard stays where
    // it was, the way the resize handle beside it behaves
    stopMousedownPropagation: true,
    markBodyResizing: false,
    onDragStart: (event) => {
      dragStartY = event.clientY;
      dragStartScrollTop = treeElement.scrollTop;
    },
    onDragMove: dragThumb,
  });

  treeElement.addEventListener("scroll", drawThumb);
  // the height the tree can show changes with the window and the resize
  // handle; the height it has to show changes with every expand, collapse
  // and reload, which arrive as rows appearing and disappearing
  new ResizeObserver(drawThumb).observe(treeElement);
  new MutationObserver(drawThumb).observe(treeElement, {
    childList: true,
    subtree: true,
  });
  drawThumb();
}
