// Canvas HTML, made safe and at home in the app. Sanitized (no scripts, forms, embeds or
// inline styles, which fight the app's theme); links to course files open the local copy,
// links to the course's pages / assignments / announcements open them here, links to
// external tools open the tool signed in, anything else opens in the browser; images that
// need the Canvas login are fetched by the backend.
import DOMPurify from "dompurify";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { t } from "../lib/i18n";
import { type Thing, view } from "../lib/things";
import { ThingsContext } from "./Things";

const COURSE_PATH = /^\/courses\/(\d+)\/(pages|assignments|discussion_topics|announcements|modules)(?:\/([^/?#]+))?/;
const FILE_PATH = /^(?:\/courses\/(\d+))?\/files\/(\d+)/;
const TOOL_PATH = /^\/courses\/(\d+)\/(?:external_tools\/(\d+|retrieve)|modules\/items\/(\d+))\/?$/;

function prepare(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Embedded players and frames can't run here; offer them as links instead.
  doc.querySelectorAll("iframe, video, audio, object, embed").forEach((el) => {
    const src = el.getAttribute("src") || el.querySelector("source")?.getAttribute("src") || el.getAttribute("data");
    const a = doc.createElement("a");
    a.textContent = t("▶ 嵌入的内容（在浏览器中打开）");
    if (src) a.setAttribute("href", src);
    el.replaceWith(a);
  });
  // Images load through the backend (CSP blocks the rest of the web, and Canvas needs a login).
  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    img.removeAttribute("src");
    img.removeAttribute("srcset");
    if (src) img.setAttribute("data-src", src);
  });
  return DOMPurify.sanitize(doc.body.innerHTML, {
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "link", "meta"],
    FORBID_ATTR: ["style", "target"],
    ADD_ATTR: ["data-src"],
  });
}

export function RichText({ html, files, className = "" }: {
  html: string;
  files: Record<string, { path: string; name: string }>;
  className?: string;
}) {
  const things = useContext(ThingsContext);
  const box = useRef<HTMLDivElement>(null);
  const safe = useMemo(() => prepare(html), [html]);
  const [site, setSite] = useState<string | null>(null);
  useEffect(() => void api.canvasSite().then(setSite, () => {}), []);

  // Fill in images once the HTML is in place.
  useEffect(() => {
    const urls: string[] = [];
    box.current?.querySelectorAll<HTMLImageElement>("img[data-src]").forEach((img) => {
      const src = img.dataset.src!;
      if (src.startsWith("data:")) {
        img.src = src;
        return;
      }
      void api.media(src).then((url) => {
        if (url) {
          urls.push(url);
          img.src = url;
        } else {
          img.alt = img.alt || t("（图片无法加载）");
        }
      });
    });
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [safe]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    let url: URL;
    try {
      url = new URL(href, site ?? "https://canvas.invalid");
    } catch {
      return;
    }
    if (url.protocol === "mailto:") return void api.openExternal(href);
    const onCanvas = site !== null && url.origin === new URL(site).origin;
    if (!onCanvas) return void api.openExternal(url.href);

    const file = url.pathname.match(FILE_PATH);
    if (file) {
      const local = files[file[2]];
      return void (local ? api.openPath(local.path) : api.openUrl(url.pathname + url.search));
    }
    // An external tool (or a module item, which may be one; if not, Canvas shows it).
    const tool = url.pathname.match(TOOL_PATH);
    if (tool) {
      const [, course, id, item] = tool;
      const target = item ? { module_item_id: Number(item) }
        : id !== "retrieve" ? { tool_id: Number(id) }
          : url.searchParams.get("url") ? { url: url.searchParams.get("url")! } : null;
      if (target) return void api.launch(Number(course), target);
    }
    // A page, assignment, announcement or module of a course we have: shown here.
    const m = url.pathname.match(COURSE_PATH);
    if (m && things) {
      const [, c, what, id] = m;
      const course = Number(c);
      const doc = (kind: "page" | "assignment" | "announcement", i: string): Thing => ({ type: "doc", course, kind, id: i });
      const to: Thing | null = what === "assignments" && id === "syllabus" ? view(course, "syllabus")
        : what === "modules" ? (id === "items" ? null : id ? { type: "module", course, module: Number(id) } : view(course, "modules"))
          : what === "pages" ? (id ? doc("page", decodeURIComponent(id)) : view(course, "pages"))
            : what === "assignments" ? (id ? doc("assignment", id) : view(course, "assignments"))
              : id ? doc("announcement", id) : view(course, "announcements");
      if (to && things.courses.some((x) => x.id === course)) return things.open(to);
    }
    void api.openUrl(url.pathname + url.search);
  };

  return (
    <div
      ref={box}
      onClick={onClick}
      className={`prose prose-sm prose-neutral dark:prose-invert max-w-none selectable prose-a:text-accent prose-img:rounded ${className}`}
      // Sanitized above.
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
