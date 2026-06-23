import { h } from 'vue'
import Counter from './Counter.vue'
import TodoList from './TodoList.vue'

export const Root = {
  render: () => h('div', [h(Counter), h(TodoList)]),
}
