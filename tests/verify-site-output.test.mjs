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

const cssFiles = (await listFiles(distPath)).filter((path) => path.endsWith('.css'));
const css = (await Promise.all(cssFiles.map((path) => readFile(path, 'utf8')))).join('\n');
assert.ok(!css.includes('#6e7681'), 'Dark subtle text color should meet WCAG contrast.');

const headers = await readDist('_headers');
assert.ok(
	headers.includes('Strict-Transport-Security:'),
	'Cloudflare Pages headers should include HSTS.',
);
