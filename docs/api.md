# API 契约

基础路径：`/api/v1`。除注册、登录和刷新外，请求使用 `Authorization: Bearer <accessToken>`。

错误统一返回：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求字段不合法",
    "details": [],
    "traceId": "req-..."
  }
}
```

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | 注册并返回 Access Token，同时设置 Refresh Cookie |
| POST | `/auth/login` | 登录并轮换 Refresh Cookie |
| POST | `/auth/refresh` | 使用 Cookie 轮换刷新令牌 |
| POST | `/auth/logout` | 撤销当前 Refresh Session 并清除 Cookie |

Refresh Cookie 路径为 `/api/v1/auth`，生产环境在 HTTPS 下自动使用 `Secure`。

## 用户与设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/users/me` | 当前用户 |
| PATCH | `/users/me` | 更新展示名、默认乐器、时区和语言 |
| POST | `/users/me/password` | 修改密码并撤销其他会话 |

## 练习

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions` | 光标分页、搜索、筛选和排序 |
| POST | `/sessions` | 创建练习 |
| GET | `/sessions/:id` | 详情，包含音频、标记、目标和复盘 |
| PATCH | `/sessions/:id` | 乐观锁更新；请求必须带 `version` |
| POST | `/sessions/:id/start-review` | 存在已就绪音频时进入 `IN_REVIEW` |
| GET | `/sessions/:id/completion-check` | 返回结构化缺失项 |
| POST | `/sessions/:id/complete` | 原子完成复盘 |
| POST | `/sessions/:id/archive` | 归档已完成练习 |
| POST | `/sessions/:id/restore` | 恢复归档练习 |
| DELETE | `/sessions/:id` | 必须提交完整 `confirmationTitle` |

创建练习：

```json
{
  "title": "协奏曲第二乐章 17-24 小节",
  "instrument": "小提琴",
  "startedAt": "2026-09-29T12:00:00.000Z",
  "focus": "换把后的音准",
  "location": "琴房 A",
  "notes": "节拍器 84 BPM",
  "actualDurationMs": 1800000
}
```

## 音频上传

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions/:sessionId/media/uploads` | 创建上传会话并返回预签名 PUT URL |
| POST | `/media/:mediaId/complete-upload` | 校验对象大小/SHA-256 并投递探测任务 |
| GET | `/media/:mediaId` | 状态、元数据与波形峰值 |
| GET | `/media/:mediaId/playback-url` | 获取短期私有播放地址 |
| POST | `/media/:mediaId/retry-probe` | 重试音频探测 |
| DELETE | `/media/:mediaId` | 删除对象和关联标记 |

创建上传会话：

```json
{
  "originalName": "practice.wav",
  "mimeType": "audio/wav",
  "sizeBytes": 2646000,
  "sha256": "64-hex-characters"
}
```

预签名请求的 `Content-Type` 和 `x-amz-meta-sha256` 已纳入签名，必须使用返回的 `requiredHeaders` 原样上传。

## 标记

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:sessionId/annotations` | 标记列表 |
| POST | `/sessions/:sessionId/annotations` | 新增标记 |
| PATCH | `/annotations/:id` | 编辑标记 |
| DELETE | `/annotations/:id` | 删除标记 |

区间使用毫秒整数，最小时长 100 ms，且不能超过音频时长。问题类型为 `RHYTHM`、`FINGERING` 或 `EMOTION`。

## 复盘与目标

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:sessionId/review` | 获取复盘 |
| PUT | `/sessions/:sessionId/review` | 保存复盘草稿 |
| POST | `/sessions/:sessionId/review/complete` | 完成复盘事务 |
| GET/POST | `/goals` | 目标列表/创建 |
| GET/PATCH | `/goals/:id` | 目标详情/更新 |
| POST | `/goals/:id/activate` | 重新激活取消或逾期目标 |
| POST | `/goals/:id/cancel` | 带原因取消 |
| POST | `/goals/:id/complete` | 用户确认完成 |
| GET/POST | `/goals/:id/progress` | 进度列表/新增 |

