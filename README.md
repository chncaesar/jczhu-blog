# jczhu.com

Personal blog at [jczhu.com](https://jczhu.com). Terminal aesthetic, zero decoration.

**Stack:** [Astro](https://astro.build) → Cloudflare Pages, IBM Plex Mono, zero client JS.

## Posts

`src/content/blog/` — English posts (content collection via glob loader).

`src/content/zhihu/` — Chinese posts for 简书/知乎 (outside the Astro collection, not built).

## Commands

```sh
npm run dev        # localhost:4321
npm run build      # production build to dist/
npm run preview    # wrangler dev (local CF Pages)
npm run deploy     # build + wrangler deploy
```

## Structure

```
src/
├── content/blog/    # markdown posts with frontmatter
├── content/zhihu/   # Chinese articles (not in collection)
├── pages/           # file-based routing + RSS
├── layouts/         # BlogPost.astro
├── components/      # BaseHead, Header, Footer, FormattedDate, HeaderLink
├── styles/          # global.css (terminal theme)
├── assets/          # fonts
├── consts.ts        # SITE_TITLE, SITE_DESCRIPTION
└── content.config.ts # blog collection schema
```

## Schema

Posts use `title`, `description`, `pubDate`, optional `updatedDate`, `heroImage`, `tags`, `draft`.

