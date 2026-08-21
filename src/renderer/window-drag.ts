// Which tab strips stand in for the title bar this window does not have.
//
// The empty stretch beside a strip's tabs (.dv-void-container) is where the
// window is grabbed, but only where a title bar would be: a group split off
// below another one carries its strip into the middle of the window, and a
// grab there has to be a grab on nothing at all.
//
// Being up there is geometry rather than structure — a maximized group
// covers the top of the grid from wherever in it the group sits — so it is
// measured, and measured again after every layout Dockview reports.
export function markWindowTopStrips(): void {
  for (const strip of document.querySelectorAll(".dv-void-container")) {
    // A hidden workspace's strips all measure zero and would all read as
    // being up there; they are measured again when the workspace is shown,
    // because showing it lays its Dockview out.
    strip.classList.toggle(
      "at-window-top",
      strip.getBoundingClientRect().top === 0,
    );
  }
}
