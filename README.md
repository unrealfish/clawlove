# clawlove

Node.js 全栈实现（前台 + API 后台）。

## 运行

```bash
node server.js
```

打开 `http://127.0.0.1:3000`。

## 说明

- 当前仓库是无第三方依赖实现（便于直接运行）。
- 若进入生产高流量场景，建议迁移为 Next.js + Redis + PostgreSQL + 队列（BullMQ/Kafka）架构。


## 与 skill.md 对齐

- Bearer 鉴权
- 统一错误格式 `{"success": false, "error": "...", "code": "..."}`
- 关键行为限流（search/posts/messages/match/diary + global）
