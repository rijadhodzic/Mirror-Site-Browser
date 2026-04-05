# Mirror-Site-Browser
A headless browser-based website crawler and mirroring tool built with Playwright. It crawls a target website, downloads all pages and assets, rewrites internal links to work offline, and saves everything to a local directory.

## ✨ Features

- Renders JavaScript-heavy pages using a real Chromium browser
- Auto-scrolls pages to trigger lazy-loaded content
- Downloads HTML, CSS, JS, images, fonts, and other assets
- Rewrites all internal links and asset URLs to work offline
- Supports external CDN assets (fonts, scripts, images)
- Configurable crawl limits, delays, and timeouts

---

## 📋 Requirements

- [Node.js](https://nodejs.org/) v16 or higher
- [Playwright](https://playwright.dev/) with Chromium

### Install dependencies

```bash
npm install playwright
npx playwright install chromium
```

---

## 🚀 Usage

### Basic syntax

```bash
node mirror_site_browser.js <url> [output_dir] [options]
```

### Windows examples (XAMPP)

**Mirror a site to a local folder:**
```cmd
node C:\xampp\htdocs\mirror_site_browser.js https://target-site.com/ C:\xampp\htdocs\mirror-target
```

**With page and delay limits:**
```cmd
node C:\xampp\htdocs\mirror_site_browser.js https://target-site.com/ C:\xampp\htdocs\mirror-target --max-pages 50 --delay 800
```

**Quiet mode, no external assets:**
```cmd
node C:\xampp\htdocs\mirror_site_browser.js https://target-site.com/ C:\xampp\htdocs\mirror-target --external-assets=false --verbose=false
```

### Linux / macOS examples

```bash
node mirror_site_browser.js https://example.com ./mirror-output
node mirror_site_browser.js https://example.com ./mirror-output --max-pages 100 --delay 600
```

---

## ⚙️ Options

| Option | Default | Description |
|--------|---------|-------------|
| `--max-pages <n>` | `0` (unlimited) | Stop after crawling this many HTML pages |
| `--max-files <n>` | `0` (unlimited) | Stop after saving this many total files |
| `--delay <ms>` | `400` | Milliseconds to wait between page visits |
| `--timeout <ms>` | `45000` | Navigation timeout per page in milliseconds |
| `--wait-until <state>` | `networkidle` | When to consider a page loaded: `load`, `domcontentloaded`, or `networkidle` |
| `--external-assets=false` | `true` | Skip downloading assets from external CDN domains |
| `--verbose=false` | `true` | Suppress per-file log output |

---

## 📁 Output Structure

```
mirror-target/
├── index.html                  # Mirrored home page
├── about.html
├── blog/
│   ├── index.html
│   └── post-title.html
├── assets/
│   ├── style.css
│   └── logo.png
└── _external/                  # Assets from external domains (CDN, fonts, etc.)
    └── cdn.example.com/
        └── font.woff2
```

All links within downloaded pages are rewritten to use relative paths, so the mirror works fully offline or when served from a local web server like XAMPP.

---

## 🔧 How It Works

1. Launches a headless Chromium browser via Playwright
2. Navigates to each queued page and waits for it to fully load
3. Auto-scrolls each page to trigger lazy-loaded images and content
4. Intercepts all network responses and saves assets (CSS, JS, images, fonts)
5. Extracts all `<a href>` links and queues same-host pages for crawling
6. Rewrites HTML and CSS files to use relative local paths
7. Saves everything to the output directory

---

## ⚠️ Notes & Tips

- **Respect `robots.txt`** and the target site's terms of service before crawling.
- Use `--delay` to be polite to the target server and avoid rate limiting. A value of `800`–`1200` ms is recommended for public sites.
- Use `--max-pages` during testing to do a small trial run before a full mirror.
- `--wait-until=networkidle` is the most thorough option but slowest. Use `load` for faster crawls of simpler sites.
- The tool only crawls pages on the same hostname as the start URL. It will not follow links to other domains.
- If a page fails to load, it is logged and skipped — the crawl continues.

---

## 📝 License
MIT — use freely, modify as needed.

