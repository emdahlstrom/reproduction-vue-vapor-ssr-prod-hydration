<script setup vapor lang="ts">
import { ref } from 'vue'
defineProps<{ text: string; done: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
const selfClicks = ref(0) // child-owned reactive state
</script>

<template>
  <li>
    <label>
      <input type="checkbox" :checked="done" @change="emit('toggle')" />
      <span>{{ text }}</span>
    </label>
    <button type="button" class="self" @click="selfClicks++">self {{ selfClicks }}</button>
  </li>
</template>