完成复盘请求会原子写入复盘、目标、进度并更新练习状态。任一步失败时全部回滚，返回 `REVIEW_INCOMPLETE` 且 `details` 为缺失项数组。

## 练习计划编排

计划把目标拆成有序阶段与任务，任务按 `requiredEvidence` 要求音频证据个数，进度由证据实时复算。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/plans` | 计划列表（含进度摘要）/从零创建 |
| GET/PATCH | `/plans/:id` | 计划详情/更新目标（仅草稿，需带 `revision`） |
| PUT | `/plans/:id/structure` | 结构整体替换（仅草稿，需带 `revision`；携带已有阶段/任务 `id` 表示保留） |
| POST | `/plans/:id/lock` | 锁定进入执行期；结构不完整时返回 `PLAN_LOCK_BLOCKED` 及缺失项 |
| POST | `/plans/:id/revise` | 改版：旧版本归档为不可变快照，新建 `version+1` 草稿并继承证据 |
| POST | `/plans/:id/copy` | 复制为全新执行实例（v1 草稿，不带证据），谱系指向来源 |
| POST | `/plans/:id/save-as-template` | 把当前结构另存为模板 |
| GET | `/plans/:id/progress` | 复算进度（阶段/任务明细 + 加权汇总） |
| GET | `/plans/:id/lineage` | 谱系链：从当前计划回溯到模板或更早版本 |
| POST | `/plans/:id/tasks/:taskId/evidence` | 挂载音频证据（仅锁定中；媒体须为本人 `READY` 音频） |
| DELETE | `/plans/:id/evidence/:evidenceId` | 移除证据（仅锁定中） |

状态机：`DRAFT`（结构可编辑）→ `LOCKED`（结构冻结，可挂证据）→ 改版后旧版本 `ARCHIVED`。`version` 是业务版本号（改版 +1），`revision` 是乐观锁。

创建计划（模板实例化、复制与另存模板请求体结构相同）：

```json
{
  "goal": "四周拿下《克莱采尔》第 2 课",
  "stages": [
    {
      "title": "第一阶段：慢练",
      "tasks": [
        { "title": "1-8 小节 60 BPM 连续三遍无错", "requiredEvidence": 3, "weight": 2 },
        { "title": "换把位音准抽查", "requiredEvidence": 1, "weight": 1 }
      ]
    }
  ]
}
```

## 计划模板

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/plan-templates` | 模板列表/创建（至少一个阶段） |
| GET | `/plan-templates/:id` | 模板详情 |
| POST | `/plan-templates/:id/instantiate` | 实例化为 v1 草稿计划，谱系指向模板 |

谱系规则：实例化记录 `originTemplateId`；复制记录 `originPlanId`/`originPlanVersion`；改版同理并递增 `version`；另存模板记录 `sourcePlanId`。阶段与任务上的 `derivedFrom*Id` 记录结构级来源，`evidence.inheritedFromId` 记录证据继承来源。`/plans/:id/lineage` 沿这些指针从近到远返回完整链路。

进度口径：任务完成 ⇔ 证据数 ≥ `requiredEvidence`；阶段与整体按任务 `weight` 加权汇总。进度不落库，每次读取都用最新任务与证据整体复算，因此删除证据、改版继承或音频被清理后重算结果自动一致。

## 统计与导出

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/statistics/overview` | 总览指标 |
| GET | `/statistics/trends` | 按用户时区分日趋势 |
| GET | `/statistics/issues` | 问题类型、严重度和困难片段 |
| GET | `/statistics/goals` | 目标完成率和逾期 |
| GET | `/statistics/instruments` | 各乐器聚合 |
| GET | `/statistics/dashboard` | 首页聚合 |
| POST | `/exports` | 创建 JSON/CSV 用户数据导出 |
| GET | `/exports/:id` | 查询导出状态和短时下载地址 |

统计接口必须传 `from`、`to` 和 IANA `timezone`。

## 健康检查

| 路径 | 说明 |
|---|---|
| `/health/live` | 仅检查进程存活 |
| `/health/ready` | 检查 PostgreSQL、Redis 和对象存储 |
| `/metrics` | Prometheus 文本指标 |
