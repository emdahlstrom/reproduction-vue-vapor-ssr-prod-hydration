// Self-contained reproduction check. One process: builds, serves, drives a real
// browser, then asserts. Run `pnpm verify` after `pnpm prerender`.
//
// Builds the same app three ways and hydrates each in headless Chromium, then
// clicks the counter button and checks whether its text changes:
//   1. non-inline compile + prod runtime  (what an Astro prod build emits): dead
//   2. inline compile + prod runtime       (default `vite build`):          works
//   3. non-inline compile + dev runtime    (control):                       works
import { existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import { extname, join, normalize } from 'node:path'
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
// vs non-inline; loading vite.config.ts too would run the vue plugin twice.
async function buildVariant(outDir, pluginOpts, devRuntime = false) {
  await build({
    root: process.cwd(),
    configFile: false,
    logLevel: 'error',
    plugins: [vue(pluginOpts)],
    resolve: devRuntime
      ? { alias: { vue: 'vue/dist/vue.runtime-with-vapor.esm-browser.js' } }
      : undefined,
    build: { outDir, emptyOutDir: true },
  })
}

async function probe(url) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(150)
    const btn = page.getByRole('button', { name: /count is/ })
    const before = (await btn.textContent())?.trim()
    const evtclick = await btn.evaluate((el) => typeof el.$evtclick)
    await btn.click()
    await page.waitForTimeout(100)
    const after = (await btn.textContent())?.trim()
    return { before, after, evtclick, reactive: before !== after }
  } finally {
    await browser.close()
  }
}

const variants = [
  { label: 'non-inline + prod runtime  [the bug]', outDir: 'dist-noninline', opts: { features: { prodDevtools: true } }, dev: false, expect: false },
  { label: 'inline + prod runtime', outDir: 'dist-inline', opts: {}, dev: false, expect: true },
  { label: 'non-inline + dev runtime (control)', outDir: 'dist-noninline-dev', opts: { features: { prodDevtools: true } }, dev: true, expect: true },
]

let ok = true
for (const v of variants) {
  await buildVariant(v.outDir, v.opts, v.dev)
  const srv = await serve(join(process.cwd(), v.outDir))
  const r = await probe(`http://127.0.0.1:${srv.port}/`)
  srv.close()
  const pass = r.reactive === v.expect
  ok &&= pass
  console.log(
    `${pass ? '✓' : '✗'} ${v.label}: "${r.before}" -> "${r.after}"  $evtclick=${r.evtclick}  reactive=${r.reactive}`,
  )
}

console.log(ok ? '\nReproduced: non-inline + prod is dead; the other two are interactive.' : '\nUnexpected result.')
process.exit(ok ? 0 : 1)
