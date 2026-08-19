/**
 * dsh-plugin-modality-fallback
 *
 * A DeepSeek Harness (dsh) Cordis plugin.
 *
 * A session (Agent) selects one provider/model for its whole lifetime, but a
 * single model may not accept every modality that shows up in that session's
 * history — today that means images. Without this plugin, a request whose
 * derived history contains an image but whose selected model does not
 * declare `image` input either goes out anyway, or is refused upstream by a
 * tool/host gate (`read_image`, ApiProxy's send/switch-model gates) with a
 * message telling the user to switch the whole session to an image-capable
 * model and back.
 *
 * This plugin wraps the `agent/request` waterfall. For one request at a
 * time, when the session's derived history actually needs a modality the
 * resolved model does not declare, and a fallback route is configured for
 * that modality, it swaps the resolved provider/model for the fallback route
 * — for that request only. The session's own selection is untouched, so the
 * next request (once the image scrolls out of context, or the user switches
 * models) resolves normally again.
 *
 * @module dsh-plugin-modality-fallback
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { contentHasImage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, Message, ModelModality } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-request fallback routing for modalities the session's own model can't carry. */
    modalityFallback: ModalityFallback
  }
}

/** One fallback provider/model route for a single modality. */
export interface ModalityRoute {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id; must declare the modality this route exists for. */
  model: string
}

/** Fallback routes keyed by the modality they cover. Only `image` is checked today. */
export type ModalityFallbackMap = Partial<Record<ModelModality, ModalityRoute>>

/** Plugin config. */
export interface Config {
  /** Fallback route to use for one request when the session's selected model can't carry a required modality. */
  fallback: ModalityFallbackMap
}

/**
 * Modalities this plugin knows how to detect from message content. Additive:
 * a future modality (audio, video, ...) needs one more entry here plus its
 * own content predicate in {@link requiredModalities}.
 */
const DETECTABLE_MODALITIES: readonly ModelModality[] = ['image']

/**
 * Modalities beyond plain text that the given messages require, in
 * {@link DETECTABLE_MODALITIES} order.
 * @param messages - the session's derived history for the upcoming request.
 * @returns the modalities present in `messages` that this plugin can detect.
 */
function requiredModalities(messages: readonly Message[]): ModelModality[] {
  if (messages.some(message => contentHasImage(message.content))) return ['image']
  return []
}

/**
 * Whether a resolved route declares support for a modality. Absent
 * `inputModalities` means unknown capability, treated as capable (permissive) —
 * matching the existing `ApiProxy` send/switch-model gates it complements,
 * not the stricter `read_image` tool gate, which refuses on unknown capability.
 * A deployment that wants the plugin to redirect on unknown capability too
 * should configure the adapter to declare `inputModalities` explicitly.
 * @param inputModalities - modalities the resolved model declares, or undefined when unknown.
 * @param modality - the modality the upcoming request needs.
 * @returns false only when the model positively does not declare `modality`.
 */
function declaresModality(inputModalities: readonly ModelModality[] | undefined, modality: ModelModality): boolean {
  return inputModalities === undefined || inputModalities.includes(modality)
}

/**
 * Owns per-request modality fallback routing. Registers one `agent/request`
 * listener ahead of every other listener (including session model
 * selection) so its override, when it applies, is the one that reaches the
 * adapter.
 */
export class ModalityFallback extends Service {
  static inject = ['llm']

  private readonly fallback: ModalityFallbackMap

  constructor(ctx: Context, config: Config) {
    super(ctx, 'modalityFallback')
    this.fallback = config.fallback
    ctx.on('agent/request', (payload, next) => this.route(payload, next), { prepend: true })
  }

  /**
   * Resolve the route one request should actually use.
   * @param payload - the agent, turn/step coordinates, and cancellation signal for this request.
   * @param next - resolves the config every other `agent/request` listener produces.
   * @returns `next()`'s config unchanged, or that config with `provider`/`model` swapped to
   *   the configured fallback route for one modality it does not declare.
   */
  private async route(
    payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<LlmCallConfig>,
  ): Promise<LlmCallConfig> {
    const resolved = await next()
    if (!resolved.provider || !resolved.model) return resolved

    const needed = requiredModalities(payload.agent.session.deriveMessages())
    if (needed.length === 0) return resolved

    const info = await this.ctx.llm.resolveModelInfo(resolved.provider, resolved.model, payload.signal)
    const missing = needed.find(modality => !declaresModality(info.inputModalities, modality))
    if (missing === undefined) return resolved

    const route = this.fallback[missing]
    if (route === undefined) return resolved
    if (route.provider === resolved.provider && route.model === resolved.model) return resolved

    // The fallback model may not support the previously selected effort; let
    // adapter/provider defaults apply rather than forwarding a mismatched one.
    const { reasoningEffort: _inherited, ...withoutInheritedEffort } = resolved
    return { ...withoutInheritedEffort, provider: route.provider, model: route.model }
  }
}

export default ModalityFallback
