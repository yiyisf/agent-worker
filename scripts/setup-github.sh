#!/usr/bin/env bash
# 一次性初始化 GitHub 仓库设置：合并策略、标签、里程碑、environments、分支保护，并创建 M1 issue。
# 依赖：gh CLI 已登录（gh auth login），且对仓库有 admin 权限。可重复执行：已存在的项会跳过。
#
# 用法：
#   ./scripts/setup-github.sh             # 全部
#   SKIP_ISSUES=1 ./scripts/setup-github.sh
set -uo pipefail

REPO="${REPO:-yiyisf/agent-worker}"
M1_DUE="${M1_DUE:-2026-11-04T23:59:59Z}"
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
info() { printf '\033[32m[ok]\033[0m %s\n' "$*"; }

gh auth status >/dev/null 2>&1 || { echo "请先执行 gh auth login"; exit 1; }

echo "== 仓库合并策略"
gh repo edit "$REPO" --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false \
  --delete-branch-on-merge --enable-auto-merge >/dev/null && info "只允许 squash merge，合并后删除分支"

echo "== 标签"
while IFS='|' read -r name color desc; do
  [ -z "$name" ] && continue
  gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force >/dev/null && info "label $name"
done <<'LABELS'
pkg:core|c5def5|@ca/core
pkg:conductor|c5def5|@ca/conductor
pkg:engine-ai-sdk|c5def5|@ca/engine-ai-sdk
pkg:engine-harness|c5def5|@ca/engine-harness
pkg:engine-custom|c5def5|@ca/engine-custom
pkg:engine-pi-durable|c5def5|@ca/engine-pi-durable（实验 S1）
pkg:memory|c5def5|@ca/memory
pkg:observability|c5def5|@ca/observability
pkg:testing|c5def5|@ca/testing
pkg:cli|c5def5|@ca/cli
type:feat|a2eeef|功能
type:bug|d73a4a|缺陷
type:spike|fbca04|调研或待确认
type:docs|0075ca|文档
risk:contract|e99695|涉及服务端行为
risk:schema|e99695|涉及信封或 TaskDef 推导
blocked|000000|被阻塞
needs-decision|fef2c0|需要决策
LABELS

echo "== 里程碑"
milestone() { # title due description
  if gh api "repos/$REPO/milestones?state=all&per_page=100" --jq '.[].title' | grep -qx "$1"; then
    info "milestone $1 已存在"
  else
    local args=(-f title="$1" -f description="$3")
    [ -n "$2" ] && args+=(-f due_on="$2")
    gh api "repos/$REPO/milestones" "${args[@]}" >/dev/null && info "milestone $1"
  fi
}
milestone "M1" "$M1_DUE" "最小可用：core 契约 + 受管入口 + Journal + callback + 保活 + engine-ai-sdk + 桥接 + 进展反馈"
milestone "M2" "" "可靠性：Fencing + 错误分类 + 取消检测 + 崩溃/并发/分片测试 + 引擎一致性套件"
milestone "M3" "" "多引擎：engine-harness + engine-custom + 能力校验"
milestone "M4" "" "配置化与领域定制：AgentSpec 全量 + SpecLoader + Domain Pack"
milestone "M5" "" "生态与交互：HITL 两级、ConductorWorkflowTool、MCP、StreamSink"
milestone "M6" "" "生产化：OTel、语义指标、预算治理、多租户、CLI、文档站"

echo "== environments（密钥与变量需在网页中填写）"
for env in conductor-test release; do
  gh api -X PUT "repos/$REPO/environments/$env" >/dev/null && info "environment $env"
done
cat <<'TIP'
   请在 Settings → Environments 中完成：
   - conductor-test：变量 CONDUCTOR_URL、CAS_OWNER_EMAIL；密钥 CONDUCTOR_TOKEN（如有）；部署分支限制为 main
   - release：变量 NPM_REGISTRY_URL；密钥 NPM_TOKEN；添加 required reviewers
   并在 Settings → Actions → Runners 注册内网 self-hosted runner，标签 cas-intranet
TIP

