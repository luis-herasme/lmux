// The page's fixed elements are in index.html; a missing id is a build mistake.
export function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`#${id} is missing from index.html`);
  }
  return element;
}
