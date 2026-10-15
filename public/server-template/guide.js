// The server guide as a page of the site. It renders README.md, next to it, so the page and
// the Markdown on GitHub are always the same guide; adds contents, Copy buttons and the theme
// toggle; and shows the files the guide links to (example.json, the examples) in a side viewer.

import { escapeHtml, renderMarkdown } from './markdown.js';

const REPO = 'https://github.com/patrick-glean/mcp-browswer-client';
// Where README.md is in the repo, to resolve its relative links.
const FOLDER = 'public/server-template/';
// Files of the guide's that the viewer shows, rather than following the link.
const VIEWABLE = /\.(json|md|go|mod|sum|ts|mjs|js|py|txt|rs|toml|java|xml|cs|csproj)$/i;

// Where a link in README.md goes from this page: anchors stay, other sites open in a new tab,
// files in public/ are the site's own, and the rest of the repo is on GitHub.
function link(href) {
    if (href.startsWith('#')) return { href };
    if (/^[a-z][a-z\d+.-]*:/i.test(href)) return { href, external: true };
    const resolved = new URL(href, `https://repo.invalid/${FOLDER}`);
    if (!resolved.pathname.startsWith('/public/')) {
        return { href: `${REPO}/blob/main${resolved.pathname}${resolved.hash}`, external: true };
    }
    const inSite = resolved.pathname.slice('/public/'.length);
    const here = `${new URL(`../${inSite}`, location.href).href}${resolved.hash}`;
    const own = inSite.startsWith('server-template/') ? inSite.slice('server-template/'.length) : null;
    return { href: here, file: own && VIEWABLE.test(own) ? own : undefined };
}

async function copyText(text, button) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const area = Object.assign(document.createElement('textarea'), { value: text });
        document.body.append(area);
        area.select();
        document.execCommand('copy');
        area.remove();
    }
    const label = button.querySelector('.btn-label') || button;
    label.textContent = 'Copied';
    setTimeout(() => { label.textContent = 'Copy'; }, 1500);
}

function addCopyButtons(root) {
    for (const block of root.querySelectorAll('pre.md-code')) {
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn-sm guide-code-copy' });
        button.innerHTML = '<span class="btn-label">Copy</span>';
        button.addEventListener('click', () => copyText(block.querySelector('code').textContent, button));
        block.append(button);
    }
}

// The contents column: every section and subsection, with the one being read marked.
function showContents(headings) {
    const nav = document.getElementById('contents');
    const sections = headings.filter(heading => heading.level === 2 || heading.level === 3);
    nav.innerHTML = `<p class="guide-contents-title">On this page</p><ol>${sections
        .map(heading => `<li class="level-${heading.level}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`)
        .join('')}</ol>`;
    const links = new Map([...nav.querySelectorAll('a')].map(anchor => [decodeURIComponent(anchor.hash.slice(1)), anchor]));
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            nav.querySelector('a[aria-current]')?.removeAttribute('aria-current');
            links.get(entry.target.id)?.setAttribute('aria-current', 'true');
        }
    }, { rootMargin: '-60px 0px -70% 0px' });
    for (const { id } of sections) {
        const heading = document.getElementById(id);
        if (heading) observer.observe(heading);
    }
}

async function showGuide() {
    const main = document.getElementById('guide');
    let source;
    try {
        const response = await fetch('README.md', { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        source = await response.text();
    } catch (error) {
        main.innerHTML = `<p class="text-error">Couldn't load the guide (${escapeHtml(error.message)}). It's also <a href="${REPO}/blob/main/${FOLDER}README.md">on GitHub</a>.</p>`;
        return;
    }
    const { html, headings } = renderMarkdown(source, { link });
    main.innerHTML = html;
    addCopyButtons(main);
    showContents(headings);
    if (headings[0]) document.title = `${headings[0].text} · MCP Browser Client`;
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    main.dataset.rendered = 'true';
}

// --- The file viewer ---

const viewer = document.getElementById('viewer');

async function showFile(path) {
    viewer.hidden = false;
    viewer.querySelector('[data-path]').textContent = path;
    viewer.querySelector('[data-raw]').href = path;
    viewer.querySelector('[data-raw]').download = path.split('/').pop();
    viewer.querySelector('[data-github]').href = `${REPO}/blob/main/${FOLDER}${path}`;
    const code = viewer.querySelector('pre code');
    code.textContent = 'Loading…';
    viewer.dataset.file = path;
    viewer.querySelector('[data-close-viewer]').focus();
    try {
        const response = await fetch(path, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (viewer.dataset.file === path) code.textContent = text;
    } catch (error) {
        if (viewer.dataset.file === path) code.textContent = `Couldn't load ${path}: ${error.message}`;
    }
}

function closeFile() {
    viewer.hidden = true;
    delete viewer.dataset.file;
}

document.addEventListener('click', event => {
    const anchor = event.target.closest('a[data-file]');
    if (anchor && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        return showFile(anchor.dataset.file);
    }
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.showFile) return showFile(button.dataset.showFile);
    if (button.dataset.closeViewer !== undefined) return closeFile();
    if (button.dataset.copyFile !== undefined) return copyText(viewer.querySelector('pre code').textContent, button);
    if (button.id === 'themeToggle') {
        const dark = document.documentElement.classList.toggle('dark-theme');
        localStorage.setItem('theme', dark ? 'dark' : 'light');
    }
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !viewer.hidden) closeFile();
});

showGuide();
