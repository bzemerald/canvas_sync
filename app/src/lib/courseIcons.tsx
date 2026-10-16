// A course's icon: one you chose (an icon and a color, or an emoji), or one picked from its
// department ("MATH 53" gets Σ, "PHYSICS 7B" an atom), in a color of its own.
import {
  Atom, Binary, BookOpen, Bot, Brain, Briefcase, Building2, Calculator, Camera, ChartColumn, ChartLine, CircuitBoard, Code, Compass,
  Cpu, Database, Dna, Dumbbell, Feather, Film, FlaskConical, Gavel, Globe, GraduationCap, Hammer, HeartPulse, Infinity as InfinityIcon,
  Landmark, Languages, Leaf, Library, Lightbulb, type LucideIcon, Map as MapIcon, MessageCircle, Mic, Microscope, Mountain, Music,
  Network, Palette, PenLine, Pi, Puzzle, Rocket, Scale, School, Shapes, Sigma, Sprout, Stethoscope, Sun, Telescope, Theater,
  TrendingUp, Users, Waves, Wrench, Zap,
} from "lucide-react";
import type { Course } from "./api";

export const ICONS: Record<string, LucideIcon> = {
  book: BookOpen, sigma: Sigma, pi: Pi, calculator: Calculator, infinity: InfinityIcon, shapes: Shapes,
  atom: Atom, telescope: Telescope, flask: FlaskConical, dna: Dna, microscope: Microscope, leaf: Leaf, sprout: Sprout,
  brain: Brain, heart: HeartPulse, stethoscope: Stethoscope, code: Code, binary: Binary, database: Database, network: Network,
  bot: Bot, cpu: Cpu, circuit: CircuitBoard, zap: Zap, wrench: Wrench, hammer: Hammer, rocket: Rocket,
  chart: ChartColumn, "chart-line": ChartLine, trending: TrendingUp, briefcase: Briefcase, scale: Scale, gavel: Gavel,
  landmark: Landmark, building: Building2, globe: Globe, map: MapIcon, compass: Compass, mountain: Mountain, waves: Waves,
  sun: Sun, pen: PenLine, feather: Feather, library: Library, languages: Languages, message: MessageCircle, mic: Mic,
  music: Music, palette: Palette, camera: Camera, film: Film, theater: Theater, lightbulb: Lightbulb, puzzle: Puzzle,
  users: Users, dumbbell: Dumbbell, cap: GraduationCap, school: School,
};

/** Mid-tone colors that read on light and dark backgrounds alike. */
export const COLORS: Record<string, string> = {
  red: "#e5484d", orange: "#f76b15", amber: "#d39e1d", green: "#30a46c", teal: "#12a594",
  blue: "#0090ff", indigo: "#5b6fe0", purple: "#8e4ec6", pink: "#d6409f", gray: "#8b8d98",
};
const AUTO_COLORS = Object.keys(COLORS).filter((c) => c !== "gray");

// What a course's code or name says about its subject; the first that matches wins.
const SUBJECTS: [RegExp, string][] = [
  [/orientation|advising|golden bear|enrollment course|transfer edge|partysafe|\bshape\b|student training/i, "cap"],
  [/\b(MATH|STAT|STATS)\b|calculus|algebra|probabilit|discrete math|geometry/i, "sigma"],
  [/\bDATA\b|data science/i, "chart"],
  [/\bNEU\b|neuro|COGSCI|cognitive|psych/i, "brain"],
  [/\bPHYS(ICS)?\b|physics|astro/i, "atom"],
  [/\bCHEM\b|chemistry/i, "flask"],
  [/\b(MCB|INTEGBI|BIO|BIOLOGY|BIOENG)\b|biolog|molecular|cellular|genetic/i, "dna"],
  [/\b(EE|ELENG)\b|circuit|electric|signals/i, "zap"],
  [/\b(CS|COMPSCI|EECS|INFO)\b|computer|programming|software|C8\dC|\b61[ABC]\b/i, "code"],
  [/\bHIST(ORY)?\b|history/i, "landmark"],
  [/\bR[1-5][AB]\b|COLWRIT|ENGLISH|rhetoric|composition|writing|literature/i, "pen"],
  [/\bECON\b|economics|business|\bUGBA\b/i, "trending"],
  [/\bPHIL\b|philosoph|consciousness|ethics/i, "lightbulb"],
  [/\bPOL ?SCI\b|politic|government|\bLAW\b|legal/i, "scale"],
  [/MUSIC/i, "music"],
  [/\bART\b|\bARTS\b|design|drawing/i, "palette"],
  [/SPANISH|FRENCH|CHINESE|JAPANESE|GERMAN|KOREAN|ITALIAN|language|linguistic/i, "languages"],
  [/\b(ENGIN|ME|CE|MECENG|CIVENG)\b|mechanical|engineering/i, "wrench"],
  [/\bGEOG\b|geograph|\bEPS\b|earth|environment|climate/i, "globe"],
  [/\bPUB ?HLTH\b|health|medic|nursing/i, "stethoscope"],
  [/\b(PE|KINES)\b|fitness|sport/i, "dumbbell"],
  [/film|media studies/i, "film"],
];

export type IconChoice = { icon: string; color: string } | { emoji: string } | { none: true };

/** What a course shows: what you chose, else a guess from its subject in its own color. */
export function iconFor(course: Pick<Course, "id" | "code" | "name" | "display_code"> & { icon?: Course["icon"] }): IconChoice {
  const chosen = course.icon;
  if (chosen?.emoji) return { emoji: chosen.emoji };
  if (chosen?.icon === "none") return { none: true };
  const text = `${course.display_code} ${course.code} ${course.name}`;
  const icon = chosen?.icon && ICONS[chosen.icon] ? chosen.icon : SUBJECTS.find(([re]) => re.test(text))?.[1] ?? "book";
  const color = chosen?.color && COLORS[chosen.color] ? chosen.color : AUTO_COLORS[Math.abs(course.id) % AUTO_COLORS.length];
  return { icon, color };
}

export function CourseIcon({ course, size = 16 }: { course: Parameters<typeof iconFor>[0]; size?: number }) {
  return <IconView choice={iconFor(course)} size={size} />;
}

/** `size` in pixels; "none" keeps the space, so names stay lined up. */
export function IconView({ choice, size = 16 }: { choice: IconChoice; size?: number }) {
  const box = { width: size, height: size };
  if ("none" in choice) return <span className="inline-block shrink-0" style={box} aria-hidden />;
  if ("emoji" in choice) {
    return (
      <span className="inline-flex shrink-0 items-center justify-center leading-none" style={{ ...box, fontSize: size * 0.9 }} aria-hidden>
        {choice.emoji}
      </span>
    );
  }
  const Icon = ICONS[choice.icon] ?? BookOpen;
  return <Icon className="shrink-0" style={{ ...box, color: COLORS[choice.color] }} aria-hidden />;
}
