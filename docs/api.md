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
| GET | `/media` | 音频列表（默认 `status=READY`，光标分页） |
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

## 计划编排

计划把目标拆成阶段与任务；任务可要求音频证据或自评才能标记完成。计划可存为模板，复制时保留谱系（`copiedFromId` / `rootAncestorId`）；锁定后结构只读，改版生成同一版本链上的新版本（`versionChainId` + `versionNumber`），执行进度完整携带。进度以任务状态为唯一事实来源，任何变更后自动复算，也可手动触发。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plans` | 计划列表，支持 `status`、`isTemplate`、`headOnly` 过滤 |
| POST | `/plans` | 创建计划，可内嵌 `phases[].tasks[]` |
| GET | `/plans/:id` | 计划详情，含阶段、任务与证据 |
| PATCH | `/plans/:id` | 乐观锁更新元信息；请求必须带 `revision`，锁定后返回 `PLAN_LOCKED` |
| POST | `/plans/:id/lock` / `unlock` | 锁定/解锁；仅版本链首可解锁 |
| POST | `/plans/:id/revise` | 已锁定计划改版为 v+1 新版本，携带任务状态与证据 |
| POST | `/plans/:id/copy` | 复制为全新执行的计划（或模板），保留复制谱系 |
| GET | `/plans/:id/lineage` | 复制祖先链与同源计划家族 |
| GET | `/plans/:id/versions` | 版本链上的全部版本 |
| POST | `/plans/:id/activate` / `complete` / `archive` | 生命周期流转 |
| POST | `/plans/:id/recompute` | 手动复算阶段与计划进度 |
| POST/PATCH/DELETE | `/plans/:id/phases[/:phaseId]` | 阶段增改删（锁定后拒绝） |
| POST | `/plans/:id/phases/:phaseId/tasks` | 新增任务 |
| PATCH/DELETE | `/plans/:id/tasks/:taskId` | 任务改删（锁定后拒绝） |
| POST | `/plans/:id/tasks/:taskId/status` | 任务状态流转；完成时校验证据门槛 |
| POST/DELETE | `/plans/:id/tasks/:taskId/evidence[/:evidenceId]` | 关联/移除音频证据 |

关键规则：

- 锁定只冻结结构（元信息、阶段、任务定义）；任务执行与证据关联仅允许在非模板的链首版本上进行。
- 任务证据门槛：`AUDIO` 需至少一段 `READY` 音频，`SELF_REVIEW` 需自评说明，`AUDIO_AND_SELF_REVIEW` 两者都要；不满足时返回 `TASK_REQUIREMENTS_MISSING` 且 `details` 为缺失项。
- 进度口径：`SKIPPED` 任务移出分母，百分比 = 已完成 ÷（总数 − 已跳过），四舍五入取整；阶段与计划共用同一口径。

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