echo "== main 分支保护"
if gh api -X PUT "repos/$REPO/branches/main/protection" --input - >/dev/null 2>&1 <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["verify", "pr-title"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
then
  info "main 分支保护已开启（需 PR、CI 通过、CODEOWNERS 批准、线性历史）"
else
  warn "分支保护设置失败：确认 main 分支已存在；个人账号的私有仓库需要 GitHub Pro 才能使用分支保护"
fi

[ "${SKIP_ISSUES:-}" = "1" ] && exit 0

echo "== M1 issue"
existing=$(gh issue list --repo "$REPO" --state all --limit 500 --json title --jq '.[].title')
issue() { # title labels body
  if grep -qxF "$1" <<<"$existing"; then info "issue 已存在：$1"; return; fi
  gh issue create --repo "$REPO" --title "$1" --label "$2" --milestone M1 --body "$3" >/dev/null && info "issue $1"
}
issue "仓库基建：pnpm lockfile、CI 全绿、分支保护" "type:feat" "pr.yml 在 main 上全绿；运行 scripts/setup-github.sh 开启分支保护。"
issue "内网 self-hosted runner 与 contract-nightly" "type:feat,risk:contract" "注册标签为 cas-intranet 的 runner，配置 conductor-test environment，手动触发一次 contract-nightly 通过。"
issue "契约实验：extendLease 心跳" "type:spike,pkg:conductor,risk:contract" "运行 contract-verify 的 extend-lease 变体，结论决定 ADR-0024 的默认保活模式（architecture.md §15.4）。"
issue "验证官方 SDK 4.0.0 是否保留 nameCn" "type:spike,pkg:conductor,risk:contract" "用 SDK 注册带 nameCn 的 TaskDef / WorkflowDef 并读回。若字段被丢弃，保持 MetadataApi 走 REST（ADR-0023）。"
issue "信封 schema 评审与冻结" "type:feat,pkg:conductor,risk:schema" "评审 packages/conductor/src/envelope，确认后冻结 schemaVersion=1，并加入快照测试（ADR-0020）。"
issue "分片内保活定时器" "type:feat,pkg:conductor,risk:contract" "按 ADR-0024 实现 extend-lease / in-progress 两种模式；连续 2 次失败中止；指标 ca_keepalive_failures_total。"
issue "上报前归属检查与本地体积校验" "type:feat,pkg:conductor,risk:contract" "按 ADR-0022 实现；指标 ca_stale_completion_total。"
issue "MockConductorServer" "type:feat,pkg:testing" "按 architecture.md §2.3 建模：IN_PROGRESS 推迟消息、超时生成新 taskId、迟到 COMPLETED 返回 200 但不推进工作流。"
issue "Journal + StateStore(redis) + fenceToken" "type:feat,pkg:core,pkg:memory" "两个受管入口写 journal；条件写入以 fenceToken 为令牌，被拒写入抛 FencedOutError。"
issue "AI SDK ToolLoopAgent 引擎适配" "type:feat,pkg:engine-ai-sdk" "wrapLanguageModel 中间件、tool.execute 包装、stopWhen 翻译 SliceBudget。"
issue "minimal-agent 在 3.21.21 定制版上端到端跑通" "type:feat" "含跨分片恢复与单次长调用不超时；运行中在 Conductor UI 能看到进度（M1 出口标准）。"
issue "[S1] Pi Durable 实验：单写者 Conductor 配置与 fencing 兜底" "type:spike,pkg:engine-pi-durable,pkg:conductor,risk:contract" "双 worker 竞争 + 中途杀进程 + 网络分区注入，验证 ADR-0026 的配置；统计 fencingStorage 拦截次数（architecture.md §15.5）。"
issue "[S1] Pi Durable 实验：受管入口接入与能力假设验证" "type:spike,pkg:engine-pi-durable" "包装 models、wrapTool 覆盖内建工具、effectful 中断拦截；结论写回 architecture.md §4.4。"
issue "[S1] Pi Durable 实验：PG 版 Storage" "type:spike,pkg:engine-pi-durable" "按 Pi Durable spec §10 存储契约实现，跑崩溃注入与吞吐测试。"
issue "待确认：TaskDef schema 是否被服务端实际校验" "type:spike,risk:contract" "注册 schema 后用非法 input 启动工作流验证。"
issue "待确认：外部化 input 时官方 SDK 是否自动下载" "type:spike,risk:contract" "构造超过外部化阈值的 input，观察 worker 收到的内容。"
issue "决策：StateStore / BlobStore 选型与 TTL" "needs-decision" "Redis 或 PG；S3 或 MinIO。"
issue "决策：私有 npm 仓库" "needs-decision" "GitHub Packages（包名 scope 需与仓库 owner 一致）或内部 registry。"
