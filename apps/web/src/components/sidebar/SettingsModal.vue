<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useApiKeySettings } from '../../composables/useApiKeySettings';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiDialog from '../ui/UiDialog.vue';
import UiIcon from '../ui/UiIcon.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { hasCustomApiKey, saveApiKey, clearApiKey } = useApiKeySettings();
const inputId = useId();
const draft = ref('');
const saveError = ref('');
const canSave = computed(() => draft.value.trim().length > 0);

watch(() => props.open, () => { draft.value = ''; saveError.value = ''; });

function save() {
  if (!canSave.value) return;
  if (saveApiKey(draft.value)) {
    draft.value = '';
    emit('close');
  } else {
    saveError.value = '当前浏览器无法保存此设置。';
  }
}

function clear() {
  clearApiKey();
  draft.value = '';
  saveError.value = hasCustomApiKey.value ? '当前浏览器无法清除此设置。' : '';
}
</script>

<template>
  <UiDialog :open="open" title="设置" data-testid="settings-modal" @close="emit('close')">
    <form :id="inputId + '-form'" class="key-form" @submit.prevent="save">
      <div class="key-state" role="status" data-testid="api-key-status">
        <UiBadge :tone="hasCustomApiKey ? 'completed' : 'neutral'">
          <UiIcon :name="hasCustomApiKey ? 'check' : 'key'" :size="14" />
          {{ hasCustomApiKey ? '已配置自定义 API Key' : '未覆盖' }}
        </UiBadge>
        <span>{{ hasCustomApiKey ? '保存在当前浏览器本地' : '默认使用后端 .env 配置' }}</span>
      </div>
      <label :for="inputId">LLM API Key</label>
      <input
        :id="inputId" v-model="draft" class="field-input" data-testid="api-key-input" data-autofocus
        type="password" autocomplete="off" spellcheck="false" placeholder="输入新的 API Key"
        @input="saveError = ''"
      >
      <p v-if="saveError" role="alert">{{ saveError }}</p>
    </form>
    <template #footer>
      <UiButton variant="ghost" data-testid="clear-api-key-btn" :disabled="!hasCustomApiKey" @click="clear">清除并恢复默认</UiButton>
      <UiButton
        variant="primary" type="submit" :form="inputId + '-form'" data-testid="save-api-key-btn" :disabled="!canSave" @click.prevent="save"
      >保存</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.key-form { display: grid; gap: 8px; }
.key-state { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 5px; color: var(--text-secondary); font-size: 12px; }
label { font-weight: 600; }
input { font-family: var(--font-mono); }
p { margin: 0; color: var(--status-failed-fg); }
</style>
