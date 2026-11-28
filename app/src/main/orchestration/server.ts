import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { findAgent, isAgentId, type AgentId } from '../../shared/agents'
import { workerParentId } from '../../shared/chats'
import type { AgentCatalog, ModelSelection } from '../../shared/conversation'
import type { Chat } from '../../shared/models'
import {
  OrchestrationEnv,
  PARENT_ADDRESS,
  type OrchestrationMethod,
  type OrchestrationMethods,
  type OrchestrationRequest,
  type OrchestrationResponse
} from '../../shared/orchestration'
import type { AgentDetector } from '../agents'
import { CanvasError } from '../canvas/rules'
import type { CanvasService, CanvasTarget } from '../canvas/service'
import { errorMessage } from '../conversations/display'
import type { ConversationManager } from '../conversations/manager'
import type { ChatLocation, ProjectStore } from '../store'
import { formatMessage, formatReport, formatWorkerTask } from './prompts'

/** Запрос — одна строка JSON; больше этого — не команда, а ошибка или мусор. */
const MAX_REQUEST_BYTES = 1024 * 1024

/** Права на сокет: только для текущего пользователя. */
const OWNER_ONLY = 0o600

interface OrchestrationServices {
  store: ProjectStore
  conversations: ConversationManager
  agents: AgentDetector
  canvas: CanvasService
  /** Путь к сокету, через который команда `atox` обращается к приложению. */
  socketPath: string
  /** Путь к команде `atox`, которую получают агенты. */
  cliPath: string
  /** Модель и эффорт, с которыми пользователь начинает новые чаты агента. */
  modelSelection(agent: AgentId): Partial<ModelSelection>
  /** Список чатов изменился без участия окна — например, агент запустил помощника. */
  onProjectsChanged(): void
}

/** Ошибка, понятная агенту: её текст уходит в ответ команды как есть. */
class CommandError extends Error {}

/** Холст, который назвал агент (`--canvas`), в чате вызывающего. */
function targetOf(caller: ChatLocation, canvas: unknown): CanvasTarget {
  return { chatId: caller.chat.id, ...(typeof canvas === 'string' && { canvas }) }
}

type Handlers = {
  [Method in OrchestrationMethod]: (
    caller: ChatLocation,
    params: OrchestrationMethods[Method]['params']
  ) => Promise<OrchestrationMethods[Method]['result']> | OrchestrationMethods[Method]['result']
}

/**
 * Принимает команды `atox` от агентов чатов: агент может запустить помощника в соседнем
 * чате, переписываться с ним и получить его отчёт. Помощники одного уровня: свои помощники
 * им запускать нельзя, чтобы агенты не плодили друг друга бесконечно.
 */
export class OrchestrationServer {
  /**
   * Из секрета выводится свой токен каждого чата: агент может действовать только от имени
   * своего чата, даже если узнает id чужого — например, помощник id своего агента.
   */
  private readonly secret = randomBytes(32)
  /** Помощники, которые отчитались и с тех пор не получали новых сообщений от агента. */
  private readonly reportedChatIds = new Set<string>()
  private server: Server | null = null

  constructor(private readonly services: OrchestrationServices) {}

