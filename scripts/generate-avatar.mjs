import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <!-- Background circle clip -->
  <defs>
    <clipPath id="circle">
      <circle cx="200" cy="200" r="200"/>
    </clipPath>
  </defs>

  <!-- Background -->
  <rect width="400" height="400" fill="#0d1117" clip-path="url(#circle)"/>

  <!-- Subtle dot grid -->
  <g fill="#8b949e" opacity="0.07" clip-path="url(#circle)">
    ${Array.from({ length: 14 }, (_, row) =>
      Array.from({ length: 14 }, (_, col) =>
        `<circle cx="${30 + col * 26}" cy="${30 + row * 26}" r="1.5"/>`
      ).join('')
    ).join('')}
  </g>

  <!-- Left accent line -->
  <rect x="60" y="100" width="3" height="200" fill="#57c754" opacity="0.85" clip-path="url(#circle)"/>

  <!-- Terminal prompt line -->
  <text x="82" y="152" font-family="Courier New, Courier, monospace" font-size="18" fill="#57c754" opacity="0.75">~/jczhu.com $</text>

  <!-- Cursor block -->
  <rect x="82" y="172" width="44" height="52" fill="#57c754" opacity="0.15" clip-path="url(#circle)"/>
  <rect x="82" y="172" width="44" height="52" fill="none" stroke="#57c754" stroke-width="1.5" opacity="0.4" clip-path="url(#circle)"/>

  <!-- Initials -->
  <text x="104" y="214" font-family="Courier New, Courier, monospace" font-size="36" fill="#e6edf3" font-weight="700" text-anchor="middle">JZ</text>

  <!-- Divider -->
  <rect x="82" y="244" width="160" height="1" fill="#30363d" clip-path="url(#circle)"/>

  <!-- Tagline -->
  <text x="82" y="272" font-family="Courier New, Courier, monospace" font-size="15" fill="#8b949e">Software Engineer</text>
  <text x="82" y="294" font-family="Courier New, Courier, monospace" font-size="13" fill="#57c754" opacity="0.65">Backend · Systems · AI</text>
</svg>`;

const outputPath = join(__dirname, '../public/avatar.png');
writeFileSync(join(__dirname, '../public/avatar.svg'), svg);

await sharp(Buffer.from(svg))
  .png()
  .toFile(outputPath);

console.log(`Avatar generated: ${outputPath}`);
