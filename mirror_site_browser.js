#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.url) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

const startUrl = normalizeUrl(args.url);
if (!startUrl) {
  console.error('Invalid URL. Use http:// or https://');
  process.exit(1);
}

const outputDir = path.resolve(args.output || './mirror-browser');
const startHost = new URL(startUrl).host.toLowerCase();

const config = {
  outputDir,
  maxPages: Number(args.maxPages || 0),
  maxFiles: Number(args.maxFiles || 0),
  delayMs: Math.max(0, Number(args.delay || 400)),
  timeoutMs: Math.max(5000, Number(args.timeout || 45000)),
  externalAssets: args.externalAssets !== 'false',
  verbose: args.verbose !== 'false',
  waitUntil: args.waitUntil || 'networkidle',
};

const state = {
  pageQueue: [],
  queuedPages: new Set(),
  visitedPages: new Set(),
  savedUrls: new Map(),
  urlMeta: new Map(),
  failed: [],
  pageCount: 0,
  fileCount: 0,
  bytes: 0,
  activePageHost: startHost,
  crawlHosts: new Set([startHost]),
};

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

async function main() {
  await ensureDir(outputDir);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  });

  context.on('response', (response) => {
    void handleResponse(response).catch((error) => {
      log(`response save failed: ${error.message}`);
    });
  });

  enqueuePage(startUrl);

  while (state.pageQueue.length > 0) {
    if (config.maxPages && state.pageCount >= config.maxPages) {
      log(`Reached --max-pages=${config.maxPages}.`);
      break;
    }

    const url = state.pageQueue.shift();
    if (state.visitedPages.has(url)) {
      continue;
    }
    state.visitedPages.add(url);

    const page = await context.newPage();
    state.activePageHost = new URL(url).host.toLowerCase();
    state.crawlHosts.add(state.activePageHost);

    page.setDefaultTimeout(config.timeoutMs);
    page.setDefaultNavigationTimeout(config.timeoutMs);

    try {
      log(`OPEN ${url}`);
      const response = await page.goto(url, { waitUntil: config.waitUntil, timeout: config.timeoutMs });
      if (!response) {
        throw new Error('No navigation response');
      }

      await settlePage(page);

      const finalUrl = normalizeUrl(page.url()) || url;
      const finalHost = new URL(finalUrl).host.toLowerCase();
      state.activePageHost = finalHost;
      state.crawlHosts.add(finalHost);

      const html = await page.content();
      const pagePath = urlToWebPath(finalUrl, { kind: 'page', contentType: 'text/html' });
      const rewrittenHtml = rewriteHtml(html, finalUrl, pagePath);
      await writeFileForUrl(finalUrl, rewrittenHtml, 'text/html', 'page', pagePath);

      const links = await extractPageLinks(page);
      for (const link of links) {
        if (shouldQueuePage(link)) {
          enqueuePage(link);
        }
      }

      state.pageCount += 1;
      if (config.delayMs > 0) {
        await delay(config.delayMs);
      }
    } catch (error) {
      state.failed.push({ url, error: error.message });
      log(`FAIL ${url} :: ${error.message}`);
    } finally {
      await page.close();
    }
  }

  await rewriteSavedHtml();
  await rewriteSavedCss();
  await browser.close();

  console.log('------------------------------------------------------------');
  console.log(`Pages: ${state.pageCount}`);
  console.log(`Files: ${state.fileCount}`);
  console.log(`Bytes: ${(state.bytes / 1024).toFixed(1)} KB`);
  console.log(`Failed: ${state.failed.length}`);
  console.log(`Saved to: ${outputDir}`);
}

