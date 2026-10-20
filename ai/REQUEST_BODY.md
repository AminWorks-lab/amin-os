# 自定义请求参数

AI 设置 → API 连接 → OpenAI Compatible · 自定义请求参数。

编辑 JSON 对象，检查并格式化后保存，可随不同 API 配置独立保存。所有使用共享 AI 设置的应用生效，正在运行的任务保持原配置。此功能修改 JSON 请求体，不修改 URL 或请求头，也不应用于语音 TTS。

```json
{
  "temperature": 0.8,
  "top_p": 0.95,
  "max_tokens": null,
  "max_completion_tokens": 8192
}
```

默认请求体包含 model、messages、max_tokens、stream。自定义参数按顶层覆盖；嵌套对象整体替换；null 删除字段。留空或 {} 恢复默认行为。不同服务商支持的字段不同，请按接口文档填写。

可以覆盖 model/messages/stream；messages 覆盖会替换应用提示词，影响结构化输出。最终 model 和 messages 必须存在，stream 必须为布尔值或省略。请勿把 API 密钥放进 JSON，参数随配置明文保存。AI 设置的「任务记录」显示覆盖之后实际发送的请求，覆盖 messages 时会明确提示。

实现位于 `ai/request-body.js`（解析与合并）及 `ai/transport.js`（发送），AI 设置编辑器与请求预览共用同一解析逻辑。
