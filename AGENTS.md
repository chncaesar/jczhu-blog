# AGENTS.md

## Commands

```sh
npm run dev        # dev server on localhost:4321
npm run build      # production build to ./dist/
npm run preview    # preview production build locally
```

No test/lint/typecheck scripts are configured. `astro check` can type-check `.astro` files but is not wired as a script.

## Architecture

Standard Astro blog starter (`npm create astro@latest -- --template blog`).

- **Content**: `src/content/blog/*.md` — Markdown/MDX blog posts loaded via glob loader
- **Layouts**: `src/layouts/BlogPost.astro` — single post template
- **Pages**: `src/pages/` — file-based routing (`index.astro`, `about.astro`, `blog/index.astro`, `blog/[...slug].astro`)
- **Components**: `src/components/` — Header, Footer, BaseHead, FormattedDate, HeaderLink
- **Assets**: `src/assets/` — local fonts (Atkinson) and placeholder images
- **Global config**: `src/consts.ts` — SITE_TITLE, SITE_DESCRIPTION

## Blog Writing Style

- **Prose style**: Traditional narrative — paragraphs carry complete ideas with natural sentence rhythm. Sentence length varies organically; short sentences appear at key turning points for emphasis, not as a default pattern throughout.
- **Not** a choppy one-sentence-per-line style. Avoid artificially breaking continuous thought into isolated lines.
- **Structure**: Each section has a clear narrative arc. The opening drops into a concrete incident. The body traces the reasoning. The final section lands a broader engineering insight.
- **Tone**: First-person, reflective. Not a tutorial ("here's how to do X") but a post-mortem ("here's what happened and what it revealed").
- **Technical depth**: Name real APIs, real tools, real error values. But don't paste large code blocks as the main substance — code illustrates, prose carries the argument.
- **Closing**: The last paragraph of the last section should deliver the essay's core claim — concise, direct, no hedging.

## Deployment

- This Astro project deploys to **jczhu.com**
- Hosted on Cloudflare Pages (see `wrangler.jsonc`)
- Update `site` in `astro.config.mjs` to `https://jczhu.com` before deploying

## Owner Profile

- Senior software engineer, old-school, pragmatic
- Linux / Ubuntu / macOS user, open source contributor
- No Windows, no flashy UI
- Design aesthetic: terminal-style, monospace, zero decoration

## Conventions

- Node >= 22.12.0 (see `engines` in package.json)
- New blog posts go in `src/content/blog/` with frontmatter matching the Zod schema in `src/content.config.ts`: `title`, `description`, `pubDate`, optional `updatedDate` and `heroImage`
- The `site` URL in `astro.config.mjs` is `https://example.com` (placeholder — update when deploying)
