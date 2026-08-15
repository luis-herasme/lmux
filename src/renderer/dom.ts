// The page's fixed elements are in index.html; a missing id is a build mistake.
export function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`#${id} is missing from index.html`);
  }
  return element;
}

// Same, for the ids whose tag the caller depends on.
export function requireElementOfType<ElementType extends HTMLElement>(
  id: string,
  type: new () => ElementType,
): ElementType {
  const element = requireElement(id);
  if (!(element instanceof type)) {
    throw new Error(`#${id} is not a ${type.name}`);
  }
  return element;
}
