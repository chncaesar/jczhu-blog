import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, '../public/og-default.png');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <!-- Background -->
  <rect width="1200" height="630" fill="#0d1117"/>

  <!-- Left accent line -->
  <rect x="72" y="80" width="3" height="470" fill="#57c754" opacity="0.8"/>

  <!-- Terminal prompt -->
  <text x="96" y="148" font-family="Courier New, Courier, monospace" font-size="22" fill="#57c754" font-weight="400">~/jczhu.com $</text>

  <!-- Cursor blink block -->
  <rect x="244" y="128" width="13" height="22" fill="#57c754" opacity="0.9"/>

  <!-- Main name -->
  <text x="96" y="280" font-family="Courier New, Courier, monospace" font-size="80" fill="#e6edf3" font-weight="700" letter-spacing="-1">Jiachuan Zhu</text>

  <!-- Divider line -->
  <rect x="96" y="308" width="520" height="1" fill="#30363d"/>

  <!-- Subtitle -->
  <text x="96" y="368" font-family="Courier New, Courier, monospace" font-size="26" fill="#8b949e" letter-spacing="1">Software Engineer</text>
  <text x="96" y="410" font-family="Courier New, Courier, monospace" font-size="22" fill="#57c754" opacity="0.7" letter-spacing="1">Backend · Systems · AI-assisted Dev</text>

  <!-- Domain bottom right -->
  <text x="1128" y="560" font-family="Courier New, Courier, monospace" font-size="22" fill="#57c754" opacity="0.5" text-anchor="end">jczhu.com</text>

  <!-- Subtle grid dots top right -->
  <g fill="#8b949e" opacity="0.08">
    ${Array.from({ length: 10 }, (_, row) =>
      Array.from({ length: 16 }, (_, col) =>
        `<circle cx="${800 + col * 28}" cy="${80 + row * 28}" r="1.5"/>`
      ).join('')
    ).join('')}
  </g>
</svg>`;

writeFileSync(join(__dirname, '../public/og-default.svg'), svg);
console.log('SVG written.');

await sharp(Buffer.from(svg))
  .png()
  .toFile(outputPath);

console.log(`PNG generated: ${outputPath}`);
