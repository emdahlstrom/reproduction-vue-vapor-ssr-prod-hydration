import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
  const { render } = (await vite.ssrLoadModule('/src/entry-server.ts')) as { render: () => Promise<string> }
  const appHtml = await render()
  writeFileSync('index.html', readFileSync('index.template.html','utf-8').replace('<!--app-html-->', appHtml))
  console.log('SSR:', appHtml)
} finally { await vite.close() }
