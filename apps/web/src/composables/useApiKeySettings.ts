import { computed, ref } from 'vue';
import { readLocalStorage, writeLocalStorage } from '../utils/localStorage';

const storageKey = 'mini-agent-run.llm-api-key';
const configured = ref(false);
const hasCustomApiKey = computed(() => configured.value);

export function getApiKeyForRequest() {
  return readLocalStorage(storageKey)?.trim() || undefined;
}

function clearApiKey() {
  writeLocalStorage(storageKey, null);
  configured.value = Boolean(getApiKeyForRequest());
}

function saveApiKey(raw: string): boolean {
  const key = raw.trim();
  if (!key) {
    clearApiKey();
    return false;
  }
  const saved = writeLocalStorage(storageKey, key);
  configured.value = Boolean(getApiKeyForRequest());
  return saved;
}

export function useApiKeySettings() {
  configured.value = Boolean(getApiKeyForRequest());
  return { hasCustomApiKey, saveApiKey, clearApiKey, getApiKeyForRequest };
}
