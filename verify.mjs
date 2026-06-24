// Self-contained reproduction check. One process: builds, serves, drives a real
// browser, then asserts. Run `pnpm verify` after `pnpm install`.
//
// Builds the same Counter four ways and drives each in headless Chromium:
//   1. non-inline compile + prod runtime, hydration   (Astro-style prod):  inert
//   2. inline compile + prod runtime, hydration        (default vite build): works
//   3. non-inline compile + dev runtime, hydration     (control):            works
//   4. non-inline compile + prod runtime, fresh mount  (no SSR):             crashes
//
// 1-3 hydrate the server-rendered button in index.html. 4 mounts Counter into an
// empty container with createVaporApp (mount.html / src/mount.ts): the same
// handleSetupResult bug throws instead of going inert. `node confirm-fix.mjs`
// shows the one-line runtime patch makes both surfaces interactive.
import { existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import { build } from 'vite'

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

function serve(root) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0])
    let f = normalize(join(root, p))
    if (!f.startsWith(root)) return res.writeHead(403).end()
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html')
    if (!existsSync(f)) return res.writeHead(404).end('not found')
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' })
    res.end(readFileSync(f))
  })
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({ port: server.address().port, close: () => server.close() }),
    ),
  )
}

// configFile:false so each variant supplies its own plugin and controls inline
// vs non-inline; loading vite.config.ts too would run the vue plugin twice. A
// custom html `input` (the fresh-mount page) is emitted under its own basename,
// so the probe navigates to that path, not `/`.
async function buildVariant(outDir, pluginOpts, devRuntime = false, input) {
  await build({
    root: process.cwd(),
    configFile: false,
    logLevel: 'error',
    plugins: [vue(pluginOpts)],
    resolve: devRuntime
      ? { alias: { vue: 'vue/dist/vue.runtime-with-vapor.esm-browser.js' } }
      : undefined,
    build: {
      outDir,
      emptyOutDir: true,
      ...(input ? { rollupOptions: { input: resolve(process.cwd(), input) } } : {}),
    },
  })
}

async function probe(url) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(150)
    // A crashed fresh mount renders no button (mountApp clears #app, then throws).
    if ((await page.locator('button').count()) === 0) {
      return { before: null, after: null, evtclick: null, reactive: false, error: errors[0] || null }
    }
    const btn = page.getByRole('button', { name: /count is/ })
    const before = (await btn.textContent())?.trim()
    const evtclick = await btn.evaluate((el) => typeof el.$evtclick)
    await btn.click()
    await page.waitForTimeout(100)
    const after = (await btn.textContent())?.trim()
    return { before, after, evtclick, reactive: before !== after, error: errors[0] || null }
  } finally {
    await browser.close()
  }
}

const variants = [
  { label: 'non-inline + prod, hydration  [the bug]', outDir: 'dist-noninline', opts: { features: { prodDevtools: true } }, dev: false, page: '/', ok: (r) => r.reactive === false && r.evtclick === 'undefined' && !r.error },
  { label: 'inline + prod, hydration', outDir: 'dist-inline', opts: {}, dev: false, page: '/', ok: (r) => r.reactive === true && r.evtclick === 'function' && !r.error },
  { label: 'non-inline + dev, hydration (control)', outDir: 'dist-noninline-dev', opts: { features: { prodDevtools: true } }, dev: true, page: '/', ok: (r) => r.reactive === true && r.evtclick === 'function' && !r.error },
  { label: 'non-inline + prod, fresh mount [crashes, no SSR]', outDir: 'dist-noninline-mount', opts: { features: { prodDevtools: true } }, dev: false, input: 'mount.html', page: '/mount.html', ok: (r) => r.before === null && /reading 'anchor'/.test(r.error || '') },
]

let ok = true
for (const v of variants) {
  await buildVariant(v.outDir, v.opts, v.dev, v.input)
  const srv = await serve(join(process.cwd(), v.outDir))
  const r = await probe(`http://127.0.0.1:${srv.port}${v.page}`)
  srv.close()
  const pass = v.ok(r)
  ok &&= pass
  const tail = r.error ? `  error=${r.error.split('\n')[0]}` : ''
  console.log(
    `${pass ? '✓' : '✗'} ${v.label}: "${r.before}" -> "${r.after}"  $evtclick=${r.evtclick}  reactive=${r.reactive}${tail}`,
  )
}

console.log(ok
  ? '\nReproduced: non-inline + prod is broken — inert when hydrated, crashes when mounted fresh; inline + prod and the dev runtime are interactive.'
  : '\nUnexpected result.')
process.exit(ok ? 0 : 1)
