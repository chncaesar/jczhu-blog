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

## Conventions

- Node >= 22.12.0 (see `engines` in package.json)
- New blog posts go in `src/content/blog/` with frontmatter matching the Zod schema in `src/content.config.ts`: `title`, `description`, `pubDate`, optional `updatedDate` and `heroImage`
- The `site` URL in `astro.config.mjs` is `https://example.com` (placeholder — update when deploying)