  async start(): Promise<void> {
    // Сокет прошлого запуска остаётся файлом и не даёт занять адрес. Канал Windows — не
    // файл: он исчезает вместе с процессом, а права на него задаёт система.
    const pipe = process.platform === 'win32'
    if (!pipe) {
      await rm(this.services.socketPath, { force: true })
    }
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.services.socketPath, resolve)
    })
    if (!pipe) {
      await chmod(this.services.socketPath, OWNER_ONLY)
    }
    this.server = server
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  /** Переменные, по которым команда `atox`, запущенная агентом чата, находит приложение и себя. */
  environment(chatId: string): Record<string, string> {
    return {
      [OrchestrationEnv.Socket]: this.services.socketPath,
      [OrchestrationEnv.Token]: this.chatToken(chatId),
      [OrchestrationEnv.ChatId]: chatId,
      [OrchestrationEnv.Cli]: this.services.cliPath
    }
  }

  private chatToken(chatId: string): string {
    return createHmac('sha256', this.secret).update(chatId).digest('hex')
  }

  private isAuthorized({ token, chatId }: OrchestrationRequest): boolean {
    const expected = Buffer.from(this.chatToken(chatId))
    const received = Buffer.from(token)
    return received.length === expected.length && timingSafeEqual(received, expected)
  }

  private accept(socket: Socket): void {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) {
        if (buffer.length > MAX_REQUEST_BYTES) {
          socket.destroy()
        }
        return
      }
      socket.removeAllListeners('data')
      void this.respond(buffer.slice(0, newline)).then((response) =>
        socket.end(`${JSON.stringify(response)}\n`)
      )
    })
  }

  private async respond(line: string): Promise<OrchestrationResponse> {
    try {
      const request = parseRequest(line)
      if (!this.isAuthorized(request)) {
        throw new CommandError('Not authorized: run atox from an agent inside Atox.')
      }
      const caller = this.services.store.findChat(request.chatId)
      if (!caller) {
        throw new CommandError('This agent does not belong to an Atox chat.')
      }
      // Только свои методы: имя из запроса не должно находить методы прототипа объекта.
      const handler = Object.hasOwn(this.handlers, request.method)
        ? (this.handlers[request.method] as (caller: ChatLocation, params: unknown) => unknown)
        : undefined
      if (!handler) {
        throw new CommandError(`Unknown command: ${request.method}`)
      }
      return { ok: true, result: (await handler(caller, request.params)) as never }
    } catch (error) {
      const understood = error instanceof CommandError || error instanceof CanvasError
      const message = understood ? error.message : 'Atox could not run the command.'
      if (!understood) {
        console.error('Orchestration command failed', error)
      }
      return { ok: false, error: message }
    }
  }

  private readonly handlers: Handlers = {
    agents: async () => {
      const installed = await this.services.agents.list()
      return installed.map((id) => ({ id, name: findAgent(id)?.name ?? id }))
    },

    models: async (_caller, { agent }) => {
      const { defaultModel, models } = await this.catalog(await this.installedAgent(agent))
      return {
        defaultModel,
        models: models.map(({ id, name, efforts, defaultEffort }) => ({
          id,
          name,
          efforts,
          ...(defaultEffort && { defaultEffort })
        }))
      }
    },

    start: async (caller, { agent, task, title, model, effort }) => {
      if (workerParentId(caller.chat)) {
        throw new CommandError('A worker cannot start workers of its own.')
      }
      if (!task?.trim()) {
        throw new CommandError('The task is empty.')
      }
      const agentId = await this.installedAgent(agent)
      const selection = await this.workerSelection(agentId, model, effort)
      // Помощников сколько угодно: сколько их запускать, решает человек, а не Atox.
      const { chat } = this.services.store.createWorkerChat(
        caller.chat.id,
        agentId,
        title,
        selection
      )
      // Задание — первое сообщение помощнику: он сразу начинает работать. Чат без своего
      // названия называется по заданию, а не по служебному началу сообщения.
      await this.services.conversations.send(
        chat.id,
        formatWorkerTask(caller.chat, task),
        {},
        { titleFrom: task }
      )
      this.services.onProjectsChanged()
      return {
        chatId: chat.id,
        title: chat.title,
        ...(chat.model && { model: chat.model }),
        ...(chat.effort && { effort: chat.effort })
      }
    },

    send: async (caller, { to, message, now }) => {
      if (!message?.trim()) {
        throw new CommandError('The message is empty.')
      }
      if (now === true) {
        if (to === PARENT_ADDRESS) {
          throw new CommandError(
            'Only a parent agent can interrupt: send to "parent" without --now.'
          )
        }
        const worker = this.ownWorker(caller, String(to), 'interrupt')
        const interrupted = this.services.conversations.isWorking(worker.id)
        await this.deliver(worker, formatMessage(caller.chat, message), { now: true })
        this.reportedChatIds.delete(worker.id)
        return { chatId: worker.id, interrupted }
      }
      const target = this.resolveRecipient(caller.chat, to)
      await this.deliver(target, formatMessage(caller.chat, message))
      // Новое сообщение от агента — новая работа: помощник снова может отчитаться.
      if (workerParentId(target) === caller.chat.id) {
        this.reportedChatIds.delete(target.id)
      }
      return { chatId: target.id }
    },

    interrupt: async (caller, { chatId }) => {
      if (typeof chatId !== 'string' || !chatId) {
        throw new CommandError('Specify the chat id of the worker to interrupt.')
      }
      const worker = this.ownWorker(caller, chatId, 'interrupt')
      const { conversations } = this.services
      const interrupted = conversations.isWorking(worker.id)
      const queued = conversations.queuedCount(worker.id)
      if (interrupted) {
        await conversations.interrupt(worker.id)
      }
      return { interrupted, queued }
    },

    report: async (caller, { summary }) => {
      const parentId = workerParentId(caller.chat)
      if (!parentId) {
        throw new CommandError('Only a worker started with "atox start" can report.')
      }
      const parent = this.recipient(parentId, 'The parent chat')
      if (!summary?.trim()) {
        throw new CommandError('The report is empty.')
      }
      if (this.reportedChatIds.has(caller.chat.id)) {
        throw new CommandError(
          'You already reported this task. Report again only after a new message from the agent.'
        )
      }
      // Отметка ставится до доставки, чтобы два отчёта подряд не ушли оба.
      this.reportedChatIds.add(caller.chat.id)
      try {
        await this.deliver(parent, formatReport(caller.chat, summary))
      } catch (error) {
        this.reportedChatIds.delete(caller.chat.id)
        throw error
      }
      return { chatId: parent.id }
    },

    remove: async (caller, { chatIds }) => {
      const ids = Array.isArray(chatIds) ? [...new Set(chatIds.map(String))] : []
      if (ids.length === 0) {
        throw new CommandError('Specify the chat ids of the workers to remove.')
      }
      // Сначала проверяются все чаты: команда либо удаляет всех названных помощников, либо никого.
      const workers = ids.map((id) => this.ownWorker(caller, id, 'remove'))
      for (const worker of workers) {
        this.services.store.removeChat(worker.id)
        await this.services.conversations.remove(worker.id)
        this.reportedChatIds.delete(worker.id)
      }
      this.services.onProjectsChanged()
      return { removed: workers.map(({ id }) => id) }
    },

    canvas: (caller, { canvas }) => this.services.canvas.describe(targetOf(caller, canvas)),

    canvasNew: (caller, { name }) => {
      if (typeof name !== 'string' || !name.trim()) {
        throw new CommandError('Specify the canvas name.')
      }
      return this.services.canvas.createForAgent(caller, name)
    },

    canvasScreenSet: (caller, { name, file, device, size, canvas }) => {
      if (typeof name !== 'string' || (file !== undefined && typeof file !== 'string')) {
        throw new CommandError('Specify the screen name and its file.')
      }
      return this.services.canvas.setScreen(caller, {
        name,
        ...(typeof file === 'string' && { file }),
        ...(typeof canvas === 'string' && { canvas }),
        ...(typeof device === 'string' && { device }),
        ...(typeof size === 'string' && { size })
      })
    },

    canvasScreenGrid: (caller, { name, parts, columns, rows, visible, canvas }) => {
      if (typeof name !== 'string' || !name.trim()) {
        throw new CommandError('Specify the name of the screen.')
      }
      const whole = (value: unknown) =>
        value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      if (!whole(parts) || !whole(columns) || !whole(rows)) {
        throw new CommandError('The number of parts must be a whole positive number.')
      }
      if (visible !== undefined && typeof visible !== 'boolean') {
        throw new CommandError('Invalid grid visibility.')
      }
      return this.services.canvas.setGridForAgent(targetOf(caller, canvas), name, {
        ...(parts !== undefined && { parts }),
        ...(columns !== undefined && { columns }),
        ...(rows !== undefined && { rows }),
        ...(visible !== undefined && { visible })
      })
    },

    canvasScreenPreview: (caller, { name, canvas }) => {
      if (typeof name !== 'string' || !name.trim()) {
        throw new CommandError('Specify the name of the screen to preview.')
      }
      return this.services.canvas.previewScreen(targetOf(caller, canvas), name)
    },

    canvasArrange: (caller, { rows, canvas }) => {
      if (
        !Array.isArray(rows) ||
        rows.length === 0 ||
        !rows.every((row) => Array.isArray(row) && row.every((name) => typeof name === 'string'))
      ) {
        throw new CommandError('Specify the rows: a list of screen names for each row.')
      }
      return this.services.canvas.arrangeScreens(targetOf(caller, canvas), rows)
    },

    canvasLinkSet: (caller, { from, to, on, canvas }) => {
      if (typeof from !== 'string' || typeof to !== 'string' || !from.trim() || !to.trim()) {
        throw new CommandError('Specify the names of the two screens.')
      }
      return this.services.canvas.setLink(targetOf(caller, canvas), {
        from,
        to,
        ...(typeof on === 'string' && { on })
      })
    },

    canvasLinkRemove: (caller, { from, to, on, canvas }) => {
      if (typeof from !== 'string' || typeof to !== 'string' || !from.trim() || !to.trim()) {
        throw new CommandError('Specify the names of the two screens.')
      }
      return {
        removed: this.services.canvas.removeLink(
          targetOf(caller, canvas),
          from,
          to,
          typeof on === 'string' ? on : undefined
        )
      }
    },

    canvasGroupSet: (caller, { name, screens, canvas }) => {
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        !Array.isArray(screens) ||
        !screens.every((screen) => typeof screen === 'string')
      ) {
        throw new CommandError('Specify the group name and the names of its screens.')
      }
      return this.services.canvas.setGroup(targetOf(caller, canvas), name, screens)
    },

    canvasGroupRemove: (caller, { name, canvas }) => {
      if (typeof name !== 'string' || !name.trim()) {
        throw new CommandError('Specify the name of the group to remove.')
      }
      return { name: this.services.canvas.removeGroup(targetOf(caller, canvas), name) }
    },

    canvasShare: async (caller, { canvas }) => {
      const { url } = await this.services.canvas.shareForAgent(targetOf(caller, canvas))
      return { url }
    },

    canvasShareStop: async (caller, { canvas }) => {
      await this.services.canvas.unshareForAgent(targetOf(caller, canvas))
      return {}
    },

    canvasExport: async (caller, { format, screens, out, canvas }) => {
      if (typeof format !== 'string') {
        throw new CommandError('Specify the format: pdf, png or pptx.')
      }
      if (
        screens !== undefined &&
        !(Array.isArray(screens) && screens.every((name) => typeof name === 'string'))
      ) {
        throw new CommandError('The screens must be a list of names.')
      }
      const result = await this.services.canvas.exportForAgent(targetOf(caller, canvas), {
        format,
        ...(screens !== undefined && { screens }),
        ...(typeof out === 'string' && { out })
      })
      return { ...result, format }
    },

    canvasScreenRemove: async (caller, { name, canvas }) => {
      if (typeof name !== 'string' || !name.trim()) {
        throw new CommandError('Specify the name of the screen to remove.')
      }
      return { screen: await this.services.canvas.removeScreen(targetOf(caller, canvas), name) }
    },

    workers: (caller) =>
      this.workersOf(caller).map((chat) => ({
        chatId: chat.id,
        title: chat.title,
        agent: chat.agent,
        ...(chat.model && { model: chat.model }),
        ...(chat.effort && { effort: chat.effort }),
        running: this.services.conversations.isRunning(chat.id),
        reported: this.reportedChatIds.has(chat.id),
        startedAt: chat.createdAt
      }))
  }

  private async installedAgent(agent: string): Promise<AgentId> {
    const installed = await this.services.agents.list()
    if (!isAgentId(agent) || !installed.includes(agent)) {
      const available = installed.join(', ') || 'none'
      throw new CommandError(`Agent "${agent}" is not installed. Available agents: ${available}.`)
    }
    return agent
  }

  private async catalog(agent: AgentId): Promise<AgentCatalog> {
    const catalog = await this.services.conversations.catalog(agent)
    if (!catalog) {
      throw new CommandError(
        `Could not get the models of ${findAgent(agent)?.name ?? agent}. Make sure you are signed in to it.`
      )
    }
    return catalog
  }

  /**
   * Модель и эффорт помощника. Без явных значений — те, с которыми пользователь начинает
   * новые чаты. Названная модель или эффорт проверяются по списку агента: опечатка должна
   * вернуться агенту ошибкой, а не сломать помощника на первом сообщении.
   */
  private async workerSelection(
    agent: AgentId,
    model: string | undefined,
    effort: string | undefined
  ): Promise<Partial<ModelSelection>> {
    const remembered = this.services.modelSelection(agent)
    if (!model && !effort) {
      return remembered
    }
    const catalog = await this.catalog(agent)
    const listCommand = `atox models ${agent}`
    const modelId = model ?? remembered.model ?? catalog.defaultModel
    const chosen = catalog.models.find(
      ({ id, name }) => id === modelId || name.toLowerCase() === modelId.toLowerCase()
    )
    if (!chosen) {
      throw new CommandError(`Model "${modelId}" is not available. See: ${listCommand}`)
    }
    // Эффорт, запомненный для другой модели, к выбранной может не подойти.
    const effortLevel = effort ?? (model ? undefined : remembered.effort)
    if (effortLevel && !chosen.efforts.includes(effortLevel)) {
      const supported = chosen.efforts.join(', ')
      throw new CommandError(
        supported
          ? `Model "${chosen.id}" does not support effort "${effortLevel}". Supported: ${supported}.`
          : `Model "${chosen.id}" has no effort levels.`
      )
    }
    return { model: chosen.id, ...(effortLevel && { effort: effortLevel }) }
  }

  private workersOf({ project, chat }: ChatLocation): Chat[] {
    return project.chats.filter((other) => workerParentId(other) === chat.id)
  }

  /** Помощник вызывающего агента: удалять и прерывать можно только своих. */
  private ownWorker(caller: ChatLocation, id: string, action: 'remove' | 'interrupt'): Chat {
    const worker = this.services.store.findChat(id)?.chat
    if (!worker) {
      throw new CommandError(`Chat ${id} not found.`)
    }
    if (workerParentId(worker) !== caller.chat.id) {
      throw new CommandError(
        `Chat ${id} is not your worker. You can only ${action} your own workers.`
      )
    }
    return worker
  }

  /** Писать можно только своему агенту-родителю или своим помощникам. */
  private resolveRecipient(sender: Chat, to: string): Chat {
    const toParent = to === PARENT_ADDRESS
    const targetId = toParent ? workerParentId(sender) : to
    if (!targetId) {
      throw new CommandError('This chat has no parent agent.')
    }
    const target = this.recipient(targetId, toParent ? 'The parent chat' : `Chat ${to}`)
    if (target.id !== workerParentId(sender) && workerParentId(target) !== sender.id) {
      throw new CommandError('You can only message your parent agent or your own workers.')
    }
    return target
  }

  /**
   * Чат, которому можно написать. Архивный или удалённый чат сообщений не получит: агент
   * узнаёт об этом из ответа команды, а не теряет сообщение молча.
   */
  private recipient(chatId: string, description: string): Chat {
    const chat = this.services.store.findChat(chatId)?.chat
    if (chat) {
      return chat
    }
    if (this.services.store.findArchivedChat(chatId)) {
      throw new CommandError(`${description} is archived, so it cannot receive messages.`)
    }
    throw new CommandError(`${description} was not found.`)
  }

  /**
   * Ставит текст в очередь агенту чата: он получит его, как только закончит текущую работу.
   * Команда отвечает, только когда сообщение принято, — иначе ошибкой.
   */
  private async deliver(chat: Chat, text: string, { now = false } = {}): Promise<void> {
    try {
      await this.services.conversations.send(chat.id, text, {}, { now })
    } catch (error) {
      console.error('Failed to deliver an agent message', error)
      throw new CommandError(
        `Could not deliver the message to "${chat.title}": ${errorMessage(error)}`
      )
    }
  }
}

function parseRequest(line: string): OrchestrationRequest {
  try {
    const request = JSON.parse(line) as OrchestrationRequest
    if (typeof request.token === 'string' && typeof request.chatId === 'string') {
      return { ...request, params: request.params ?? {} }
    }
  } catch {
    // Ниже — общий ответ на любую нечитаемую строку.
  }
  throw new CommandError('Malformed request.')
}
