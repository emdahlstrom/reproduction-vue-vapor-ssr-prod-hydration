import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { Root } from './app'
export async function render(): Promise<string> {
  return await renderToString(createSSRApp(Root))
}
