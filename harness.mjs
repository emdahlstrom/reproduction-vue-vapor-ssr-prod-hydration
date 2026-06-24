// Shared test harness for verify.mjs (reproduce) and confirm-fix.mjs (confirm the
// fix): build a variant of the app, serve the output, drive it in a real browser,
// and report what the counter button did.
import { existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import { build } from 'vite'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

function serve(root) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0])
    const f = normalize(join(root, p === '/' ? '/index.html' : p))
    if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' })
    res.end(readFileSync(f))
  })
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r({ port: server.address().port, close: () => server.close() })),
  )
}

// inline=false → non-inline codegen (a separate render(), the case that breaks).
// dev=true → load the development runtime (control). input → a custom html entry,
// emitted under its own basename (so the probe navigates to that path, not `/`).
// configFile:false so each variant controls its own compile; vite.config.ts would
// otherwise run the vue plugin twice.
function buildApp({ outDir, input, inline = false, dev = false, minify = true }) {
  return build({
    root: process.cwd(),
    configFile: false,
    logLevel: 'error',
    plugins: [vue(inline ? {} : { features: { prodDevtools: true } })],
    resolve: dev ? { alias: { vue: 'vue/dist/vue.runtime-with-vapor.esm-browser.js' } } : undefined,
    build: { outDir, emptyOutDir: true, minify, ...(input ? { rollupOptions: { input: resolve(process.cwd(), input) } } : {}) },
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

// Build a variant, serve it, probe the button.
// Returns { before, after, evtclick, reactive, error }.
export async function buildServeProbe({ outDir, page = '/', ...opts }) {
  await buildApp({ outDir, ...opts })
  const srv = await serve(join(process.cwd(), outDir))
  try {
    return await probe(`http://127.0.0.1:${srv.port}${page}`)
  } finally {
    srv.close()
  }
}

// Does a probe result show a working button (handler wired and reactive)?
export const interactive = (r) => r.reactive === true && r.evtclick === 'function' && !r.error
