import { onMounted, onUnmounted, ref } from 'vue';
import { apiClient } from '../api/client';

export function useHealthProbe() {
  const health = ref<'online' | 'offline' | 'loading'>('loading');
  let request = 0;

  async function checkHealth() {
    const token = ++request;
    health.value = 'loading';
    try {
      await apiClient.getHealth();
      if (request === token) health.value = 'online';
    } catch {
      if (request === token) health.value = 'offline';
    }
  }

  onMounted(checkHealth);
  onUnmounted(() => { request++; });
  return { health, checkHealth };
}
