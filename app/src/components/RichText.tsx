// Canvas HTML, made safe and at home in the app. Sanitized (no scripts, forms, embeds or
// inline styles, which fight the app's theme); links to course files open the local copy,
// links to the course's pages / assignments / announcements open them here, anything else
// opens in the browser; images that need the Canvas login are fetched by the backend.
import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";

export type CourseLink = { tab: "pages" | "assignments" | "announcements" | "syllabus" | "modules"; id?: string };

const COURSE_PATH = /^\/courses\/(\d+)\/(pages|assignments|discussion_topics|announcements|modules)(?:\/([^/?#]+))?/;
const FILE_PATH = /^(?:\/courses\/(\d+))?\/files\/(\d+)/;

function prepare(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Embedded players and frames can't run here; offer them as links instead.
  doc.querySelectorAll("iframe, video, audio, object, embed").forEach((el) => {
    const src = el.getAttribute("src") || el.querySelector("source")?.getAttribute("src") || el.getAttribute("data");
    const a = doc.createElement("a");
    a.textContent = "▶ 嵌入的内容（在浏览器中打开）";
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

export function RichText({ html, courseId, files, onNavigate, className = "" }: {
  html: string;
  courseId: number;
  files: Record<string, { path: string; name: string }>;
  onNavigate: (to: CourseLink) => void;
  className?: string;
}) {
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
          img.alt = img.alt || "（图片无法加载）";
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
    const m = url.pathname.match(COURSE_PATH);
    if (m && Number(m[1]) === courseId) {
      const [, , what, id] = m;
      if (what === "assignments" && id === "syllabus") return onNavigate({ tab: "syllabus" });
      if (what === "modules" && id !== "items") return onNavigate({ tab: "modules" }); // (module item links go to Canvas)
      if (what === "modules") return void api.openUrl(url.pathname + url.search);
      if (what === "pages") return onNavigate({ tab: "pages", id: id && decodeURIComponent(id) });
      if (what === "assignments") return onNavigate({ tab: "assignments", id });
      return onNavigate({ tab: "announcements", id });
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
