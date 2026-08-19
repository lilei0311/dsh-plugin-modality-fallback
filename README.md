# dsh-plugin-modality-fallback

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin. Route **one request** to a modality-capable fallback model instead of forcing the whole session onto a single model.

## The problem

A `dsh` session (Agent) selects one `provider`/`model` for its entire lifetime. That single model may not accept every modality that shows up in the session's history — today that means images. Without this plugin:

- The built-in `read_image` tool refuses outright when the session's model does not declare `image` input: *"switch to an image-capable model to read images."*
- `ApiProxy` refuses to send a message, or to switch models, when the session's history already contains an image the target model can't accept.

Every one of these paths tells the user to manually switch the **whole session** to an image-capable model and back — losing the differentiated model choice they made for everything else in that conversation.

## What this plugin does

It wraps `dsh`'s `agent/request` waterfall (the extension point `dsh-agent-default-model`'s own README documents as deferred: *"per-session selection remains the entry point's responsibility"*). Before a request goes out:

1. It reads the session's derived message history (`agent.session.deriveMessages()`).
2. If that history needs a modality beyond plain text (currently: `image`) and the model resolved by every other listener does not declare that modality (`llm.resolveModelInfo(...).inputModalities`), it looks up a configured fallback route for that modality.
3. If one is configured, it swaps `provider`/`model` for **that request only**. The session's own selection is untouched — the next request (once the image scrolls out of context, or the user switches models) resolves normally again.

No core `deepseek-harness` code is modified. This is an ordinary Cordis plugin, loaded alongside the rest of your `dsh` composition.

## Install

```sh
npm install dsh-plugin-modality-fallback
```

## Use

```ts
import ModalityFallback from 'dsh-plugin-modality-fallback'

await ctx.plugin(ModalityFallback, {
  fallback: {
    image: { provider: 'deepseek-official', model: 'deepseek-vision' },
  },
})
```

Load it after your `llm` and `agent`/`agent-loop` plugins so `ctx.llm` and the `agent/request` waterfall already exist.

## Known limitations

- **Only `image` is detected today.** The modality vocabulary (`ModelModality`) is open-ended, but this plugin's content check only walks for image blocks. Extending it to another modality means adding a content predicate, not changing the routing mechanism.
- **At most one missing modality is resolved per request.** If a future modality check finds more than one unmet modality at once, only the first is routed; the rest fall through unchanged.
- **`read_image` and `ApiProxy`'s own gates are unaffected.** Those refuse *before* a request is ever built, based only on the session's currently selected model, so they refuse even when this plugin has a working fallback configured for the very modality they're gating. Fixing that requires a change in `deepseek-harness` core itself (those gates would need to consult this plugin, or an equivalent capability, before refusing) — out of scope for a plugin that doesn't touch core.
- **Unknown model capability is treated as capable.** When `resolveModelInfo(...).inputModalities` is `undefined` (capability unknown), the plugin does not redirect — matching `ApiProxy`'s existing send/switch-model gates, not the stricter `read_image` gate (which refuses on unknown capability). A deployment that wants redirection on unknown capability too should have its adapter declare `inputModalities` explicitly.
- **A route switch drops the inherited reasoning effort** rather than forwarding one the fallback model may not support; the fallback route's own adapter/provider default applies instead.

## Why a plugin, not a `deepseek-harness` PR

`deepseek-harness` is still at an early developer-preview stage and its `CONTRIBUTING.md` states the project does not accept external pull requests yet. Its own guidance for this situation is to build a plugin and share it — this repository does that, tagged with the `dsh-plugin` GitHub topic for discoverability.

## License

MIT
