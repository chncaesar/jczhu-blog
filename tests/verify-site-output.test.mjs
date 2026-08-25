import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = new URL('../dist/client/', import.meta.url);
const distPath = fileURLToPath(distDir);

async function readDist(path) {
	return readFile(new URL(path, distDir), 'utf8');
}

async function listFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(entries.map((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? listFiles(path) : path;
	}));

	return files.flat();
}

function extractTag(html, tagName) {
	const match = html.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
	return match?.[1]?.trim() ?? null;
}

function extractRssDates(xml) {
	return [...xml.matchAll(/<pubDate>(.*?)<\/pubDate>/g)].map((match) =>
		new Date(match[1]).valueOf(),
	);
}

function extractToolArticle(html, toolName) {
	return [...html.matchAll(/<article class="tool-card"[^>]*>[\s\S]*?<\/article>/g)]
		.map((match) => match[0])
		.find((article) => article.includes(toolName));
}

function normalizeContractText(content) {
	return content
		.replace(/<[^>]+>/g, ' ')
		.replace(/`/g, '')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
		.replace(/\s+([,.;!?，。；：])/g, '$1')
		.trim();
}

function assertLocalizedContract(content, label, { required, forbidden }) {
	const normalized = normalizeContractText(content);
	for (const phrase of required) {
		assert.ok(normalized.includes(phrase), `${label} should include the exact contract phrase: ${phrase}`);
	}
	for (const contradiction of forbidden) {
		assert.ok(!normalized.includes(contradiction), `${label} must reject the contradiction: ${contradiction}`);
	}
}

const englishReflectionContract = {
	required: [
		'The registered session_reflection tool is the primary interface; /session-review is only an optional local-development helper.',
		'The plugin reads session metadata and transcripts through OpenCode APIs, with cross-project discovery through /experimental/session; it never accesses SQLite directly.',
		'Selected session evidence may reach the model provider configured in OpenCode.',
		'Redacted audit metadata stays local and is not uploaded by the plugin.',
		'Saved Markdown reports may contain sensitive excerpts; users control their retention and deletion.',
	],
	forbidden: [
		'/session-review is the primary interface.',
		"The plugin reads OpenCode's SQLite database directly.",
		'Selected session evidence is never sent to a model provider.',
		'Audit metadata is uploaded to a remote service.',
		'Saved reports are safe to retain indefinitely.',
	],
};

const chineseReflectionContract = {
	required: [
		'session_reflection 是标准主界面；/session-review 只是在本地开发时可选的辅助命令。',
		'插件通过 OpenCode API 读取 session metadata 和 transcript，跨项目发现使用 /experimental/session；插件不直接访问 SQLite。',
		'选中的 session 证据可能会发送到 OpenCode 当前配置的模型 provider。',
		'经过脱敏的审计元数据只保存在本地，插件不会上传。',
		'保存的 Markdown 报告可能包含敏感片段；报告的保留和删除由使用者管理。',
	],
	forbidden: [
		'/session-review 是标准主界面。',
		'插件直接读取 OpenCode 的 SQLite 数据库。',
		'选中的 session 证据绝不会发送给模型 provider。',
		'审计元数据会上传到远程服务。',
		'保存的报告可以无限期安全保留。',
	],
};

const rssXml = await readDist('rss.xml');
const rssDates = extractRssDates(rssXml);
assert.ok(rssDates.length > 1, 'RSS feed should include multiple dated posts.');
for (let index = 1; index < rssDates.length; index += 1) {
	assert.ok(
		rssDates[index - 1] >= rssDates[index],
		'RSS feed should be sorted newest first.',
	);
}

const blogHtml = await readDist('blog/index.html');
assert.equal(extractTag(blogHtml, 'h1'), '## posts', 'Blog index should expose ## posts as an h1.');

const aboutHtml = await readDist('about/index.html');
assert.equal(
	extractTag(aboutHtml, 'title'),
	'About — Jiachuan Zhu',
	'About page title should include the site owner name.',
);
assert.ok(
	aboutHtml.includes('OpenCode') && aboutHtml.includes('coding agents'),
	'About page should reflect the OpenCode coding-agent reliability focus.',
);

const toolkitHtml = await readDist('opencode-tools/index.html');
const reflectionToolHtml = extractToolArticle(toolkitHtml, 'opencode-session-reflection');
assert.ok(reflectionToolHtml, 'Toolkit should include opencode-session-reflection.');
assert.ok(
	/<code[^>]*>session_reflection<\/code>/.test(reflectionToolHtml),
	'Toolkit should show session_reflection as the normal installed command.',
);
assert.ok(
	!/<code[^>]*>\/session-review<\/code>/.test(reflectionToolHtml),
	'Toolkit should not show the optional local helper as the normal installed command.',
);
assert.ok(
	toolkitHtml.includes('href="/blog/opencode-memory-internals/"'),
	'Toolkit should link to the OpenCode memory internals article.',
);

const memoryArticleHtml = await readDist('blog/opencode-memory-internals/index.html');
assert.ok(
	memoryArticleHtml.includes('href="/opencode-tools/"'),
	'Memory article should link readers to the OpenCode Reliability Toolkit.',
);
assert.ok(
	memoryArticleHtml.includes('href="/blog/opencode-v2-compaction-internals/"'),
	'Memory article should link to the detailed V2 compaction analysis.',
);

const compactionArticleHtml = await readDist('blog/opencode-v2-compaction-internals/index.html');
assert.ok(
	compactionArticleHtml.includes('href="/blog/opencode-memory-internals/"'),
	'Compaction article should link back to the broader memory analysis.',
);

const reflectionArticleHtml = await readDist('blog/agent-session-log-file/index.html');
assertLocalizedContract(reflectionArticleHtml, 'English generated article', englishReflectionContract);

const reflectionZhihuSource = await readFile(
	new URL('../src/content/zhihu/opencode-session-reflection.md', import.meta.url),
	'utf8',
);
assertLocalizedContract(reflectionZhihuSource, 'Chinese source', chineseReflectionContract);
assert.ok(
	reflectionZhihuSource.includes('session_reflection（limit: 12）'),
	'Chinese count example should use the supported limit argument.',
);

const cssFiles = (await listFiles(distPath)).filter((path) => path.endsWith('.css'));
const css = (await Promise.all(cssFiles.map((path) => readFile(path, 'utf8')))).join('\n');
assert.ok(!css.includes('#6e7681'), 'Dark subtle text color should meet WCAG contrast.');

const headers = await readDist('_headers');
assert.ok(
	headers.includes('Strict-Transport-Security:'),
	'Cloudflare Pages headers should include HSTS.',
);
