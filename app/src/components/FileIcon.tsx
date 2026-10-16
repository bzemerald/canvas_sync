import {
  File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Presentation,
  type LucideIcon,
} from "lucide-react";

type Family = { icon: LucideIcon; color: string };

const FAMILIES: [string[], Family][] = [
  [["pdf"], { icon: FileText, color: "text-type-pdf" }],
  [["doc", "docx", "rtf", "odt", "pages"], { icon: FileText, color: "text-type-doc" }],
  [["ppt", "pptx", "key", "odp"], { icon: Presentation, color: "text-type-slides" }],
  [["xls", "xlsx", "csv", "tsv", "numbers", "ods"], { icon: FileSpreadsheet, color: "text-type-sheet" }],
  [["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg", "heic"], { icon: FileImage, color: "text-type-image" }],
  [["mp4", "mov", "mkv", "avi", "webm", "m4v"], { icon: FileVideo, color: "text-type-media" }],
  [["mp3", "wav", "m4a", "flac", "ogg"], { icon: FileAudio, color: "text-type-media" }],
  [["zip", "tar", "gz", "tgz", "rar", "7z"], { icon: FileArchive, color: "text-muted" }],
  [
    ["py", "ipynb", "java", "c", "h", "cpp", "hpp", "js", "ts", "r", "m", "jl", "rs", "go", "sql", "sh", "scm", "rkt", "html", "json", "yaml", "yml", "tex"],
    { icon: FileCode, color: "text-type-code" },
  ],
  [["txt", "md", "markdown"], { icon: FileText, color: "text-muted" }],
];

const BY_EXT = new Map(FAMILIES.flatMap(([exts, fam]) => exts.map((e) => [e, fam] as const)));

export function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function FileIcon({ name, dir = false, className = "size-4" }: { name: string; dir?: boolean; className?: string }) {
  if (dir) return <Folder className={`${className} shrink-0 fill-current text-type-folder`} aria-hidden />;
  const { icon: Icon, color } = BY_EXT.get(extension(name)) ?? { icon: File, color: "text-muted" };
  return <Icon className={`${className} shrink-0 ${color}`} aria-hidden />;
}

const THUMBABLE = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"]);
export const hasThumbnail = (name: string) => THUMBABLE.has(extension(name));
