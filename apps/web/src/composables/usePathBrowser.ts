import type { FsBrowseResponse } from '@mini-agent-run/shared';
import { ref, shallowRef } from 'vue';
import { ApiError, apiClient } from '../api/client';

export type PathError = {
  status: number;
  code: string;
  message: string;
  severity: 'forbidden' | 'not_found' | 'unavailable' | 'invalid';
};

export function formatPathError(error: unknown): PathError {
  if (!(error instanceof ApiError)) {
    return { status: 0, code: 'INVALID_RESPONSE', severity: 'invalid', message: '读取路径失败，请重试。' };
  }
  const { status, code } = error;
  if (status === 403) {
    return { status, code, severity: 'forbidden', message: '路径超出 ALLOWED_TRACE_ROOTS 白名单范围或命中敏感文件保护。' };
  }
  if (status === 404) {
    return { status, code, severity: 'not_found', message: '目标文件或目录不存在，请核对路径拼写。' };
  }
  if (status === 503) {
    return { status, code, severity: 'unavailable', message: '当前服务未配置可用的 ALLOWED_TRACE_ROOTS 根目录。' };
  }
  if (status === 0 || status >= 500) {
    return { status, code, severity: 'unavailable', message: '路径服务暂不可用，请稍后重试。' };
  }
  return {
    status, code, severity: 'invalid',
    message: code === 'PATH_NOT_A_DIRECTORY' ? '此路径不是目录。可以直接提交文件路径创建会话。' : '路径无效，请核对路径格式后重试。',
  };
}

export function usePathBrowser(client: Pick<typeof apiClient, 'browseFs'> = apiClient) {
  const browseState = shallowRef<FsBrowseResponse | null>(null);
  const loading = ref(false);
  const errorState = shallowRef<PathError | null>(null);
  const selectedPath = ref<string | null>(null);
  let requestToken = 0;

  async function browse(path?: string): Promise<boolean> {
    const current = ++requestToken;
    loading.value = true;
    errorState.value = null;
    selectedPath.value = null;
    try {
      const response = await client.browseFs(path);
      if (current !== requestToken) return false;
      browseState.value = response;
      return true;
    } catch (error) {
      if (current === requestToken) errorState.value = formatPathError(error);
      return false;
    } finally {
      if (current === requestToken) loading.value = false;
    }
  }

  function goParent() {
    const parent = browseState.value?.parentPath;
    return parent == null ? Promise.resolve(false) : browse(parent);
  }

  function reset() {
    requestToken++;
    browseState.value = null;
    loading.value = false;
    errorState.value = null;
    selectedPath.value = null;
  }

  return { browseState, loading, errorState, selectedPath, browse, selectRoot: browse, goParent, reset };
}
