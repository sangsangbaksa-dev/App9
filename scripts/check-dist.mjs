// Validate the actual Cloudflare Pages output without network requests or dependencies.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
assert.ok(existsSync(join(root, 'index.html')), 'Build dist/ first');
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const f = join(dir, name), rel = relative(root, f);
    assert.ok(!name.startsWith('.') && !['node_modules', 'docs', 'test', 'tests', 'scripts', 'design', 'functions', 'api', 'lib'].includes(name), `Non-public path: ${rel}`);
    assert.ok(!/^(README|package|wrangler|vercel)([.\-]|$)/i.test(name), `Tooling file: ${rel}`);
    if (statSync(f).isDirectory()) walk(f); else files.push(f);
  }
}
walk(root);
assert.ok(existsSync(join(root, '404.html')), 'Missing 404.html: Pages otherwise falls back to a successful SPA response');
assert.ok(existsSync(join(root, '_headers')), 'Missing Pages security headers');
assert.match(readFileSync(join(root, '_headers'), 'utf8'), /Content-Security-Policy:/i);
function localTarget(file, ref) {
  if (!ref || ref.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) return;
  const path = decodeURIComponent(ref.split(/[?#]/)[0].replace(/&amp;/g, '&'));
  if (!path) return;
  const target = path.startsWith('/') ? resolve(root, '.' + path) : resolve(dirname(file), path);
  assert.ok(target === root || target.startsWith(root + sep), `Path escapes output: ${ref}`);
  assert.ok([target, target + '.html', join(target, 'index.html')].some(f => existsSync(f) && statSync(f).isFile()), `Broken local link in ${relative(root, file)}: ${ref}`);
}
for (const file of files) {
  if (extname(file) !== '.html') continue;
  const html = readFileSync(file, 'utf8');
  assert.match(html, /<html\b[^>]*\blang=["'][^"']+["']/i, `Missing page language: ${file}`);
  assert.match(html, /<title>[^<]+<\/title>/i, `Missing title: ${file}`);
  for (const tag of html.matchAll(/<(?:a|link|script|img|source|iframe)\b[^>]*>/gi)) {
    for (const attr of tag[0].matchAll(/\b(?:src|href)=["']([^"']*)["']/gi)) localTarget(file, attr[1]);
  }
}
console.log(`Checked ${files.length} public files: local links and output boundaries OK`);
