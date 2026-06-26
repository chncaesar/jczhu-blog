---
title: I Reverse Engineered a Closed-Format App. Everything Was in SQLite.

description: Youdao Cloud Note has no export feature. Its local database had 2,285 notes, a custom JSON block tree, and three SQLite files sitting unencrypted on disk.

pubDate: 2026-06-27

tags:
  - reverse-engineering
  - sqlite
  - python
  - tools
  - software-engineering
---

I had accumulated over two thousand notes in Youdao Cloud Note over several years. When I decided to move to Obsidian, the first thing I checked was the export feature. There wasn't one. No batch export, no single-note export, nothing in the Mac client.

So I went looking for the local data.

---

## Where The Data Was

On macOS, Youdao Cloud Note stores its data here:

```
~/Library/Containers/ynote-desktop/Data/Library/Application Support/ynote-desktop/
```

Inside that directory, organized by account email, were three SQLite databases:

```
<account>.db         # note metadata, folder hierarchy
<account>-content.db # note content (old editor)
<account>-search.db  # search index
```

And a `file/` directory with 16 subdirectories arranged by the first character of each file ID, holding the new editor's local files. Everything was unencrypted.

---

## What The Database Contained

The main database had two critical tables:

**`note`** — the note catalog. Key columns: `fileId` (UUID), `title`, `parentId` (folder reference), `orgEditorType` (0 for the new block editor, 1 for the old plain editor), `entryPath` (path to the local file), `createTime` (Unix timestamp in seconds), and `deleted` (NULL meant not deleted).

**`note_book`** — the folder tree. Folders were not in `note` at all. They lived in a separate table with their own `fileId` and `parentId` fields, forming a tree you could traverse with BFS.

The content database held a `contenttable` with a `content` field, but the field was truncated to around 150 characters — just enough for search snippets. The real content for old-editor notes lived here too, with variable lengths.

Where the content actually was depended on which editor wrote the note:

| orgEditorType | Editor | Content source |
|---|---|---|
| 0 | New (block editor) | `entryPath` → local file |
| 1 | Old (plain) | `contenttable.content` |

The local files came in two formats: JSON (449 of them) and plain Markdown (1,832).

---

## The JSON Block Tree

The new editor stored notes as a block tree in JSON. Each block followed this structure, with the actual keys being cryptic integers:

```
"6" → block type (p=paragraph, h=heading, co=code, t=table, im=image, l=list, q=quote, hr=divider)
"4" → properties (heading level, code language, image URL, etc.)
"5" → array of child blocks
"7" → inline text segments with "9" format markers (b=bold, i=italic, li=link, il=inline code, etc.)
```

Walking the `"5"` array recursively converted the entire tree to Markdown. The core renderer was under 200 lines.

---

## Three Things That Wasted My Time

**The `__compress__` flag.** Ten JSON files had `"__compress__": true`. I spent an hour trying to uncompress them with LZString before realizing the `"5"` array was still just a plain array — not a compressed string. The flag had been set but never used.

**Deleted is NULL, not 0.** Every note with `deleted IS NULL` had been a living note. `WHERE deleted = 0` returned nothing. This is standard SQL but easy to miss when you're scanning thousands of rows for anomalies.

**The timestamp is in seconds.** `1484115955` is January 11, 2017. If you treat it as milliseconds and divide by 1000, you land in 1970. I did that once.

---

## A Dead-End That Wasn't

The `contenttable.content` field was consistently 150 characters. This looked like a deliberate truncation to defeat extraction. But the actual content was never supposed to be in that column — the new editor stored everything in local files referenced by `entryPath`. The content column was just a search index. Once I followed the `entryPath` trail, I had the full text of every note.

---

## What The Script Does

The whole thing is a single Python file. It connects to the three SQLite databases, walks the folder tree, maps every note to its content source, converts JSON blocks to Markdown when needed, and writes the output organized by folder.

```bash
git clone https://github.com/chncaesar/youdao-to-obsidian.git
cd youdao-to-obsidian
pip3 install beautifulsoup4
python3 youdao_migrate.py
```

The script auto-detects your account and data directory. Output goes to `~/Desktop/obsidian/` by default. Each note gets a `.md` file with YAML frontmatter preserving the original title, creation date, and source ID.

I also bundled a Claude Code Skill in the repo — drop it into `~/.claude/skills/` and saying "export my Youdao notes" triggers the whole pipeline without remembering flags.

---

## What Came Out

The final export: 2,285 notes across 253 folders. Mixed Chinese, English, and code content with no encoding issues. Tables, code blocks, images, lists, and blockquotes all converted correctly from the JSON block tree. Some notes were empty bodies with attachments only, handled gracefully.

Open `~/Desktop/obsidian` as an Obsidian vault and everything is there.

---

## Why This Worked

The most interesting part of this project was not the parser or the block converter.

It was the realization that a closed-format application with no export feature had been storing all my data in plain, unencrypted SQLite files, with a documented-enough block structure that could be reverse-engineered in an afternoon.

Two thousand notes. Years of writing. The application offered no way to take them out. They were never locked in. I just hadn't looked.

GitHub: [github.com/chncaesar/youdao-to-obsidian](https://github.com/chncaesar/youdao-to-obsidian)