async function handleResponse(response) {
  const request = response.request();
  const url = normalizeUrl(response.url());
  if (!url) {
    return;
  }

  const status = response.status();
  if (status < 200 || status >= 400) {
    return;
  }

  if (config.maxFiles && state.fileCount >= config.maxFiles) {
    return;
  }

  const headers = response.headers();
  const contentType = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();

  let kind = classifyResource(url, contentType, request.resourceType());
  const host = new URL(url).host.toLowerCase();

  if (!isAllowedAssetHost(host, kind)) {
    return;
  }

  if (kind === 'page') {
    return;
  }

  if (state.savedUrls.has(url)) {
    return;
  }

  let body;
  try {
    body = await response.body();
  } catch {
    return;
  }

  let text = null;
  if (contentType.startsWith('text/') || /javascript|json|xml|svg|css/.test(contentType)) {
    text = body.toString('utf8');
  }

  const webPath = urlToWebPath(url, { kind, contentType });
  await writeFileForUrl(url, text ?? body, contentType, kind, webPath);
}

async function writeFileForUrl(url, content, contentType, kind, webPath) {
  if (config.maxFiles && state.fileCount >= config.maxFiles && !state.savedUrls.has(url)) {
    return;
  }

  const finalWebPath = webPath || urlToWebPath(url, { kind, contentType });
  const localPath = path.join(outputDir, finalWebPath.replace(/^\/+/, '').replace(/\//g, path.sep));
  const dir = path.dirname(localPath);

  await ensureDir(dir);

  if (Buffer.isBuffer(content)) {
    await fsp.writeFile(localPath, content);
    state.bytes += content.length;
  } else {
    await fsp.writeFile(localPath, content, 'utf8');
    state.bytes += Buffer.byteLength(content, 'utf8');
  }

  const isNew = !state.savedUrls.has(url);
  state.savedUrls.set(url, { localPath, webPath: finalWebPath });
  state.urlMeta.set(url, { contentType, kind, localPath, webPath: finalWebPath });
  if (isNew) {
    state.fileCount += 1;
  }

  log(`SAVE ${finalWebPath}`);
}

async function rewriteSavedCss() {
  for (const [url, meta] of state.urlMeta.entries()) {
    if (meta.kind !== 'asset') {
      continue;
    }
    if (!/\.css(?:__.*)?$/.test(meta.webPath) && meta.contentType !== 'text/css') {
      continue;
    }

    let css;
    try {
      css = await fsp.readFile(meta.localPath, 'utf8');
    } catch {
      continue;
    }

    const rewritten = rewriteCss(css, url, meta.webPath);
    if (rewritten !== css) {
      await fsp.writeFile(meta.localPath, rewritten, 'utf8');
    }
  }
}

async function rewriteSavedHtml() {
  for (const [url, meta] of state.urlMeta.entries()) {
    if (meta.kind !== 'page') {
      continue;
    }

    let html;
    try {
      html = await fsp.readFile(meta.localPath, 'utf8');
    } catch {
      continue;
    }

    const rewritten = rewriteHtml(html, url, meta.webPath);
    if (rewritten !== html) {
      await fsp.writeFile(meta.localPath, rewritten, 'utf8');
    }
  }
}

function rewriteHtml(html, pageUrl, pageWebPath) {
  html = html.replace(
    /\b(?:href|src|poster|data-src|data-href|action|content)\s*=\s*(['"])(.*?)\1/gi,
    (match, quote, value) => {
      const replaced = rewriteUrlReference(value, pageUrl, pageWebPath);
      return match.replace(value, replaced);
    }
  );

  html = html.replace(/\bsrcset\s*=\s*(['"])(.*?)\1/gi, (match, quote, value) => {
    const rewritten = value
      .split(',')
      .map((item) => {
        const trimmed = item.trim();
        if (!trimmed) return trimmed;
        const [urlPart, ...rest] = trimmed.split(/\s+/);
        const newUrl = rewriteUrlReference(urlPart, pageUrl, pageWebPath);
        return [newUrl, ...rest].join(' ').trim();
      })
      .join(', ');
    return match.replace(value, rewritten);
  });

  html = html.replace(/\bimagesrcset\s*=\s*(['"])(.*?)\1/gi, (match, quote, value) => {
    const rewritten = value
      .split(',')
      .map((item) => {
        const trimmed = item.trim();
        if (!trimmed) return trimmed;
        const [urlPart, ...rest] = trimmed.split(/\s+/);
        const newUrl = rewriteUrlReference(urlPart, pageUrl, pageWebPath);
        return [newUrl, ...rest].join(' ').trim();
      })
      .join(', ');
    return match.replace(value, rewritten);
  });

  html = html.replace(/\bstyle\s*=\s*(['"])(.*?)\1/gi, (match, quote, value) => {
    return match.replace(value, rewriteCss(value, pageUrl, pageWebPath));
  });

  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
    return match.replace(css, rewriteCss(css, pageUrl, pageWebPath));
  });

  return html;
}

function rewriteCss(css, ownerUrl, ownerWebPath) {
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, value) => {
    return `url(${quote}${rewriteUrlReference(value, ownerUrl, ownerWebPath)}${quote})`;
  });

  css = css.replace(/@import\s+(url\(\s*)?(['"])([^'"]+)\2(\s*\))?/gi, (match, urlStart = '', quote, value, urlEnd = '') => {
    const rewritten = rewriteUrlReference(value, ownerUrl, ownerWebPath);
    return `@import ${urlStart}${quote}${rewritten}${quote}${urlEnd}`;
  });

  return css;
}

function rewriteUrlReference(value, baseUrl, ownerWebPath) {
  const normalized = normalizeUrl(value, baseUrl);
  if (!normalized) {
    return value;
  }

  const saved = state.savedUrls.get(normalized);
  if (!saved) {
    return value;
  }

  return relativeWebPath(ownerWebPath, saved.webPath);
}

async function settlePage(page) {
  await delay(1200);
  await autoScroll(page);
  await delay(800);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 700;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        const max = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        );
        if (total >= max + 1000) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 180);
    });
  });
}

