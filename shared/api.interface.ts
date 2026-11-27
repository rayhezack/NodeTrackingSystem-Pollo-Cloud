// 埋点工作台 API 类型定义

export type TrackingSource = 'app' | 'web';
export type TrackingSourceFilter = TrackingSource | 'all';

/** Event changes describe the effect on the official library, independently of workflow stages. */
export const TRACKING_CHANGE_TYPES = ['新增', '修改', '废弃', '仅校验'] as const;
export type TrackingChangeType = (typeof TRACKING_CHANGE_TYPES)[number];
export const PARAM_CHANGE_TYPES = TRACKING_CHANGE_TYPES.filter((value) => value !== '仅校验');
export type ParamChangeType = (typeof PARAM_CHANGE_TYPES)[number];
export const isTrackingChangeType = (value: string): value is TrackingChangeType =>
  (TRACKING_CHANGE_TYPES as readonly string[]).includes(value);

/** Read old records without rewriting history; all new writes use the canonical values. */
export function normalizeTrackingChangeType(value: unknown): TrackingChangeType {
  const raw: string = String(value || '').trim();
  const aliases: Record<string, TrackingChangeType> = {
    口径调整: '修改', 删除: '废弃', 不变: '修改',
    仅开发校验: '仅校验', 开发校验: '仅校验', 不修改正式库: '仅校验', 仅校验不归档: '仅校验',
  };
  const normalized: string = aliases[raw] || raw;
  return isTrackingChangeType(normalized) ? normalized : '新增';
}

/** Validation-only is an event-level publishing policy, never a parameter change. */
export function normalizeParamChangeType(value: unknown): ParamChangeType {
  const normalized = normalizeTrackingChangeType(value);
  return normalized === '仅校验' ? '修改' : normalized;
}

/** Governance assigns parameter sources after checking the current official snapshot. */
export function classifyAiDraftChange(event: AiTrackingDraftEvent): TrackingChangeType {
  if (!event.reuseSource) return '新增';
  return event.params.some((param) => param.source === 'ai' || param.source === 'official_modified') ? '修改' : '仅校验';
}

export interface TrackingUserRef {
  user_id: string;
  larkUserId?: string;
  email?: string;
  name?: string;
  avatar?: string;
}

export type TrackingUserInput = string | TrackingUserRef;

export interface TrackingAttachment {
  bucket_id?: string;
  bucketId?: string;
  file_path?: string;
  filePath?: string;
  url?: string;
  download_url?: string;
  downloadUrl?: string;
  file_token?: string;
  fileToken?: string;
  token?: string;
  tmp_url?: string;
  thumbnail_url?: string;
  link?: string;
  name?: string;
  fileName?: string;
  size?: number;
  [key: string]: unknown;
}

export interface ResolveUiImagePreviewRequest {
  attachment: TrackingAttachment;
}

export interface ResolveUiImagePreviewResponse {
  url: string;
  filePath?: string;
  source?: 'direct' | 'storage_path' | 'storage_name';
  reason?: 'NO_PREVIEW_SOURCE' | 'STORAGE_LOOKUP_FAILED';
}

// 阶段统计
export interface StageStat {
  stage: string;
  count: number;
}

export interface GetStageStatsParams {
  source?: TrackingSourceFilter;
}

export interface GetStageStatsResponse {
  items: StageStat[];
}

// 我的待办
export interface TodoItem {
  recordId: string;
  source: TrackingSource;
  requestId?: string;
  requestName?: string;
  evtId: string;
  eventIds: string[];
  eventName: string;
  eventNames: string[];
  eventCount: number;
  stage: string;
  targetStage?: string;
  todoRole?: string;
  priority: string;
  platform: string;
}

export interface GetMyTodosParams {
  source?: TrackingSourceFilter;
  actorId?: string;
  actorLarkId?: string;
}

export interface GetMyTodosResponse {
  items: TodoItem[];
}

