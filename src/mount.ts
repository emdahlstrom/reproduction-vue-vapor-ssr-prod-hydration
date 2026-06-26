import { createVaporApp } from 'vue'
import Counter from './Counter.vue'

// Fresh mount, no SSR — the #1 crash surface: insert() reads `.anchor` off the
// setup() bindings object and throws.
createVaporApp(Counter).mount('#app')