async function extractPageLinks(page) {
  const rawLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.href)
      .filter(Boolean);
  });

  return rawLinks
    .map((item) => normalizeUrl(item))
    .filter(Boolean);
}

function shouldQueuePage(url) {
  if (!url) {
    return false;
  }
  if (state.queuedPages.has(url) || state.visitedPages.has(url)) {
    return false;
  }

  const parsed = new URL(url);
  const host = parsed.host.toLowerCase();
  if (!state.crawlHosts.has(host) && host !== startHost) {
    return false;
  }

  const ext = extname(parsed.pathname);
  if (isAssetExtension(ext)) {
    return false;
  }

  return true;
}

function enqueuePage(url) {
  if (state.queuedPages.has(url) || state.visitedPages.has(url)) {
    return;
  }
  state.queuedPages.add(url);
  state.pageQueue.push(url);
}

function classifyResource(url, contentType, resourceType) {
  const ext = extname(new URL(url).pathname);

  if (resourceType === 'document') {
    return 'page';
  }
  if (resourceType === 'stylesheet' || resourceType === 'image' || resourceType === 'font' || resourceType === 'media') {
    return 'asset';
  }
  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    return 'page';
  }
  if (contentType.includes('text/css') || contentType.includes('javascript') || contentType.startsWith('image/') || contentType.startsWith('font/')) {
    return 'asset';
  }
  if (isAssetExtension(ext)) {
    return 'asset';
  }

  return 'asset';
}

function isAllowedAssetHost(host, kind) {
  if (state.crawlHosts.has(host) || host === startHost) {
    return true;
  }
  return kind === 'asset' && config.externalAssets;
}

