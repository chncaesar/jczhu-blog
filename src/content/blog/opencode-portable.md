---
title: Everything My Coding Agent Forgot When I Changed Machines
description: Moving OpenCode between machines means moving keys, MCP servers, permission answers and project-scoped sessions, plus the migration details that turn out to be hard — secret redaction, path remapping, and a timestamp trap that reverses naive merges.
pubDate: 2026-11-09
tags:
  - ai-coding
  - opencode
  - agent-workflow
  - tools
---

I opened OpenCode on a new machine and it did not know me.

No providers, no MCP servers, model back at its default, prompt history empty. Then the part that actually stung: it started asking permission to run commands it had been allowed to run for months, one prompt at a time, exactly like my first week with it.

Copying the config folder fixed maybe half of that, and it made me nervous, because one of the things inside that folder is a pile of live API keys. So I built [`opencode-portable`](https://github.com/chncaesar/opencode-portable) instead.

It splits OpenCode's durable state into five tiers — config, MCP servers, user state, sessions, credentials — and writes them into one `.ocm` archive: a gzipped tar with a manifest holding a SHA-256 per file, verified before anything is read. Default export is config plus MCP servers. Sessions and credentials are opt-in, because one is a stack of transcripts and the other is the keys to your accounts.

Config means `opencode.jsonc` without its MCP block, plus `tui.json`, `AGENTS.md` and the command, skills, agent and plugins folders. The redaction is the part I expected to be easy and wasn't. Structured JSON is scanned for values under key, token, secret or password and for recognizable token shapes; each hit is replaced in the archived copy by a marker built from its JSON path, so `provider.anthropic.options.apiKey` becomes `{env:PROVIDER_ANTHROPIC_OPTIONS_APIKEY}`, which OpenCode expands at startup. Your own file is never touched. Plugin scripts defeat the whole idea — a `.js` file can assemble a token at runtime, and regex-rewriting source is how you get a plugin that silently sends a placeholder to a real API. So they are copied unchanged and reported as warnings, unless `--fail-on-secrets` makes that a hard stop. The MCP block has the same problem one level up, in two layouts (`mcp.<name>` with `enabled`, v2's `mcp.servers.<name>` with `disabled`), so import writes into whichever one the target already uses.

Sessions were where I expected trouble and got a different kind. The tool never reads SQLite: it lists sessions through the running service and moves them with `opencode session export` and `import --directory`, so transcripts are not rewritten. The awkward fact is that a project is identified by directory path, and paths do not travel. Import resolves each project through a ladder — explicit `--map`, the mapping file from an earlier import, a local clone sharing the root commit, a home-directory swap, then the original path — with longest-whole-folder prefix winning, so `/home/me` never swallows `/home/me2`. No match means detached, sessions skipped, and the plan says so before writing anything.

The trap I did not see coming is time. Importing a session resets its update time, so an imported copy always looks newer than the archive it came from. "Newest wins" therefore reverses direction after the first import; run it twice and you can overwrite the machine you were still working on. The tool decides by direction instead: local copy same age or newer, skip; archive copy newer, report a conflict and touch neither, since the export format has no way to update an existing session. The worst case becomes a session reconciled by hand rather than a session lost.

Credentials come only from `opencode auth export`, never from `auth.json` or `service.json`, because a file whose format is not a contract is a bad foundation for moving keys. They go into `secrets.enc`: AES-256-GCM, scrypt-derived key, parameters stored in an authenticated header. There is no `--passphrase` flag — arguments leak through `ps` and shell history — so the passphrase comes from a file, an environment variable, or a hidden prompt. Import is a dry run unless `--apply`, every changed file is backed up first, and the runtime dependencies are just `tar` and `jsonc-parser`.

```
npm install -g @chncaesar/opencode-portable
opencode-portable export --tiers config,mcp,state --out me.ocm
opencode-portable import me.ocm --apply
```

Portability is mostly the discipline of deciding, before writing anything, which parts cannot be moved safely — and saying so out loud.
