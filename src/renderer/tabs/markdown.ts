import { currentTheme, getSettings } from "../settings.ts";
import DOMPurify from "dompurify";
import markdownit from "markdown-it";
import mermaid from "mermaid";
// The common languages, which is every one worth having in a fence; the
// package's own entry registers all two hundred it ships.
import hljs from "highlight.js/lib/common";

const parser = new markdownit({
  html: true,
  linkify: true,
  highlight: (code, language) => {
    if (language !== "" && hljs.getLanguage(language) !== undefined) {
      return hljs.highlight(code, { language }).value;
    }
    return "";
  },
});

export type MarkdownRender = {
  view: HTMLElement;
  // Diagrams arrive after the text, and a drawn one is taller than the
  // fence it replaces: anything that measures the document (restoring a
  // scroll position) has to wait for this.
  ready: Promise<void>;
};

export function renderMarkdown(markdown: string): MarkdownRender {
  const view = document.createElement("article");
  view.className = "markdown-view";
  view.innerHTML = DOMPurify.sanitize(parser.render(markdown));
  renderTaskLists(view);
  return {
    view,
    ready: renderMermaidDiagrams(view),
  };
}

// GFM task lists: "[ ] " → disabled checkbox, styled in style.css
function renderTaskLists(view: HTMLElement): void {
  for (const item of view.querySelectorAll("li")) {
    let textNode = item.firstChild;
    if (textNode instanceof HTMLParagraphElement) {
      textNode = textNode.firstChild;
    }
    if (textNode === null || textNode.nodeType !== Node.TEXT_NODE) {
      continue;
    }
    const text = textNode.textContent;
    if (text === null) {
      continue;
    }
    let checked = false;
    if (text.startsWith("[x] ") || text.startsWith("[X] ")) {
      checked = true;
    } else if (!text.startsWith("[ ] ")) {
      continue;
    }
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.disabled = true;
    checkbox.checked = checked;
    checkbox.className = "task-list-item-checkbox";
    textNode.textContent = " " + text.slice(4);
    textNode.parentNode?.insertBefore(checkbox, textNode);
    item.classList.add("task-list-item");
    item.parentElement?.classList.add("contains-task-list");
  }
}

let diagramId = 0;

// Mermaid draws a diagram into a scratch element and hands back the SVG as
// text. Given no element it appends its own to <body> — which is the app's
// flex column, so every diagram it draws takes a row of its own down there
// and squeezes the workbench for as long as the drawing lasts. Ours is out
// of the flow and off screen, but still laid out: mermaid measures the text
// it draws, and a display: none box measures nothing.
const diagramHost = document.createElement("div");
diagramHost.style.position = "absolute";
diagramHost.style.top = "0";
diagramHost.style.left = "-10000px";
// the width diagrams were drawn at when the body was the host
diagramHost.style.width = "100%";
document.body.append(diagramHost);

async function renderMermaidDiagrams(view: HTMLElement): Promise<void> {
  const fences = view.querySelectorAll("code.language-mermaid");
  if (fences.length === 0) {
    return;
  }
  const theme = currentTheme();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    // the host element's font, which mermaid sets from this and not from
    // the themeVariables below
    fontFamily: getSettings().markdownFontFamily,
    themeVariables: {
      darkMode: theme.colorScheme === "dark",
      background: theme.background,
      primaryColor: theme.tabBarBackground,
      primaryTextColor: theme.tabActiveForeground,
      primaryBorderColor: theme.separator,
      secondaryColor: theme.tabBarBackground,
      tertiaryColor: theme.background,
      lineColor: theme.tabForeground,
      edgeLabelBackground: theme.background,
      // ER rows derive toward black unless mapped
      rowOdd: theme.background,
      rowEven: theme.tabBarBackground,
      attributeBackgroundColorOdd: theme.background,
      attributeBackgroundColorEven: theme.tabBarBackground,
      noteBkgColor: theme.tabBarBackground,
      noteTextColor: theme.tabActiveForeground,
      fontFamily: getSettings().markdownFontFamily,
    },
  });
  for (const fence of fences) {
    const source = fence.textContent;
    const pre = fence.closest("pre");
    if (source === null || pre === null) {
      continue;
    }
    const elementId = `mermaid-diagram-${diagramId++}`;
    try {
      const { svg } = await mermaid.render(elementId, source, diagramHost);
      const diagram = document.createElement("div");
      diagram.className = "mermaid-diagram";
      diagram.innerHTML = svg;
      pre.replaceWith(diagram);
    } catch {
      document.getElementById(elementId)?.remove();
    }
  }
}
