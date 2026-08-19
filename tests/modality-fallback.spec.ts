import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageBlock, LlmCallConfig, LlmResolvedModelInfo, Message, TextBlock } from '@deepseek-ai/dsh-llm'
import ModalityFallback from '../src/index.ts'

/** The smallest real `llm` service: an in-memory catalog, no adapter/provider I/O. */
class StubLlm extends Service {
  calls: Array<{ provider: string; model: string }> = []

  constructor(ctx: Context, private catalog: Record<string, LlmResolvedModelInfo>) {
    super(ctx, 'llm')
  }

  async resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.calls.push({ provider, model })
    const info = this.catalog[`${provider}/${model}`]
    if (info === undefined) throw new Error(`no such model "${provider}/${model}"`)
    return info
  }
}

const textMessage: Message = createUserMessage({
  content: [{ type: 'text', text: 'hello' } satisfies TextBlock],
  source: { kind: 'user' },
})

const imageMessage: Message = createUserMessage({
  content: [{
    type: 'image',
    attachment: {
      attachmentId: AttachmentId('att1'),
      mediaType: 'image/png',
      bytes: 128,
      width: 16,
      height: 16,
    },
  } satisfies ImageBlock],
  source: { kind: 'user' },
})

async function boot(
  catalog: Record<string, LlmResolvedModelInfo>,
  config: ConstructorParameters<typeof ModalityFallback>[1],
): Promise<{ ctx: Context; llm: StubLlm }> {
  const ctx = new Context()
  await ctx.plugin(StubLlm, catalog)
  await ctx.plugin(ModalityFallback, config)
  // `@deepseek-ai/dsh-llm` ambiently types `Context.llm` as the real `LlmRuntime`;
  // this test double satisfies only the one method the plugin under test calls.
  return { ctx, llm: ctx.get('llm') as unknown as StubLlm }
}

function agentWithHistory(messages: readonly Message[]): Agent {
  return { session: { deriveMessages: () => [...messages] } } as Agent
}

const signal = new AbortController().signal
const seed: LlmCallConfig = { provider: 'primary', model: 'text-only' }

describe('ModalityFallback', () => {
  it('leaves the route unchanged when the history carries no image', async () => {
    const { ctx, llm } = await boot({
      'primary/text-only': { provider: 'primary', id: 'text-only', name: 'text-only', inputModalities: ['text'] },
    }, { fallback: { image: { provider: 'vision', model: 'vision-1' } } })
    const agent = agentWithHistory([textMessage])

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    expect(llm.calls).toEqual([])
    await ctx.fiber.dispose()
  })

  it('leaves the route unchanged when the resolved model already declares image input', async () => {
    const { ctx } = await boot({
      'primary/text-only': { provider: 'primary', id: 'text-only', name: 'text-only', inputModalities: ['text', 'image'] },
    }, { fallback: { image: { provider: 'vision', model: 'vision-1' } } })
    const agent = agentWithHistory([textMessage, imageMessage])

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })

  it('leaves the route unchanged when declared modalities are unknown (permissive default)', async () => {
    const { ctx } = await boot({
      'primary/text-only': { provider: 'primary', id: 'text-only', name: 'text-only' },
    }, { fallback: { image: { provider: 'vision', model: 'vision-1' } } })
    const agent = agentWithHistory([imageMessage])

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })

  it('routes to the configured fallback for one request when the resolved model lacks image input', async () => {
    const { ctx } = await boot({
      'primary/text-only': { provider: 'primary', id: 'text-only', name: 'text-only', inputModalities: ['text'] },
    }, { fallback: { image: { provider: 'vision', model: 'vision-1' } } })
    const agent = agentWithHistory([textMessage, imageMessage])

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal },
      () => Promise.resolve({ ...seed, reasoningEffort: 'high' } as LlmCallConfig),
    )).resolves.toEqual({ provider: 'vision', model: 'vision-1' })
    await ctx.fiber.dispose()
  })

  it('passes the route through unchanged when no fallback is configured for the missing modality', async () => {
    const { ctx } = await boot({
      'primary/text-only': { provider: 'primary', id: 'text-only', name: 'text-only', inputModalities: ['text'] },
    }, { fallback: {} })
    const agent = agentWithHistory([imageMessage])

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })

  it('overrides a session model-selection listener registered after it', async () => {
    const { ctx } = await boot({
      'primary/text-only': { provider: 'primary', id: 'text-only', name: 'text-only', inputModalities: ['text'] },
    }, { fallback: { image: { provider: 'vision', model: 'vision-1' } } })
    // A later-registered listener simulating session model selection: it still
    // wins over the seed, but the fallback plugin (registered first via
    // `prepend: true`) applies on the way back out and has the final say.
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'primary', model: 'text-only' }))
    const agent = agentWithHistory([imageMessage])

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve({ provider: 'seed', model: 'seed' }),
    )).resolves.toEqual({ provider: 'vision', model: 'vision-1' })
    await ctx.fiber.dispose()
  })
})
