## Commands

```sh
npm run dev          # Astro dev server on localhost:4321
npm run build        # production build to dist/client/ for Cloudflare adapter
npm run verify:site  # post-build Node assertions; run after npm run build
npm run preview      # npm run build && wrangler dev
npm run deploy       # npm run build && wrangler deploy
npm run generate-types # wrangler types
```

There are no lint, unit test, or typecheck scripts in `package.json`. The focused verification path is `npm run build` followed by `npm run verify:site`.

## Architecture

- Astro 6 site for `https://jczhu.com`, deployed with `@astrojs/cloudflare` and `wrangler.jsonc`.
- Blog posts are loaded only from `src/content/blog/**/*.{md,mdx}` via `src/content.config.ts`.
- Chinese cross-post drafts live in `src/content/zhihu/`; they are intentionally outside Astro content collections and are not built.
- `src/layouts/BlogPost.astro` renders both blog posts and the About page, so layout/SEO changes affect non-post pages too.
- RSS is generated in `src/pages/rss.xml.js` from the `blog` collection and sorted newest first.
- `BaseHead.astro` owns canonical URLs, OG/Twitter metadata, the global stylesheet import, and the fallback `/og-default.png` image.
- `public/_headers` is copied into the Cloudflare output; `verify:site` asserts the HSTS header survives the build.

## Blog Writing Style

### English

- Write reflective engineering post-mortems, not tutorials. Start from a concrete incident, trace the reasoning, and land on the broader engineering lesson.
- Use normal paragraphs with varied rhythm. Do not turn prose into one sentence per line.
- Name real APIs, tools, and error values when useful, but keep code snippets illustrative rather than central.
- The final paragraph should state the essay's core claim directly.

### 中文

- 用地道中文写作，不要像英文翻译稿。少用层层嵌套的长从句，少用硬连接词。
- 可以用第一人称“我”。技术文章也要有个人判断和语气。
- 中文稿放在 `src/content/zhihu/`，用于简书/知乎等平台，不参与本站构建。

## Deployment

- `astro.config.mjs` already sets `site: 'https://jczhu.com'`; do not revert it to the Astro placeholder.
- Deploys through Cloudflare Pages/Workers config in `wrangler.jsonc` with assets served from `./dist`.
- Do not run `npm run deploy` unless the user explicitly asks to deploy.

## Content Rules

- New built posts go in `src/content/blog/` with frontmatter matching `src/content.config.ts`: required `title`, `description`, `pubDate`; optional `updatedDate`, `heroImage`, `tags`, `draft`.
- English posts are primary on `jczhu.com`; when cross-posting to dev.to, use the `jczhu.com` canonical URL.
- Chinese cross-posts should end with “原文首发于 jczhu.com”.
- Do not reveal personal project details in articles. Generalize examples to “a search feature”, “a deployment script”, “a side project”, etc.

## Design And SEO

- Preserve the current terminal-style, monospace, low-decoration design. Global tokens live in `src/styles/global.css`; avoid adding flashy UI patterns or decorative client JS.
- After content or layout changes, check: descriptive `<title>`, one page-intent `<h1>`, intentional OG/Twitter image, correct canonical URL, and no stale CSS variables.
- `tests/verify-site-output.test.mjs` currently asserts RSS sort order, blog `<h1>`, About title, CSS contrast regression, and HSTS output.

## Conventions

- Use Node >= 22.12.0 and npm; `package-lock.json` is committed.
- This repo intentionally has zero client-side JavaScript in normal pages. Keep new behavior static unless there is a clear reason not to.
