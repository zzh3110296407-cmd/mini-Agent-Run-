<script setup lang="ts">
import { computed, ref } from 'vue';
import { parseSafeMarkdown } from '../../utils/safeMarkdown';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';

const props = defineProps<{ content: string }>();
const blocks = computed(() => parseSafeMarkdown(props.content));
const clipboardStatus = ref('');

async function copy(code: string) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(code);
    clipboardStatus.value = '已复制代码。';
  } catch {
    clipboardStatus.value = '无法复制，请手动选择代码。';
  }
}
</script>

<template>
  <div class="markdown" data-testid="safe-markdown-view">
    <template v-for="(block, index) in blocks" :key="index">
      <component v-if="block.type === 'heading'" :is="'h' + block.level">
        <component
          v-for="(token, tokenIndex) in block.tokens" :key="tokenIndex"
          :is="token.type === 'text' ? 'span' : token.type"
        >{{ token.text }}</component>
      </component>
      <component v-else-if="block.type === 'list'" :is="block.ordered ? 'ol' : 'ul'" :start="block.ordered ? block.start : undefined">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <component v-for="(token, tokenIndex) in item" :key="tokenIndex" :is="token.type === 'text' ? 'span' : token.type">{{ token.text }}</component>
        </li>
      </component>
      <section v-else-if="block.type === 'code_block'" class="markdown-code">
        <div class="code-header">
          <span>{{ block.language || '代码' }}</span>
          <UiButton variant="ghost" size="sm" data-testid="copy-markdown-code-btn" @click="copy(block.code)">
            <UiIcon name="copy" :size="13" />复制
          </UiButton>
        </div>
        <pre><code>{{ block.code }}</code></pre>
      </section>
      <p v-else-if="block.tokens.some((token) => token.text.trim())">
        <component
          v-for="(token, tokenIndex) in block.tokens" :key="tokenIndex"
          :is="token.type === 'text' ? 'span' : token.type"
        >{{ token.text }}</component>
      </p>
    </template>
    <span v-if="clipboardStatus" class="clipboard-status" role="status">{{ clipboardStatus }}</span>
  </div>
</template>

<style scoped>
.markdown { min-width: 0; display: grid; gap: 10px; overflow-wrap: anywhere; font-size: 14px; line-height: 1.6; }
h1, h2, h3, p, pre, ul, ol { margin: 0; }
h1, h2, h3 { line-height: 1.4; }
h1 { font-size: 18px; }
h2 { font-size: 16px; }
h3 { font-size: 14px; }
p, li { white-space: pre-wrap; }
ul, ol { padding-inline-start: 1.5em; }
code { font-family: var(--font-mono); font-size: .92em; color: var(--text-code); }
:not(pre) > code { padding: 1px 4px; background: var(--bg-muted); border-radius: var(--radius-xs); }
.markdown-code { min-width: 0; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-muted); }
.code-header { display: flex; justify-content: space-between; align-items: center; min-width: 0; padding: 3px 8px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); font: 12px var(--font-mono); }
.code-header span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
pre { padding: 10px 12px; overflow: auto; white-space: pre; }
.clipboard-status { color: var(--text-secondary); font-size: 12px; }
</style>
