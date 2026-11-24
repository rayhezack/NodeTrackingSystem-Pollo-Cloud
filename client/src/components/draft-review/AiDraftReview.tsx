import { classifyAiDraftChange } from '@shared/api.interface';
import { useEffect, useRef, useState } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Section } from '@astryxdesign/core/Section';
import { Text } from '@astryxdesign/core/Text';
import { Heading } from '@astryxdesign/core/Heading';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Table, useTableSelection, type TableColumn } from '@astryxdesign/core/Table';
import { Checkbox } from '@client/src/components/ui/checkbox';
import { polloReviewTheme } from './pollo-review';
import { updateParamSelection } from './param-selection';
import type { AiDraftParamSelection, AiTrackingDraft, AiTrackingDraftEvent, AiTrackingDraftParam } from '@shared/api.interface';

interface Props {
  draft: AiTrackingDraft;
  selectedIds: Set<string>;
  onSelect: (ids: Set<string>) => void;
  selectedParams: AiDraftParamSelection;
  onSelectParams: (eventId: string, names: string[]) => void;
  disabled?: boolean;
}
interface ParamRow extends Record<string, unknown> { id: string; param: AiTrackingDraftParam; }

/** Two-pane review adapted from the Astryx inbox/detail pattern; selection never navigates. */
export function AiDraftReview({ draft, selectedIds, onSelect, selectedParams, onSelectParams, disabled = false }: Props) {
  const [activeId, setActiveId] = useState(draft.events[0]?.clientId || '');
  const [eventQuery, setEventQuery] = useState('');
  const [paramQuery, setParamQuery] = useState('');
  const [onlyQuestions, setOnlyQuestions] = useState(false);
  const [tab, setTab] = useState('spec');
  const detailRef = useRef<HTMLElement>(null);
  const [paramId, setParamId] = useState<string | null>(null);
  useEffect(() => {
    if (!paramId || !detailRef.current) return;
    detailRef.current.focus({ preventScroll: true });
    detailRef.current.scrollIntoView({ block: 'nearest' });
  }, [paramId]);
  const active: AiTrackingDraftEvent | undefined = draft.events.find((event) => event.clientId === activeId) || draft.events[0];
  const questions: string[] = [...new Set(draft.analystQuestions)];
  const events: AiTrackingDraftEvent[] = draft.events.filter((event) => `${event.evtId} ${event.eventName}`.toLowerCase().includes(eventQuery.toLowerCase()));
  const params: AiTrackingDraftParam[] = (active?.params || []).filter((param) =>
    `${param.paramName} ${param.definition}`.toLowerCase().includes(paramQuery.toLowerCase()) && (!onlyQuestions || param.uncertainties.length > 0));
  const selectedParam: AiTrackingDraftParam | undefined = active?.params.find((param) => param.paramName === paramId);
  const chosen: string[] = active ? selectedParams[active.clientId] || [] : [];
  const chosenNames: Set<string> = new Set(chosen);
  const visibleChosen: number = params.filter((param) => chosenNames.has(param.paramName)).length;
  const changeParams = (scope: string[], checked: boolean) => {
    if (active && !disabled) onSelectParams(active.clientId, updateParamSelection(active, chosen, scope, checked));
  };
  const paramSelection = useTableSelection<ParamRow>({
    getIsItemSelected: (row: ParamRow) => chosenNames.has(row.param.paramName),
    onSelectItem: ({ item, isSelected }: { item: ParamRow; isSelected: boolean }) => changeParams([item.param.paramName], isSelected),
    onSelectAll: ({ isAllSelected }: { isAllSelected: boolean }) => changeParams(params.map((param) => param.paramName), isAllSelected),
    getIsAllSelected: () => params.length > 0 && visibleChosen === params.length,
    getIsIndeterminate: () => visibleChosen > 0 && visibleChosen < params.length,
    getIsItemEnabled: () => !disabled,
    getRowLabel: (row: ParamRow) => row.param.paramName,
    hasRowHighlight: false,
  });
  const columns: TableColumn<ParamRow>[] = [
    { key: 'name', header: '参数 / 类型', renderCell: (row: ParamRow) => <VStack gap={1}><Text type="code" maxLines={1}>{row.param.paramName}</Text><Text type="supporting">{row.param.paramType} · {row.param.requiredRule}</Text></VStack> },
    { key: 'definition', header: '中文定义', renderCell: (row: ParamRow) => <VStack gap={1}><Text type="body">{row.param.definition || '未填写'}</Text>{row.param.uncertainties.length > 0 && <Text type="supporting" color="accent">{row.param.uncertainties.length} 项待确认</Text>}</VStack> },
    { key: 'range', header: '枚举 / 范围', renderCell: (row: ParamRow) => <Text type="code" className="whitespace-pre-wrap">{row.param.enumRange || '无枚举'}</Text> },
    { key: 'detail', header: '详情', renderCell: (row: ParamRow) => <Button label="查看" variant="ghost" size="sm" onClick={() => setParamId(row.param.paramName)} /> },
  ];
  const toggle = (id: string, checked: boolean) => {
    const next: Set<string> = new Set(selectedIds);
    if (checked) next.add(id); else next.delete(id);
    onSelect(next);
  };
  return <Theme theme={polloReviewTheme} mode="light">
    <VStack gap={0} className="h-full min-h-0 bg-card text-foreground">
      <HStack gap={0} className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-4">
        <VStack gap={3} padding={4} className="max-h-48 min-h-0 overflow-auto border-b border-border md:col-span-1 md:max-h-none md:border-r md:border-b-0" as="nav" aria-label="草稿事件导航">
          <HStack gap={2} vAlign="center" className="justify-between">
            <Heading level={4}>事件 {draft.events.length}</Heading>
            <Button label={selectedIds.size === draft.events.length ? '取消全选' : '全选'} variant="ghost" size="sm" isDisabled={disabled} onClick={() => onSelect(selectedIds.size === draft.events.length ? new Set() : new Set(draft.events.map((event) => event.clientId)))} />
          </HStack>
          <TextInput isLabelHidden label="筛选事件" value={eventQuery} onChange={setEventQuery} placeholder="事件名或 ID" hasClear size="sm" />
          <VStack gap={1}>
            {events.map((event) => <HStack key={event.clientId} gap={2} vAlign="center">
              <Checkbox aria-label={`选择 ${event.evtId}`} checked={selectedIds.has(event.clientId)} disabled={disabled} onCheckedChange={(checked) => toggle(event.clientId, checked === true)} />
              <Button label={`${event.eventName} · ${event.evtId}`} width="100%" className={`h-auto min-h-12 rounded-lg py-2 ${active?.clientId === event.clientId ? 'bg-accent text-accent-foreground' : ''}`} variant="ghost" size="sm" onClick={() => { setActiveId(event.clientId); setParamId(null); setParamQuery(''); }}>
                <VStack gap={0} hAlign="start" width="100%" className="min-w-0 text-left"><Text type="label" color={active?.clientId === event.clientId ? 'accent' : 'primary'} maxLines={1}>{event.eventName}</Text><Text type="supporting" maxLines={1}>{event.evtId}</Text></VStack>
              </Button>
            </HStack>)}
            {!events.length && <Text type="supporting">没有匹配的事件</Text>}
          </VStack>
        </VStack>
        <VStack gap={4} padding={4} isScrollable className="min-h-0 md:col-span-3">
          {active ? <>
            <VStack gap={1}><Heading level={4}>{active.evtId}</Heading><Text type="supporting">{active.eventName}</Text></VStack>
            <HStack gap={3} wrap="wrap"><Text type="supporting">{active.reuseSource ? '复用正式事件' : '新增事件建议'}</Text><Text type="supporting">{active.platform} · {active.priority}</Text></HStack>
            <SegmentedControl label="草稿内容" value={tab} onChange={setTab} size="sm">
              <SegmentedControlItem value="spec" label="事件信息" /><SegmentedControlItem value="params" label={`参数 ${active.params.length}`} /><SegmentedControlItem value="questions" label="待确认与依据" /><SegmentedControlItem value="governance" label="治理校验" />
            </SegmentedControl>
            {tab === 'spec' && <VStack gap={4}>
              <Field label="事件定义" value={active.eventDefinition} /><Field label="触发时机" value={active.triggerTiming} />
              <Field label="指标与使用场景" value={active.metricScenario} />{active.requestNotes && <Field label="本次需求说明" value={active.requestNotes} />}
              <HStack gap={6} wrap="wrap"><Field label="处理方" value={active.handler} /><Field label="版本" value={active.version} /><Field label="最低版本" value={active.minVersion} /><Field label="变更类型" value={classifyAiDraftChange({ ...active, params: active.params.filter((param) => chosenNames.has(param.paramName)) })} /></HStack>
              {active.commonProps && <Field label="公共属性" value={active.commonProps} />}
              {active.reuseSource && <Field label="正式来源" value={`${active.reuseSource.evtId} · ${active.reuseSource.recordId}\n${active.reuseSource.modificationSummary}`} />}
            </VStack>}
            {tab === 'params' && <VStack gap={3}>
              <HStack gap={3} wrap="wrap" vAlign="center"><TextInput isLabelHidden label="筛选参数" value={paramQuery} onChange={setParamQuery} placeholder="参数名或中文定义" hasClear size="sm" /><Button label={onlyQuestions ? '查看全部参数' : '只看待确认'} variant="ghost" size="sm" onClick={() => setOnlyQuestions(!onlyQuestions)} /></HStack>
              <HStack gap={2} wrap="wrap" vAlign="center">
                <Text type="supporting">已选 {chosen.length}/{active.params.length} 个参数</Text>
                <Button label="全选参数" variant="ghost" size="sm" isDisabled={disabled || chosen.length === active.params.length} onClick={() => changeParams(active.params.map((param) => param.paramName), true)} />
                <Button label="清空" variant="ghost" size="sm" isDisabled={disabled || chosen.length === 0} onClick={() => changeParams(active.params.map((param) => param.paramName), false)} />
              </HStack>
              {!selectedIds.has(active.clientId) && <Text type="supporting">此事件未选择录入</Text>}
              <Table plugins={{ selection: paramSelection }} data={params.map((param) => ({ id: param.paramName, param }))} columns={columns} idKey="id" density="compact" dividers="rows" verticalAlign="top" hasHover />
              {!params.length && <Text type="supporting">没有匹配的参数</Text>}
              {selectedParam && <Section padding={4} dividers={['top']}><VStack gap={3} ref={detailRef} tabIndex={-1} as="section" aria-label={`${selectedParam.paramName} 参数详情`}>
                <HStack gap={3} vAlign="center"><Text type="code">{selectedParam.paramName}</Text><Button label="关闭参数详情" size="sm" variant="ghost" onClick={() => setParamId(null)} /></HStack>
                <Field label="示例" value={selectedParam.example} /><Field label="必传条件" value={selectedParam.triggerCondition} /><Field label="适用端" value={selectedParam.platform} /><Field label="默认值" value={selectedParam.defaultValue} />
                <Field label="本次需求说明" value={selectedParam.requestNotes || ''} /><Field label="待确认项" value={selectedParam.uncertainties.join('\n')} />
              </VStack></Section>}
            </VStack>}
            {tab === 'questions' && <VStack gap={4}>
              <Field label="当前事件待确认" value={active.uncertainties.join('\n')} />
              <Field label="参数待确认" value={active.params.flatMap((param) => param.uncertainties.map((item) => `${param.paramName}：${item}`)).join('\n')} />
              <Field label="设计依据" value={active.evidence.join('\n')} /><Field label="整份需求确认项" value={questions.join('\n')} />
            </VStack>}
            {tab === 'governance' && <VStack gap={3}>
              {draft.governance?.checks.map((check) => <Field key={check.name} label={`${check.status === 'passed' ? '通过' : '待确认'} · ${check.name}`} value={check.detail} />)}
              <Field label="设计 Skill 版本" value={draft.governance?.skillSourceHash || '历史草稿未记录'} />
            </VStack>}
          </> : <Text type="supporting">此草稿暂无事件</Text>}
        </VStack>
      </HStack>
    </VStack>
  </Theme>;
}
function Field({ label, value }: { label: string; value: string }) {
  return <VStack gap={1}><Text type="supporting">{label}</Text><Text type="body" className="whitespace-pre-wrap">{value || '未填写'}</Text></VStack>;
}
