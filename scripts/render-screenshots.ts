import { mkdirSync } from "node:fs";

const FONT = "Consolas, 'Courier New', monospace";
const BG = "#1e1e1e";
const FG = "#d4d4d4";
const ACCENT = "#4ec9b0";
const MUTED = "#858585";

function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function render(lines: string[], out: string, title: string): void {
  mkdirSync("docs/screenshots", { recursive: true });
  const width = Math.max(...lines.map(line => [...line].length));
  const fontSize = 15;
  const charW = fontSize * 0.6;
  const lineH = fontSize * 1.35;
  const pad = 24;
  const svgW = Math.ceil(width * charW + pad * 2);
  const svgH = Math.ceil(lines.length * lineH + pad * 2 + 28);
  const body = lines.map((line, i) =>
    `<text x="${pad}" y="${pad + 28 + i * lineH}" font-family="${FONT}" font-size="${fontSize}" fill="${FG}">${esc(line).replaceAll("❯", `<tspan fill="${ACCENT}">❯</tspan>`)}</text>`
  ).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}"><rect width="100%" height="100%" fill="${BG}"/><text x="${pad}" y="${pad + 4}" font-family="${FONT}" font-size="12" fill="${MUTED}">${esc(title)}</text>\n${body}</svg>`;
  Bun.write(`docs/screenshots/${out}.svg`, svg + "\n");
  console.log(out, svgW + "x" + svgH, lines.length + " lines");
}

// Кадры сняты из одноразового профиля `shots` (OMP 18.6.1, Windows): текст панелей
// скопирован из живого терминала без изменений, путь проекта заменён на ~/….
const ru = (await Bun.file("docs/screenshots/captures/shot-ru.txt").text()).trimEnd().split("\n");
const search = (await Bun.file("docs/screenshots/captures/shot-search.txt").text()).trimEnd().split("\n");
const en = (await Bun.file("docs/screenshots/captures/shot-en.txt").text()).trimEnd().split("\n");
render(ru.slice(0, 34), "settings-ru", "omp --profile shots · /settings · русский");
render(search.slice(0, 16), "settings-search", "omp --profile shots · /settings · поиск «символов»");
render(en.slice(0, 34), "settings-en", "omp --profile shots · /settings-language en · /settings");
