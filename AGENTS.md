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

### English
- **Prose style**: Traditional narrative — paragraphs carry complete ideas with natural sentence rhythm. Sentence length varies organically; short sentences appear at key turning points for emphasis, not as a default pattern throughout.
- **Not** a choppy one-sentence-per-line style. Avoid artificially breaking continuous thought into isolated lines.
- **Structure**: Each section has a clear narrative arc. The opening drops into a concrete incident. The body traces the reasoning. The final section lands a broader engineering insight.
- **Tone**: First-person, reflective. Not a tutorial ("here's how to do X") but a post-mortem ("here's what happened and what it revealed").
- **Technical depth**: Name real APIs, real tools, real error values. But don't paste large code blocks as the main substance — code illustrates, prose carries the argument.
- **Closing**: The last paragraph of the last section should deliver the essay's core claim — concise, direct, no hedging.

### 中文
- **核心原则：用地道中文写作，不是翻译英文。** 句式、节奏、起承转合都要按中文的阅读习惯来，不要带着英文语法的影子。
- **句式**：多用短句，流水句，主语可以省略。中文不习惯英文那种层层嵌套的从句结构——拆开，一句一句说。
- **被动语态**：中文少用"被"字。英文的被动结构翻成中文要改成主动式或主题句。比如不说"公式被 AI 实现了"，说"AI 把公式实现了"或者直接"公式实现出来了"。
- **连接词**：减少"当……的时候"、"因为……所以……"、"尽管……但是……"这类硬翻译连接词。中文靠语义自然衔接，不需要像英文那样每个逻辑关系都显式标出来。
- **节奏**：长短句交替。短句要有力，长句要流畅。不要写成每句一样长度的模板文。
- **人称**：第一人称"我"，不要躲。技术文章也可以有语气。

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
- **SEO review required after every content or layout change.** Before committing, verify: (1) `<title>` is descriptive, not generic; (2) `<h1>` exists and matches page intent; (3) OG/Twitter card images are intentional, not placeholder fallbacks; (4) canonical URL is correct; (5) no stale CSS variables referencing removed design tokens.
