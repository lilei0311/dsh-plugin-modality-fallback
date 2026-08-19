# dsh-plugin-modality-fallback

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)插件:把**单次请求**路由到支持对应模态的备用模型,而不是让整个会话都被锁死在一个模型上。

## 要解决的问题

`dsh` 的一个会话(Agent)在整个生命周期里只能选定一个 `provider`/`model`。但这个模型未必能接受会话历史中出现的所有模态——目前主要是图片。在没有这个插件的情况下:

- 内置的 `read_image` 工具在会话当前模型没有声明支持 `image` 输入时会直接拒绝执行:"switch to an image-capable model to read images"。
- `ApiProxy` 在会话历史里已经有图片、而目标模型不支持图片时,会拒绝发送消息或拒绝切换模型。

这些路径最终都要求用户手动把**整个会话**切到一个支持图片的模型,用完再切回来——为了处理一张图片,牺牲了会话里其余部分特意选定的模型。

## 这个插件做了什么

它包裹了 `dsh` 的 `agent/request` waterfall 事件(这正是 `dsh-agent-default-model` 自己 README 里标注为遗留问题的扩展点:"per-session selection remains the entry point's responsibility")。在一次请求真正发出之前:

1. 读取会话已推导出的消息历史(`agent.session.deriveMessages()`)。
2. 如果这段历史需要纯文本之外的模态(目前只检测 `image`),并且其他所有监听器最终解析出的模型没有声明支持该模态(`llm.resolveModelInfo(...).inputModalities`),就查找为该模态配置的备用路由。
3. 如果配置了,就**仅为这一次请求**替换 `provider`/`model`。会话本身的选择不受影响——下一次请求(等图片滚出上下文,或者用户主动切换模型后)会照常正常解析。

不修改 `deepseek-harness` 的任何核心代码。这只是一个普通的 Cordis 插件,和你其余的 `dsh` 组合插件一起加载即可。

## 安装

```sh
npm install dsh-plugin-modality-fallback
```

## 使用

```ts
import ModalityFallback from 'dsh-plugin-modality-fallback'

await ctx.plugin(ModalityFallback, {
  fallback: {
    image: { provider: 'deepseek-official', model: 'deepseek-vision' },
  },
})
```

请在 `llm` 和 `agent`/`agent-loop` 插件之后加载它,确保 `ctx.llm` 和 `agent/request` waterfall 已经存在。

## 已知局限

- **目前只检测 `image` 模态。** `ModelModality` 本身是可扩展的词表,但这个插件的内容检测目前只会遍历图片 block。要扩展到其他模态,只需要新增一个内容判定函数,不需要改动路由机制本身。
- **每次请求最多只解决一个缺失的模态。** 如果未来的检测同时发现多个未满足的模态,目前只会路由第一个,其余的会原样透传。
- **`read_image` 和 `ApiProxy` 自己的门控不受影响。** 它们在请求真正构建*之前*就已经根据会话当前选定的模型做出拒绝判断,所以即便这个插件已经为对应模态配置好了可用的备用路由,它们依然会拒绝。要修复这一点需要改动 `deepseek-harness` 核心本身(让这些门控在拒绝前先咨询本插件或等价能力)——这超出了一个不改核心代码的插件的范围。
- **模型能力未知时按"可以"处理。** 当 `resolveModelInfo(...).inputModalities` 为 `undefined`(能力未知)时,插件不会触发路由——这与 `ApiProxy` 现有的发送/切换模型门控一致,但比 `read_image` 更宽松(`read_image` 在能力未知时会直接拒绝)。如果部署方希望在能力未知时也触发路由,应该让对应的 adapter 显式声明 `inputModalities`。
- **切换路由会丢弃继承的 reasoning effort**,而不是把可能不被备用模型支持的 effort 继续透传下去;转而使用备用路由自身 adapter/provider 的默认值。

## 为什么是插件,而不是提交给 `deepseek-harness` 的 PR

`deepseek-harness` 目前仍处于早期的开发者预览阶段,其 `CONTRIBUTING.md` 明确说明项目暂不接受外部 Pull Request。项目自己给出的建议是:做成插件分享出来——这个仓库就是这么做的,并打上了 `dsh-plugin` 这个 GitHub topic 以便被发现。

## License

MIT
