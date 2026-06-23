import { createSSRApp, vaporInteropPlugin } from 'vue'
import { Root } from './app'
const app = createSSRApp(Root)
app.use(vaporInteropPlugin)
app.mount('#app')
