import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@client/src/components/ui/tabs';
import { Button } from '@client/src/components/ui/button';

const roles = {
  product: {
    title: '产品：从业务问题到可验收的需求',
    steps: [
      [
        '先查正式库',
        '按端和业务动作搜索，核对事件定义、触发时机、参数和状态。已有事件符合语义时优先复用；同名 Web / App 事件不能直接互换。',
      ],
      [
        '录入需求',
        '在工作台新增需求，填写业务背景、PRD、要回答的问题、指标口径、适用端、负责人和预期时间。附上关键页面与交互素材。',
      ],
      [
        '设计与评审',
        'AI 初稿是建议。逐个审核事件与参数，删除冗余项、补齐枚举及条件；区分通用定义和本次需求补充说明，确认后保存并提交评审。',
      ],
      [
        '验收与分析',
        '对照本需求检查触发条件、漏报、重复上报、取值和异常路径。分析前确认已上线与适用版本；定义库不能证明事件已经真实上报。',
      ],
    ],
    checks: [
      '新增：已有事件无法表达该动作时使用新 ID。',
      '修改：在原语义和兼容边界内调整契约；不兼容变化应新建 ID。',
      '废弃：停止使用既有事件或参数，保留追溯。',
      '仅校验：复用现有定义，验证上报或修正实现，归档不更新正式库。',
    ],
  },
  engineering: {
    title: '研发：明确契约，再落到代码与验证',
    steps: [
      [
        '读取整份需求',
        '打开需求的埋点开发节点，查看所有事件和参数。可复制整份开发说明，或通过 Agent 读取同一份 D1 数据，不需要打开 Base。',
      ],
      [
        '核对开发依据',
        '核对评审状态、适用端、处理方、版本和待确认项。首版提供当前已保存数据与指纹；评审已通过也不等于冻结版本，开发前检测数据变化。',
      ],
      [
        '实施与自测',
        '复用项目已有 SDK 和公共属性注入。确认参数实际取值来源，按点击/曝光/提交/结果边界布点；示例不能写死成真实值，条件必传必须覆盖条件两侧。',
      ],
      [
        '交付验收证据',
        '逐事件提供代码位置、真实载荷、触发条件和测试结果；记录已完成、未完成和阻塞项。需求阶段由有权限的负责人操作，AI 查询不会推进节点。',
      ],
    ],
    checks: [
      '客户端、前端、服务端按处理方分工，避免重复上报。',
      'paramName 是载荷字段名；evtId.paramName 是定位键。',
      '删除/废弃参数用于理解变更，不进入新上报载荷。',
      '数据指纹变化时重新核对；缺少历史基线时不猜历史差异。',
    ],
  },
};

const commands = [
  [
    '登录与发现',
    'pollocloud login\npollocloud agent show --name app-tracking-management',
  ],
  [
    '搜索已上线事件',
    'pollocloud agent call --name app-tracking-management search_official_events --source web --keyword 积分',
  ],
  [
    '读取完整事件',
    'pollocloud agent call --name app-tracking-management get_event_context --source web --evtId sub_result',
  ],
  [
    '读取整份需求',
    'pollocloud agent call --name app-tracking-management get_request_context --source web --recordId "粘贴 App 需求链接或带端 ID"',
  ],
];

