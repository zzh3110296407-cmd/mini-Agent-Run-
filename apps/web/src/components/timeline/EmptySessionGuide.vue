<script setup lang="ts">
import UiIcon from '../ui/UiIcon.vue';
defineProps<{ targetPath: string }>();
</script>

<template>
  <section class="empty-guide" data-testid="empty-session-guide">
    <div class="guide-icon"><UiIcon name="terminal" :size="24" /></div>
    <h2>开始排查</h2>
    <code>{{ targetPath }}</code>
    <p>在下方描述你观察到的问题，排查结果会按轮次保留在此会话中。</p>
  </section>
</template>

<style scoped>
.empty-guide { display: grid; justify-items: center; gap: 8px; max-width: 530px; margin: clamp(16px, 8vh, 74px) auto 0; padding: 16px; text-align: center; }
.guide-icon { display: grid; place-items: center; width: 43px; height: 43px; margin-bottom: 3px; border: 1px solid var(--accent-soft-border); border-radius: var(--radius-lg); background: var(--accent-soft-bg); color: var(--accent-soft-fg); }
h2, p { margin: 0; }
h2 { font-size: 16px; }
code { max-width: 100%; overflow-wrap: anywhere; color: var(--text-code); font: 12px/18px var(--font-mono); }
p { color: var(--text-secondary); }
</style>
