// Cloudflare Pages static output. Only browser assets are published; tests and tooling stay out.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url), out = new URL('dist/', root);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of ['index.html', 'app.js', 'logic.js', 'styles.css', '_headers', '404.html', 'icon.svg']) {
  cpSync(new URL(file, root), new URL(file, out));
}
console.log('Static build ready:', fileURLToPath(out));