function urlToWebPath(url, { kind, contentType }) {
  const parsed = new URL(url);
  const host = parsed.host.toLowerCase();
  let pathname = parsed.pathname || '/';

  pathname = pathname.replace(/\/+/g, '/');
  if (pathname === '/' || pathname.endsWith('/')) {
    pathname += kind === 'page' ? 'index.html' : 'index';
  }

  let ext = extname(pathname);
  if (kind === 'page' && !ext) {
    pathname += '.html';
    ext = '.html';
  }
  if (kind === 'asset' && !ext) {
    pathname += guessExtension(contentType);
  }

  if (parsed.search) {
    const safeSearch = parsed.search.slice(1).replace(/[^\w.-]+/g, '_');
    pathname = pathname.replace(/(\.[^./]+)?$/, (_, found = '') => `__${safeSearch}${found}`);
  }

  pathname = pathname.replace(/[\\:*?"<>|]/g, '_');

  if (host !== startHost) {
    return `/_external/${host}${pathname}`;
  }
  return pathname;
}

function relativeWebPath(fromWebPath, toWebPath) {
  const cleanFrom = ensureWebPath(fromWebPath);
  const cleanTo = ensureWebPath(toWebPath);
  const fromDir = cleanFrom.replace(/\/[^/]*$/, '/');
  const fromParts = fromDir.split('/').filter(Boolean);
  const toParts = cleanTo.split('/').filter(Boolean);

  while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  const relParts = [];
  for (let i = 0; i < fromParts.length; i += 1) {
    relParts.push('..');
  }
  relParts.push(...toParts);
  return relParts.join('/') || '.';
}

function ensureWebPath(input) {
  const outRoot = outputDir.replace(/\\/g, '/').toLowerCase();
  let value = String(input || '').replace(/\\/g, '/');

  if (!value) {
    return '/';
  }

  const lower = value.toLowerCase();
  const idx = lower.indexOf(outRoot);
  if (idx !== -1) {
    value = value.slice(idx + outRoot.length);
  }

  value = value.replace(/^file:\/\/\/?/i, '/');
  value = value.replace(/^[a-z]:/i, '');
  value = value.replace(/^\/+/, '/');
  if (!value.startsWith('/')) {
    value = '/' + value;
  }
  return value;
}

function normalizeUrl(raw, base) {
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    if (!/^https?:$/i.test(url.protocol)) {
      return null;
    }
    url.hash = '';
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    return url.toString();
  } catch {
    return null;
  }
}

function guessExtension(contentType) {
  if (/css/.test(contentType)) return '.css';
  if (/javascript/.test(contentType)) return '.js';
  if (/json/.test(contentType)) return '.json';
  if (/svg/.test(contentType)) return '.svg';
  if (/png/.test(contentType)) return '.png';
  if (/jpe?g/.test(contentType)) return '.jpg';
  if (/webp/.test(contentType)) return '.webp';
  if (/woff2/.test(contentType)) return '.woff2';
  if (/woff/.test(contentType)) return '.woff';
  if (/ttf/.test(contentType)) return '.ttf';
  if (/otf/.test(contentType)) return '.otf';
  return '.bin';
}

function extname(pathname) {
  const ext = path.posix.extname(pathname || '').toLowerCase();
  return ext;
}

function isAssetExtension(ext) {
  return new Set([
    '.css', '.js', '.mjs', '.map',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.mp4', '.webm', '.mp3', '.wav', '.ogg',
    '.pdf', '.json', '.xml', '.txt', '.webmanifest'
  ]).has(ext);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      if (!parsed.url) {
        parsed.url = item;
      } else if (!parsed.output) {
        parsed.output = item;
      }
      continue;
    }

    const [key, inlineValue] = item.slice(2).split('=', 2);
    const value = inlineValue !== undefined ? inlineValue : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    parsed[toCamel(key)] = value;
  }
  return parsed;
}

function toCamel(input) {
  return input.replace(/-([a-z])/g, (_, chr) => chr.toUpperCase());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function log(message) {
  if (!config.verbose) {
    return;
  }
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${message}`);
}

function printUsage() {
  console.log(`Usage:
  node mirror_site_browser.js <url> [output_dir] [options]

Options:
  --max-pages <n>          Limit HTML pages crawled
  --max-files <n>          Limit total saved files
  --delay <ms>             Delay between page visits, default 400
  --timeout <ms>           Navigation timeout, default 45000
  --wait-until <state>     load | domcontentloaded | networkidle
  --external-assets=false  Skip CDN fonts/images/scripts
  --verbose=false          Reduce logs

Examples:
  node mirror_site_browser.js https://example.com ./mirror
  node mirror_site_browser.js https://example.com --max-pages 100 --delay 800
`);
}
