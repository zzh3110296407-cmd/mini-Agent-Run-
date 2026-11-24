<script setup lang="ts">
import { HealthResponseSchema, type HealthResponse } from '@mini-agent-run/shared';
import { onMounted, ref } from 'vue';

const health = ref<HealthResponse>();
const failed = ref(false);

onMounted(async () => {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error(`Health request failed with HTTP ${response.status}`);
    health.value = HealthResponseSchema.parse(await response.json());
  } catch {
    failed.value = true;
  }
});
</script>

<template>
  <main>
    <h1>Mini Agent Run 排查台</h1>
    <div role="status">
      <p v-if="failed">后端健康检查失败</p>
      <template v-else-if="health">
        <p>后端连接：{{ health.status }}</p>
        <p>SQLite 探针：{{ health.sqlite }}</p>
      </template>
      <p v-else>正在检查后端连接…</p>
    </div>
  </main>
</template>
