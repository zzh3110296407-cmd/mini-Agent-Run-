<script setup lang="ts">
import type { EvidenceRef, InvestigationConclusion } from '@mini-agent-run/shared';
import { formatTaskOutcome } from '../../utils/formatters';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';

defineProps<{ conclusion: InvestigationConclusion }>();
const emit = defineEmits<{ openEvidence: [evidence: EvidenceRef] }>();

function location(evidence: EvidenceRef) {
  if (evidence.kind === 'file_step') return 'Step #' + evidence.step;
  const from = 'L' + evidence.startLine;
  return evidence.endLine !== undefined && evidence.endLine !== evidence.startLine ? from + '–L' + evidence.endLine : from;
}
</script>

<template>
  <section class="conclusion" data-testid="conclusion-card" aria-label="根因结论">
    <h3>根因结论</h3>
    <p class="conclusion-text">{{ conclusion.summary }}</p>
    <div class="three-state" data-testid="three-state-group" aria-label="三态评估">
      <UiBadge data-assessment="terminationReason">终止原因 {{ conclusion.threeStateAssessment?.terminationReason ?? '未知' }}</UiBadge>
      <UiBadge
        data-assessment="hasToolError"
        :tone="conclusion.threeStateAssessment?.hasToolError === false ? 'completed' : conclusion.threeStateAssessment?.hasToolError ? 'failed' : 'neutral'"
      >工具报错 {{ conclusion.threeStateAssessment?.hasToolError === undefined ? '未知' : conclusion.threeStateAssessment.hasToolError ? '有' : '无' }}</UiBadge>
      <UiBadge
        data-assessment="taskOutcome"
        :tone="conclusion.threeStateAssessment?.taskOutcome === 'passed' ? 'completed' : conclusion.threeStateAssessment?.taskOutcome === 'failed' ? 'failed' : 'neutral'"
      >任务结果 {{ formatTaskOutcome(conclusion.threeStateAssessment?.taskOutcome ?? 'unknown') }}</UiBadge>
    </div>
    <div v-if="conclusion.evidence.length" class="evidence">
      <UiButton
        v-for="(item, index) in conclusion.evidence" :key="index" variant="subtle" size="sm"
        data-testid="evidence-chip" :data-evidence-kind="item.kind" :title="item.excerpt"
        @click="emit('openEvidence', item)"
      >
        <UiIcon :name="item.kind === 'artifact_line' ? 'copy' : 'file-text'" :size="13" />
        <span>{{ item.label }}</span><code class="tabular-nums">{{ location(item) }}</code>
      </UiButton>
    </div>
    <div v-if="conclusion.recommendations.length" class="recommendations">
      <h4>修复建议</h4>
      <ol><li v-for="(recommendation, index) in conclusion.recommendations" :key="index">{{ recommendation }}</li></ol>
    </div>
  </section>
</template>

<style scoped>
.conclusion { display: grid; gap: 9px; min-width: 0; padding: 12px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); overflow-wrap: anywhere; }
h3, h4, p, ol { margin: 0; }
h3, h4 { font-size: 13px; }
.conclusion-text, li { white-space: pre-wrap; }
.three-state, .evidence { display: flex; flex-wrap: wrap; gap: 6px; }
.three-state > :deep(span) { max-width: 100%; white-space: normal; }
.evidence span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.evidence code { flex: none; color: var(--accent-soft-fg); font: 11px var(--font-mono); }
ol { padding-inline-start: 1.5em; }
</style>