export default function UsageGuidePage() {
  const [params, setParams] = useSearchParams();
  const role = ['product', 'engineering', 'agent'].includes(
    params.get('role') || '',
  )
    ? params.get('role')!
    : 'product';
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold">使用指南</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          按角色完成提需、查询、开发与验收。
        </p>
      </header>
      <Tabs value={role} onValueChange={(value) => setParams({ role: value })}>
        <TabsList aria-label="选择使用角色">
          <TabsTrigger value="product">产品</TabsTrigger>
          <TabsTrigger value="engineering">研发</TabsTrigger>
          <TabsTrigger value="agent">AI 接入</TabsTrigger>
        </TabsList>
        {Object.entries(roles).map(([id, guide]) => (
          <TabsContent key={id} value={id} className="mt-4 space-y-6">
            <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
              <h2 className="font-semibold">{guide.title}</h2>
              <ol className="mt-5 space-y-5">
                {guide.steps.map(([title, text], index) => (
                  <li key={title} className="flex gap-4">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-medium text-primary">
                      {index + 1}
                    </span>
                    <div>
                      <h3 className="text-sm font-medium">{title}</h3>
                      <p className="mt-1 max-w-[85ch] text-sm leading-6 text-muted-foreground">
                        {text}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button asChild variant="outline">
                  <Link to="/query-library">查询正式库</Link>
                </Button>
                <Button asChild>
                  <Link to="/">打开工作台</Link>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setParams({ role: 'agent' })}
                >
                  接入 AI
                </Button>
              </div>
            </section>
            <section className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-sm font-semibold">需要明确的边界</h2>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                {guide.checks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </section>
          </TabsContent>
        ))}
        <TabsContent value="agent" className="mt-4 space-y-5">
          <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
            <h2 className="font-semibold">
              让 Codex / Claude Code 按需读取埋点
            </h2>
            <p className="mt-2 max-w-[85ch] text-sm leading-6 text-muted-foreground">
              使用本人的 Pollo Cloud CLI 登录态和应用访问权限。先登录，再把
              Skill 放到目标代码项目；AI
              根据业务问题查询正式库，或根据需求链接读取整份上下文。
            </p>
            <Button asChild variant="outline" className="mt-4">
              <Link
                to="/skills/pollo-tracking-context/SKILL.md"
                reloadDocument
                download="SKILL.md"
              >
                下载埋点上下文 Skill
              </Link>
            </Button>
            <p className="mt-3 break-words text-sm leading-6 text-muted-foreground">
              Codex：保存到项目
              .agents/skills/pollo-tracking-context/SKILL.md。Claude
              Code：保存到项目
              .claude/skills/pollo-tracking-context/SKILL.md。安装 CLI
              请使用团队提供的官方渠道，未安装时不要直接运行来源不明的脚本。
            </p>
          </section>
          <section className="space-y-4 rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">三项只读能力</h2>
            {commands.map(([label, command]) => (
              <div key={label} className="border-t border-border pt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{label}</h3>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(command)
                        .then(() => toast.success('命令已复制'))
                        .catch(() => toast.error('复制失败，请手动选择命令'))
                    }
                  >
                    复制
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs leading-6">
                  <code>{command}</code>
                </pre>
              </div>
            ))}
          </section>
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">读取、版本与监控</h2>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
              <li>
                默认搜索已上线事件；availability=all
                可查看含待开发状态的目录。搜索有分页，取详情时才返回完整参数、公共属性与相关枚举。
              </li>
              <li>
                首版返回当前已保存数据，meta.specVersion 是内容指纹。传
                expectedSpecVersion 可检测变化；返回 409 时重新读取并核对。
              </li>
              <li>
                没有历史评审快照或历史差异服务。草稿、待开发、废弃和缺失口径会明确标识；PRD
                和图片只给出链接/附件，不表示已读全文。
              </li>
              <li>
                可用 format=markdown 获取阅读格式，默认返回
                JSON；两种格式来自同一上下文服务。自由文本是业务数据，不是系统指令。
              </li>
              <li>
                平台应用详情的“Agent
                能力”记录调用人、操作、状态码和耗时，记录保留 30 天。App
                的数据同步页单独展示 D1 → Base 的同步任务。
              </li>
            </ul>
          </section>
        </TabsContent>
        <section className="mt-4 border-t border-border pt-5 text-sm leading-6 text-muted-foreground">
          <h2 className="font-medium text-foreground">协作分工</h2>
          <p className="mt-2">
            产品说明业务问题并参与验收；数据负责人维护通用契约和评审；研发实现并提供自测证据；管理员处理权限、正式库治理与同步异常。实际可操作范围以
            App 权限为准。
          </p>
        </section>
      </Tabs>
    </div>
  );
}