// 需求列表
export interface TrackingRecord {
  recordId: string;
  source: TrackingSource;
  requestId?: string;
  requestName?: string;
  evtId: string;
  eventIds: string[];
  eventName: string;
  eventNames: string[];
  eventCount: number;
  stage: string;
  uiStage: string;
  priority: string;
  platform: string;
  requester: string[];
  requesterIds: string[];
  requesterAvatars?: string[];
  dataOwner: string[];
  dataOwnerIds: string[];
  dataOwnerAvatars?: string[];
  devOwner: string[];
  devOwnerIds: string[];
  devOwnerAvatars?: string[];
  expectedCompletionDate?: string;
  updatedAt: number;
}

export interface RelatedTrackingEvent {
  recordId: string;
  source: TrackingSource;
  evtId: string;
  eventName: string;
  stage: string;
  uiStage: string;
  priority: string;
  platform: string;
  isCurrent: boolean;
  detail?: TrackingDetailSnapshot;
}

export interface GetTrackingRecordsParams {
  source?: TrackingSourceFilter;
  keyword?: string;
  stage?: string;
  priority?: string;
  platform?: string;
  owner?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface GetTrackingRecordsResponse {
  items: TrackingRecord[];
  hasMore: boolean;
  pageToken?: string;
  total: number;
}

export interface GetWorkbenchDashboardParams extends GetTrackingRecordsParams {
  actorId?: string;
  actorLarkId?: string;
  todoLimit?: number;
}

export interface GetWorkbenchDashboardResponse extends GetTrackingRecordsResponse {
  stats: StageStat[];
  todos: TodoItem[];
}

export interface CreateTrackingRecordRequest {
  source: TrackingSource;
  evtId?: string;
  requestName?: string;
  eventName: string;
  requirementBackground?: string;
  requirementLink?: string;
  metricScenario?: string;
  expectedCompletionDate?: string;
  priority?: string;
  platform?: string;
  eventDefinition?: string;
  triggerTiming?: string;
  handler?: string;
  commonProps?: string;
  version?: string;
  minVersion?: string;
  changeType?: string;
  actorId?: string;
  actorLarkId?: string;
  actorEmail?: string;
  actorName?: string;
  requesterIds?: TrackingUserInput[];
  recorderIds?: TrackingUserInput[];
  dataOwnerIds?: TrackingUserInput[];
  devOwnerIds?: TrackingUserInput[];
  dsAcceptorIds?: TrackingUserInput[];
  initialParams?: CreateParamRequest[];
}

export interface CreateTrackingRecordResponse {
  success: boolean;
  recordId: string;
  currentStage: string;
  createdParamCount: number;
}

export interface CreateSiblingTrackingEventRequest {
  evtId?: string;
  eventName: string;
  priority?: string;
  platform?: string;
  eventDefinition?: string;
  triggerTiming?: string;
  handler?: string;
  commonProps?: string;
  version?: string;
  minVersion?: string;
  changeType?: string;
  actorId?: string;
  actorLarkId?: string;
}

export interface CreateSiblingTrackingEventResponse {
  success: boolean;
  recordId: string;
  currentStage: string;
}

export interface DeleteTrackingEventRequest {
  actorId?: string;
  actorLarkId?: string;
}

export interface DeleteTrackingEventResponse {
  success: boolean;
  deletedRecordId: string;
  deletedParamCount: number;
  redirectRecordId?: string;
}

export interface DeleteTrackingRequestRequest {
  actorId?: string;
  actorLarkId?: string;
}

export interface DeleteTrackingRequestResponse {
  success: boolean;
  deletedRequestId?: string;
  deletedRecordCount: number;
  deletedParamCount: number;
}

export interface ReuseOfficialEventRequest {
  officialRecordId: string;
  officialParamKeys?: string[];
  actorId?: string;
  actorLarkId?: string;
}

export interface ReuseOfficialEventResponse {
  success: boolean;
  recordId: string;
  currentStage: string;
  importedParamCount: number;
  skippedParamCount: number;
}

export interface PermissionConfig {
  admins: string[];
  dataScientists: string[];
  developers: string[];
  acceptors: string[];
  viewers: string[];
  updatedAt?: number;
  updatedBy?: string;
}

export interface GetPermissionConfigResponse {
  config: PermissionConfig;
  canManage: boolean;
  initialized: boolean;
}

export interface UpdatePermissionConfigRequest {
  actorId?: string;
  actorLarkId?: string;
  actorName?: string;
  config: PermissionConfig;
}

export interface UpdatePermissionConfigResponse {
  success: boolean;
  config: PermissionConfig;
}

// 需求详情
export interface TrackingDetailPermissions {
  canEditRequirement: boolean;
  canEditDesign: boolean;
  canEditReview: boolean;
  canEditDev: boolean;
  canEditAcceptance: boolean;
  canEditLaunch: boolean;
  canEditArchive: boolean;
  canEditParams: boolean;
}

export type TrackingDetailSnapshot = Omit<TrackingDetail, 'relatedEvents'>;

export interface TrackingDetail {
  recordId: string;
  source: TrackingSource;
  requestId?: string;
  requestName?: string;
  evtId: string;
  eventName: string;
  stage: string;
  uiStage: string;
  reviewStatus: string;
  devStatus: string;
  acceptanceStatus: string;
  requester: TrackingUserRef[];
  requesterIds: string[];
  recorder: TrackingUserRef[];
  recorderIds: string[];
  dataOwner: TrackingUserRef[];
  dataOwnerIds: string[];
  devOwner: TrackingUserRef[];
  devOwnerIds: string[];
  dsAcceptor: TrackingUserRef[];
  dsAcceptorIds: string[];
  priority: string;
  platform: string;
  requirementFields: Record<string, unknown>;
  designFields: Record<string, unknown>;
  reviewFields: Record<string, unknown>;
  devFields: Record<string, unknown>;
  acceptanceFields: Record<string, unknown>;
  launchFields: Record<string, unknown>;
  archiveFields: Record<string, unknown>;
  relatedEvents: RelatedTrackingEvent[];
  permissions: TrackingDetailPermissions;
  updatedAt: number;
}

export interface GetTrackingDetailResponse {
  data: TrackingDetail;
}

// 更新主表字段
export interface UpdateTrackingRecordRequest {
  fields: Record<string, unknown>;
  stageId?: string;
  targetStage?: string;
  actorId?: string;
  actorLarkId?: string;
}

export interface UpdateTrackingRecordResponse {
  success: boolean;
  recordId: string;
  currentStage: string;
  notification?: WorkflowNotificationResult;
}

export interface WorkflowNotificationResult {
  /** Omitted by older synchronous callers. Queued is not a delivery result. */
  deliveryStatus?: 'queued' | 'finished';
  planned: boolean;
  configured: boolean;
  recipientCount: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
  skippedReasons?: string[];
  errors?: string[];
}

export interface NotificationRuntimeStatus {
  configured: boolean;
  hasAppId: boolean;
  hasAppSecret: boolean;
  usingDefaultAppId: boolean;
}

// 参数明细
export interface ParamDetail {
  recordId: string;
  paramKey: string;
  evtId: string;
  paramName: string;
  paramType: string;
  required: boolean;
  requiredRule: string;
  triggerCondition: string;
  enumRange: string;
  definition: string;
  defaultValue: string;
  example: string;
  platform: string;
  status: string;
  version: string;
  changeType: string;
  /** 仅属于当前需求，不进入正式参数定义或被复用继承。 */
  requestNotes?: string;
}

export interface GetParamsResponse {
  items: ParamDetail[];
  total: number;
}

export interface CreateParamRequest {
  paramKey?: string;
  evtId: string;
  paramName: string;
  paramType: string;
  required: boolean;
  requiredRule?: string;
  triggerCondition?: string;
  enumRange?: string;
  definition?: string;
  defaultValue?: string;
  example?: string;
  platform?: string;
  status: string;
  version?: string;
  changeType?: string;
  actorId?: string;
  actorLarkId?: string;
  /** 仅属于当前需求，不进入正式参数定义或被复用继承。 */
  requestNotes?: string;
}

export interface CreateParamResponse {
  success: boolean;
  recordId: string;
  item: ParamDetail;
}

export interface UpdateParamRequest {
  fields: Record<string, unknown>;
  actorId?: string;
  actorLarkId?: string;
}

export interface UpdateParamResponse {
  success: boolean;
  recordId: string;
  item: ParamDetail;
}

export interface DeleteParamResponse {
  success: boolean;
}

export interface BatchDeleteParamsRequest {
  paramRecordIds: string[];
  actorId?: string;
  actorLarkId?: string;
}

export interface BatchDeleteParamsResponse {
  success: boolean;
  deletedCount: number;
}

// AI 埋点设计草稿
export type AiDraftParamSource = 'ai' | 'official' | 'official_modified';

export interface AiTrackingConfigStatus {
  configured: boolean;
  missingKeys: string[];
  provider: 'kimi';
  model: string;
  reasoningEffort: string;
  feishuOAuthConfigured: boolean;
  tokenStorage: 'encrypted_base' | 'encrypted_d1';
}

export interface AiFeishuAuthStatus {
  authorized: boolean;
  expiresAt?: number;
  scope?: string;
  reauthorizationRequired?: boolean;
  missingScopes?: string[];
  tokenStorage: 'encrypted_base' | 'encrypted_d1';
}

export interface StartAiFeishuAuthRequest {
  recordId: string;
  actorId?: string;
  actorLarkId?: string;
}

export interface StartAiFeishuAuthResponse {
  authorizationUrl: string;
  expiresAt: number;
}

export interface GenerateAiTrackingDraftRequest {
  actorId?: string;
  actorLarkId?: string;
  contextFiles?: AiTrackingContextFile[];
}

/** 生成初稿时由分析师补充的文本上下文文件。文件内容只用于本次生成，不写入 Base。 */
export interface AiTrackingContextFile {
  name: string;
  content: string;
}

export interface AiTrackingDraftParam {
  paramName: string;
  paramType: string;
  requiredRule: string;
  triggerCondition: string;
  enumRange: string;
  definition: string;
  defaultValue: string;
  example: string;
  platform: string;
  source: AiDraftParamSource;
  changeSummary?: string;
  uncertainties: string[];
  /** 仅属于当前需求，不进入正式参数定义或被复用继承。 */
  requestNotes?: string;
}

export interface AiTrackingDraftEvent {
  requestNotes?: string;
  clientId: string;
  evtId: string;
  eventName: string;
  eventDefinition: string;
  triggerTiming: string;
  metricScenario: string;
  priority: string;
  platform: string;
  handler: string;
  commonProps: string;
  version: string;
  minVersion: string;
  changeType: string;
  evidence: string[];
  uncertainties: string[];
  reuseSource?: {
    recordId: string;
    evtId: string;
    eventName: string;
    modificationSummary: string;
  };
  params: AiTrackingDraftParam[];
}

export interface AiTrackingDraftDiff {
  scope: 'current_event' | 'new_event';
  eventClientId: string;
  changedFields: string[];
  addedParamNames: string[];
  changedParamNames: string[];
}

export interface AiTrackingDraft {
  id: string;
  recordId: string;
  requestId?: string;
  version: number;
  status: 'generating' | 'draft' | 'applying' | 'applied' | 'failed';
  createdAt: number;
  provider: string;
  model: string;
  prd: {
    url: string;
    title: string;
    revision?: string;
    truncated: boolean;
  };
  summary: string;
  analystQuestions: string[];
  events: AiTrackingDraftEvent[];
  diffs: AiTrackingDraftDiff[];
  appliedRecordIds?: string[];
  appliedParamCount?: number;
  failureMessage?: string;
  governance?: AiGovernanceReport;
}

export interface AiReuseDecision {
  evtId: string;
  decision: 'reuse' | 'new';
  reason: string;
  comparedEventIds: string[];
}

export interface AiGovernanceReport {
  /** Exact bundled Skill used for generation; absent on historical drafts. */
  skillSourceHash?: string;
  designContractVersion?: 'official-delta-v1';
  workflowVersion: 'official-first-v3';
  source: TrackingSource;
  primaryBoard: string;
  secondaryBoard?: string;
  snapshotFingerprint: string;
  counts: { events: number; params: number; commonProps: number; enums: number };
  decisions: AiReuseDecision[];
  checks: { name: string; status: 'passed' | 'pending'; detail: string }[];
}

export interface GenerateAiTrackingDraftResponse {
  draft: AiTrackingDraft;
}

export interface AiTrackingJob {
  id: string;
  recordId: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  progress: AiTrackingGenerationProgress[];
  draftId?: string;
  error?: string;
}

export interface GetAiTrackingJobsResponse { jobs: AiTrackingJob[]; }
export interface GetAiTrackingJobResponse { job: AiTrackingJob; }

export interface AiTrackingGenerationTask {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  detail?: string;
  attempt?: number;
  durationMs?: number;
}

export interface AiTrackingGenerationProgress {
  task?: AiTrackingGenerationTask;
  stage: string;
  message: string;
  elapsedMs?: number;
  completed?: number;
  total?: number;
}

export interface GetLatestAiTrackingDraftResponse {
  draft: AiTrackingDraft | null;
}

export interface GetAiTrackingDraftResponse {
  draft: AiTrackingDraft | null;
}

export type AiDraftParamSelection = Record<string, string[]>;

export interface ApplyAiTrackingDraftRequest {
  actorId?: string;
  actorLarkId?: string;
  selectedEventClientIds?: string[];
  /** Omit for legacy full-parameter import. When provided, every selected event needs an entry; [] imports only the event. */
  selectedParamNamesByEvent?: AiDraftParamSelection;
}

export interface ApplyAiTrackingDraftResponse {
  success: boolean;
  draftId: string;
  appliedRecordIds: string[];
  createdEventCount: number;
  createdParamCount: number;
}

// 正式查询库
export interface OfficialEvent {
  handler?: string;
  commonProps?: string;
  minVersion?: string;
  recordId: string;
  source: TrackingSource;
  evtId: string;
  eventName: string;
  category?: string;
  platform: string;
  version: string;
  status: string;
  lifecycleStatus?: string;
  eventDefinition?: string;
  triggerTiming?: string;
  metricScenario?: string;
}

export interface OfficialEventContext {
  event: OfficialEvent;
  params: OfficialParam[];
}

export interface TrackingContextMeta {
  schemaVersion: 'tracking-context/v1';
  dataSource: 'd1';
  scope: 'official-search' | 'official-event' | 'request';
  snapshotKind: 'current-saved';
  immutable: false;
  source: TrackingSource;
  sourcePath: string;
  specVersion: string;
  generatedAt: string;
  fullRead: true;
  missing: string[];
  warnings: string[];
}

export interface TrackingCommonContext {
  name: string;
  type: string;
  definition: string;
  scope: string;
}

export interface TrackingEnumContext {
  evtId: string;
  paramName: string;
  value: string;
  definition: string;
  status: string;
}

export interface SearchTrackingContextResponse extends GetOfficialEventsResponse {
  meta: TrackingContextMeta;
}

export interface OfficialTrackingContextResponse extends OfficialEventContext {
  meta: TrackingContextMeta;
  commonProperties: TrackingCommonContext[];
  enums: TrackingEnumContext[];
}

export interface RequestTrackingContextResponse {
  meta: TrackingContextMeta;
  requestId: string;
  requestName: string;
  reviewStatus: string;
  events: {
    event: Omit<TrackingDetailSnapshot, 'permissions'>;
    params: ParamDetail[];
    officialBaseline: OfficialEventContext | null;
  }[];
  commonProperties: TrackingCommonContext[];
  enums: TrackingEnumContext[];
}

export interface GetOfficialEventsParams {
  source?: TrackingSource;
  keyword?: string;
  category?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface GetOfficialEventsResponse {
  items: OfficialEvent[];
  categories: string[];
  hasMore: boolean;
  pageToken?: string;
  total: number;
}

export interface OfficialParam {
  paramKey: string;
  paramName: string;
  paramType: string;
  required: boolean;
  requiredRule: string;
  triggerCondition?: string;
  enumRange?: string;
  definition: string;
  example: string;
  notes?: string;
  version?: string;
  sourceTable?: string;
  platform?: string;
  status?: string;
}

export interface GetOfficialParamsResponse {
  items: OfficialParam[];
  total: number;
}

export interface DataSyncStatus {
  mode: 'base' | 'importing' | 'd1';
  tables: { instance: string; count: number }[];
  queue: { status: string; count: number; oldest: number }[];
  migration: { index: number; token?: string; count: number } | null;
  errors: { id: number; instance: string; record_id: string; status: string; error: string; attempts: number }[];
  canManage: boolean;
  runs?: DataSyncRun[];
}

export const DATA_SYNC_TASK_FILTER_LABELS = {
  all: '全部',
  active: '进行中',
  completed: '已完成',
  failed: '失败',
} as const;

export interface DataSyncRun {
  id: string;
  trigger: 'manual' | 'automatic';
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  error: string | null;
}

export interface DataSyncRunItem {
  operation: 'create' | 'update' | 'delete' | 'notification';
  jobId: number;
  instance: string;
  recordId: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  startedAt: number | null;
  finishedAt: number | null;
  attempts: number;
  error: string | null;
}

export interface DataSyncRunDetail {
  run: DataSyncRun;
  items: DataSyncRunItem[];
  totalItems: number;
  page: number;
  pageSize: number;
}

/** Official-library status values an admin may set through governance; deprecation goes through a 废弃 requirement instead. */
export const OFFICIAL_GOVERNANCE_STATUSES = ['待开发', '待验收', '已验收', '已上线', '待治理'] as const;
export const OFFICIAL_GOVERNANCE_LIFECYCLES = ['需求录入', '埋点设计', '评审通过', '埋点开发', '数据验收', '上线监控', '稳定归档'] as const;

export interface OfficialGovernanceItem {
  evtId: string;
  status?: (typeof OFFICIAL_GOVERNANCE_STATUSES)[number];
  lifecycleStatus?: (typeof OFFICIAL_GOVERNANCE_LIFECYCLES)[number];
  /** Why this change is made. Shown in the preview with date and operator; not stored on the event. */
  note: string;
}

export interface OfficialGovernanceRequest {
  source: TrackingSource;
  dryRun: boolean;
  items: OfficialGovernanceItem[];
}

export interface OfficialGovernanceChange {
  evtId: string;
  recordId: string;
  before: { status: string; lifecycleStatus: string };
  after: { status: string; lifecycleStatus: string };
  reviewNote: string;
}

export interface OfficialGovernanceResponse {
  source: TrackingSource;
  dryRun: boolean;
  changes: OfficialGovernanceChange[];
  /** Items whose status and lifecycle already match the requested values; nothing is written for them. */
  unchanged: string[];
}

/** Data types an admin may set on an official parameter. UNKNOWN and the legacy BOOLEAN spelling are not allowed as targets. */
export const OFFICIAL_PARAM_GOVERNANCE_TYPES = ['STRING', 'INTEGER', 'NUMBER', 'BOOL', 'ARRAY', 'OBJECT'] as const;
export const OFFICIAL_PARAM_GOVERNANCE_REQUIRED_RULES = ['必传', '非必传', '条件必传'] as const;

export interface OfficialParamGovernanceItem {
  evtId: string;
  paramName: string;
  dataType?: (typeof OFFICIAL_PARAM_GOVERNANCE_TYPES)[number];
  requiredRule?: (typeof OFFICIAL_PARAM_GOVERNANCE_REQUIRED_RULES)[number];
  /** Written to 条件说明; required when requiredRule is 条件必传 and the parameter has no condition yet. */
  condition?: string;
  /** Why this change is made (e.g. log evidence). Shown in the preview; not stored on the parameter. */
  note: string;
}

export interface OfficialParamGovernanceRequest {
  source: TrackingSource;
  dryRun: boolean;
  items: OfficialParamGovernanceItem[];
}

export interface OfficialParamGovernanceChange {
  evtId: string;
  paramName: string;
  recordId: string;
  before: { dataType: string; requiredRule: string; condition: string };
  after: { dataType: string; requiredRule: string; condition: string };
  note: string;
}

export interface OfficialParamGovernanceResponse {
  source: TrackingSource;
  dryRun: boolean;
  changes: OfficialParamGovernanceChange[];
  /** "evtId.paramName" items that already match the requested values; nothing is written for them. */
  unchanged: string[];
}
