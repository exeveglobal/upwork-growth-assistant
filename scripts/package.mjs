// Builds the Chrome Web Store upload file:  npm run package   ->  dist/upwork-growth-assistant-<version>.zip
//
// Only runtime files go in (a whitelist, so tests, tooling and sources never slip in), and the build is
// refused if the zip would be broken: every file the manifest, the HTML, the CSS or an import refers to
// must be inside it, and nothing may load remote code.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const fail = (msg) => { console.error(`\nNOT PACKAGED: ${msg}`); process.exit(1); };

// ── what goes in ────────────────────────────────────────────────────────────
const NOT_RUNTIME = new Set(['generate_icons.js']);
const files = new Set(['manifest.json', 'LICENSE', 'sidepanel.html', 'sidepanel.css']);
for (const f of fs.readdirSync(root)) if (f.endsWith('.js') && !NOT_RUNTIME.has(f)) files.add(f);
for (const size of [16, 32, 48, 128]) files.add(`icons/icon${size}.png`);
for (const dir of ['fonts', 'brand']) for (const f of fs.readdirSync(path.join(root, dir))) files.add(`${dir}/${f}`);
for (const f of files) if (!fs.existsSync(path.join(root, f))) fail(`${f} is missing`);

// ── checks ──────────────────────────────────────────────────────────────────
const need = (ref, from) => { const p = path.posix.normalize(ref.replace(/^\//, '')); if (!files.has(p)) fail(`${from} refers to ${p}, which is not in the package`); };
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

need(manifest.background.service_worker, 'manifest background');
need(manifest.side_panel.default_path, 'manifest side_panel');
for (const cs of manifest.content_scripts ?? []) for (const js of cs.js ?? []) need(js, 'manifest content_scripts');
for (const icon of Object.values(manifest.icons ?? {})) need(icon, 'manifest icons');

for (const f of files) {
  const text = f.match(/\.(js|html|css)$/) ? read(f) : '';
  if (f.endsWith('.js')) {
    for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) need(path.posix.join(path.posix.dirname(f), m[1] ?? m[2]), f);
    if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) fail(`${f} uses eval or new Function (not allowed in the store)`);
    if (/import\(\s*['"]https?:|importScripts\(\s*['"]https?:/.test(text)) fail(`${f} loads remote code`);
  }
  if (f.endsWith('.html')) {
    for (const m of text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      if (/^https?:/.test(m[1])) fail(`${f} loads ${m[1]} from the network (remote resources are not allowed)`);
      need(m[1], f);
    }
  }
  if (f.endsWith('.css')) {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      if (/^(data:|https?:)/.test(m[1])) fail(`${f} uses ${m[1].slice(0, 30)}... (only bundled files are allowed)`);
      need(m[1], f);
    }
  }
}
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail(`version "${manifest.version}" is not valid`);
if (manifest.description.length > 132) fail(`description is ${manifest.description.length} characters (store limit 132)`);
if (manifest.name.length > 45) fail('name is longer than 45 characters');
if ('key' in manifest) fail('manifest has a "key" field: remove it before uploading');
if ((manifest.host_permissions ?? []).some((h) => /localhost|127\.0\.0\.1|<all_urls>|\*:\/\/\*\/\*/.test(h))) fail('host_permissions are broader than the store allows for this extension');

// ── build ───────────────────────────────────────────────────────────────────
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const zip = path.join(dist, `upwork-growth-assistant-${manifest.version}.zip`);
fs.rmSync(zip, { force: true });
const list = [...files].sort();
execFileSync('zip', ['-X', '-q', zip, ...list], { cwd: root });

const listed = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean);
if (listed[0] !== 'icons/icon128.png' && !listed.includes('manifest.json')) fail('manifest.json is not at the top level of the zip');
const size = fs.statSync(zip).size;
console.log(`Packaged ${listed.length} files, ${(size / 1024).toFixed(0)} KB: ${path.relative(root, zip)}`);
console.log(`Version ${manifest.version}; permissions: ${manifest.permissions.join(', ')}; hosts: ${manifest.host_permissions.join(', ')}`);
