<script setup vapor lang="ts">
import { computed, ref } from 'vue'
import TodoItem from './TodoItem.vue'

interface Todo { id: number; text: string; done: boolean }
const todos = ref<Todo[]>([
  { id: 0, text: 'alpha', done: false },
  { id: 1, text: 'beta', done: false },
  { id: 2, text: 'gamma', done: false },
])
const checked = computed(() => todos.value.filter((t) => t.done).length)
function toggle(id: number) {
  const t = todos.value.find((x) => x.id === id)
  if (t) t.done = !t.done
}
</script>

<template>
  <section class="todo">
    <p class="sum" data-testid="sum">{{ checked }} of {{ todos.length }} checked</p>
    <ul>
      <TodoItem
        v-for="t in todos"
        :key="t.id"
        :text="t.text"
        :done="t.done"
        @toggle="toggle(t.id)"
      />
    </ul>
  </section>
</template>
