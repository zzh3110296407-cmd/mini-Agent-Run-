<script setup lang="ts">
import type { SessionListItem } from '@mini-agent-run/shared';
import { useId } from 'vue';
import UiAlertDialog from '../ui/UiAlertDialog.vue';
import UiButton from '../ui/UiButton.vue';

defineProps<{ session: SessionListItem | null; deleting: boolean; error: string }>();
const emit = defineEmits<{ close: []; confirm: [] }>();
const descriptionId = useId();
</script>

<template>
  <UiAlertDialog
    :open="session !== null" title="删除排查会话" data-testid="delete-session-alert"
    :aria-describedby="descriptionId" @close="emit('close')"
  >
    <div v-if="session" class="delete-content">
      <strong>{{ session.title }}</strong>
      <code>{{ session.targetPath }}</code>
      <p :id="descriptionId">此操作仅删除排查台中的会话与历史记录，绝不删除本机磁盘上的原始轨迹文件。</p>
      <p v-if="error" class="delete-error" role="alert">{{ error }}</p>
    </div>
    <template #footer>
      <UiButton data-autofocus :disabled="deleting" @click="emit('close')">取消</UiButton>
      <UiButton variant="destructive" data-testid="confirm-delete-session-btn" :disabled="deleting" @click="emit('confirm')">
        {{ deleting ? '正在删除…' : '删除会话' }}
      </UiButton>
    </template>
  </UiAlertDialog>
</template>

<style scoped>
.delete-content { display: grid; gap: 8px; overflow-wrap: anywhere; }
.delete-content code { font: 12.5px/20px var(--font-mono); color: var(--text-secondary); }
.delete-content p { margin: 0; }
.delete-error { color: var(--status-failed-fg); }
</style>
