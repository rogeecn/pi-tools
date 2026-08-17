import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveApiBaseUrl } from "../utils.ts";

const modules = Object.fromEntries([
	"anysearch", "bocha", "brave", "brightdata", "brightdata-unlocker", "exa", "extract", "jina-search", "kagi", "ollama", "parallel", "querit", "search1api", "searchinfinity", "serpbase", "serpdive", "serper", "tavily", "tinyfish", "valyu", "xai-search",
].map(name => [name, new URL(`../${name}.ts`, import.meta.url).href]));
const publicLookup = `async () => [{ address: "93.184.216.34", family: 4 }]`;

async function run(config, script, env = {}) {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-base-url-"));
	await writeFile(join(configDir, "web-search.json"), JSON.stringify(config));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: { ...process.env, ...env, PI_CODING_AGENT_DIR: configDir },
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("provider base URLs reject unsafe values and preserve zero-config fallback", () => {
	assert.equal(resolveApiBaseUrl(undefined, "https://default.test", "exampleBaseUrl"), "https://default.test");
	assert.equal(resolveApiBaseUrl("   ", "https://default.test", "exampleBaseUrl"), "https://default.test");
	assert.equal(resolveApiBaseUrl("https://gateway.test/root///", "https://default.test", "exampleBaseUrl"), "https://gateway.test/root");
	assert.throws(() => resolveApiBaseUrl("/relative", "https://default.test", "exampleBaseUrl"), /exampleBaseUrl.*absolute http\(s\).*without credentials/);
	assert.throws(() => resolveApiBaseUrl("ftp://gateway.test", "https://default.test", "exampleBaseUrl"), /exampleBaseUrl.*absolute http\(s\)/);
	assert.throws(() => resolveApiBaseUrl("https://user:pass@gateway.test", "https://default.test", "exampleBaseUrl"), /without credentials/);
});

test("Jina applies separate Search and Reader base URLs", async () => {
	const urls = await run({
		jinaSearchBaseUrl: "https://gateway.test/jina-search/",
		jinaReaderBaseUrl: "https://gateway.test/jina-reader/",
		fetchRouting: { providers: ["jina"], allowRemoteHostedProviders: true },
	}, `
		const urls = [];
		globalThis.fetch = async url => {
			urls.push(String(url));
			if (String(url).startsWith("https://gateway.test/jina-search/")) return new Response(JSON.stringify({ code: 200, data: [] }), { status: 200 });
			if (String(url) === "https://example.com/page") return new Response("unavailable", { status: 503 });
			return new Response("# Reader\\n\\n" + "x".repeat(600), { status: 200 });
		};
		const { searchWithJina } = await import(${JSON.stringify(modules["jina-search"])});
		const { extractContent } = await import(${JSON.stringify(modules.extract)});
		await searchWithJina("base url");
		await extractContent("https://example.com/page", undefined, { lookup: ${publicLookup} });
		console.log(JSON.stringify(urls));
	`, { JINA_API_KEY: "test-key" });
	assert.match(urls[0], /^https:\/\/gateway\.test\/jina-search\/base%20url\?/);
	assert.equal(urls.at(-1), "https://gateway.test/jina-reader/https://example.com/page");
});

test("TinyFish applies Search and Fetch base URLs", async () => {
	const urls = await run({
		tinyfishSearchBaseUrl: "https://gateway.test/tinyfish/search/",
		tinyfishFetchBaseUrl: "https://gateway.test/tinyfish/fetch/",
	}, `
		const urls = [];
		globalThis.fetch = async url => {
			urls.push(String(url));
			if (String(url).includes("/search?")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
			return new Response(JSON.stringify({ results: [{ url: "https://example.com", title: "Page", text: "content" }], errors: [] }), { status: 200 });
		};
		const { searchWithTinyFish, extractWithTinyFish } = await import(${JSON.stringify(modules.tinyfish)});
		await searchWithTinyFish("base url");
		await extractWithTinyFish("https://example.com");
		console.log(JSON.stringify(urls));
	`, { TINYFISH_API_KEY: "test-key" });
	assert.match(urls[0], /^https:\/\/gateway\.test\/tinyfish\/search\?query=/);
	assert.equal(urls[1], "https://gateway.test/tinyfish/fetch");
});

test("Search1API applies one base URL to Search and Crawl", async () => {
	const urls = await run({ search1apiBaseUrl: "https://gateway.test/search1api/" }, `
		const urls = [];
		globalThis.fetch = async url => {
			urls.push(String(url));
			if (String(url).endsWith("/search")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
			return new Response(JSON.stringify({ results: { title: "Page", content: "content" } }), { status: 200 });
		};
		const { searchWithSearch1API, extractWithSearch1API } = await import(${JSON.stringify(modules.search1api)});
		await searchWithSearch1API("base url");
		await extractWithSearch1API("https://example.com");
		console.log(JSON.stringify(urls));
	`, { SEARCH1API_KEY: "test-key" });
	assert.deepEqual(urls, ["https://gateway.test/search1api/search", "https://gateway.test/search1api/crawl"]);
});

test("Querit applies one base URL to Search and Contents", async () => {
	const urls = await run({ queritBaseUrl: "https://gateway.test/querit/" }, `
		const urls = [];
		globalThis.fetch = async url => {
			urls.push(String(url));
			if (String(url).endsWith("/search")) return new Response(JSON.stringify({ error_code: 200, results: { result: [] } }), { status: 200 });
			return new Response(JSON.stringify({ error_code: 200, results: [{ id: "1", url: "https://example.com", content: "content" }], statuses: [{ id: "1", status: "success" }] }), { status: 200 });
		};
		const { searchWithQuerit, extractWithQuerit } = await import(${JSON.stringify(modules.querit)});
		await searchWithQuerit("base url");
		await extractWithQuerit("https://example.com");
		console.log(JSON.stringify(urls));
	`, { QUERIT_API_KEY: "test-key" });
	assert.deepEqual(urls, ["https://gateway.test/querit/v1/search", "https://gateway.test/querit/v1/contents"]);
});

test("Kagi, Ollama, and Parallel apply their base URL to both endpoints", async () => {
	const cases = [
		{
			config: { kagiBaseUrl: "https://gateway.test/kagi/" }, env: { KAGI_API_KEY: "test-key" }, module: "kagi",
			script: `const { searchWithKagi, extractWithKagi } = api; await searchWithKagi("q"); await extractWithKagi("https://example.com", undefined, { lookup: ${publicLookup} });`,
			responses: `String(url).endsWith("/search") ? { data: { search: [] } } : { data: [{ url: "https://example.com", markdown: "content" }] }`,
			expected: ["https://gateway.test/kagi/api/v1/search", "https://gateway.test/kagi/api/v1/extract"],
		},
		{
			config: { ollamaBaseUrl: "https://gateway.test/ollama/" }, env: { OLLAMA_API_KEY: "test-key" }, module: "ollama",
			script: `const { searchWithOllama, extractWithOllama } = api; await searchWithOllama("q"); await extractWithOllama("https://example.com", undefined, { lookup: ${publicLookup} });`,
			responses: `String(url).endsWith("web_search") ? { results: [] } : { title: "Page", content: "content" }`,
			expected: ["https://gateway.test/ollama/api/web_search", "https://gateway.test/ollama/api/web_fetch"],
		},
		{
			config: { parallelBaseUrl: "https://gateway.test/parallel/" }, env: { PARALLEL_API_KEY: "test-key" }, module: "parallel",
			script: `const { searchWithParallel, extractWithParallel } = api; await searchWithParallel("q"); await extractWithParallel("https://example.com");`,
			responses: `String(url).endsWith("/search") ? { results: [] } : { results: [{ url: "https://example.com", title: "Page", full_content: "x".repeat(600) }] }`,
			expected: ["https://gateway.test/parallel/v1/search", "https://gateway.test/parallel/v1/extract"],
		},
	];
	for (const item of cases) {
		const urls = await run(item.config, `
			const urls = [];
			globalThis.fetch = async url => { urls.push(String(url)); return new Response(JSON.stringify(${item.responses}), { status: 200 }); };
			const api = await import(${JSON.stringify(modules[item.module])});
			${item.script}
			console.log(JSON.stringify(urls));
		`, item.env);
		assert.deepEqual(urls, item.expected);
	}
});

test("Bright Data applies one base URL to SERP and Web Unlocker", async () => {
	const urls = await run({
		brightdataBaseUrl: "https://gateway.test/brightdata/",
		brightdataApiKey: "test-key",
		brightdataSerpZone: "serp",
		brightdataUnlockerZone: "unlocker",
	}, `
		const urls = [];
		globalThis.fetch = async url => {
			urls.push(String(url));
			return urls.length === 1
				? new Response(JSON.stringify({ organic: [] }), { status: 200 })
				: new Response("# Unlocked\\n\\ncontent", { status: 200 });
		};
		const { searchWithBrightData } = await import(${JSON.stringify(modules.brightdata)});
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(modules["brightdata-unlocker"])});
		await searchWithBrightData("q");
		await extractWithBrightDataUnlocker("https://example.com", undefined, { lookup: ${publicLookup} });
		console.log(JSON.stringify(urls));
	`);
	assert.deepEqual(urls, ["https://gateway.test/brightdata/request", "https://gateway.test/brightdata/request"]);
});

test("search-only providers apply their configured base URL", async () => {
	const cases = [
		["brave", "searchWithBrave", "braveBaseUrl", "BRAVE_API_KEY", "res/v1/web/search"],
		["tavily", "searchWithTavily", "tavilyBaseUrl", "TAVILY_API_KEY", "search"],
		["searchinfinity", "searchWithSearchinfinity", "searchinfinityBaseUrl", "SEARCHINFINITY_API_KEY", "search_api/web_search"],
		["serpdive", "searchWithSerpdive", "serpdiveBaseUrl", "SERPDIVE_API_KEY", "v1/search"],
		["bocha", "searchWithBocha", "bochaBaseUrl", "BOCHA_API_KEY", "v1/web-search"],
		["anysearch", "searchWithAnySearch", "anysearchBaseUrl", "ANYSEARCH_API_KEY", "v1/search"],
		["xai-search", "searchWithXai", "xaiBaseUrl", "XAI_API_KEY", "v1/responses"],
		["serpbase", "searchWithSerpBase", "serpbaseBaseUrl", "SERPBASE_API_KEY", "google/search"],
		["valyu", "searchWithValyu", "valyuBaseUrl", "VALYU_API_KEY", "v1/search"],
		["serper", "searchWithSerper", "serperBaseUrl", "SERPER_API_KEY", "search"],
	];
	for (const [module, fn, field, envKey, path] of cases) {
		const base = `https://gateway.test/${module}`;
		const urls = await run({ [field]: `${base}/` }, `
			const urls = [];
			globalThis.fetch = async url => { urls.push(String(url)); return new Response("{}", { status: 200 }); };
			const api = await import(${JSON.stringify(modules[module])});
			await api[${JSON.stringify(fn)}]("q").catch(() => {});
			console.log(JSON.stringify(urls));
		`, { [envKey]: "test-key" });
		assert.equal(new URL(urls[0]).origin + new URL(urls[0]).pathname, `${base}/${path}`);
	}
});

test("Exa applies API and MCP base URLs to all search paths", async () => {
	const direct = await run({ exaBaseUrl: "https://gateway.test/exa/" }, `
		const urls = [];
		globalThis.fetch = async url => { urls.push(String(url)); return new Response("failure", { status: 500 }); };
		const { searchWithExa } = await import(${JSON.stringify(modules.exa)});
		await searchWithExa("answer").catch(() => {});
		await searchWithExa("search", { numResults: 2 }).catch(() => {});
		console.log(JSON.stringify(urls));
	`, { EXA_API_KEY: "test-key" });
	assert.deepEqual(direct, ["https://gateway.test/exa/answer", "https://gateway.test/exa/search"]);

	const mcp = await run({ exaMcpBaseUrl: "https://gateway.test/exa-mcp/" }, `
		const urls = [];
		globalThis.fetch = async url => { urls.push(String(url)); return new Response("failure", { status: 500 }); };
		const { searchWithExa } = await import(${JSON.stringify(modules.exa)});
		await searchWithExa("mcp").catch(() => {});
		console.log(JSON.stringify(urls));
	`, { EXA_API_KEY: "" });
	assert.match(mcp[0], /^https:\/\/gateway\.test\/exa-mcp\/mcp\?tools=/);
});
