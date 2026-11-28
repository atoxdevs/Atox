/**
 * Команда `atox` для агентов в терминалах Atox: запустить помощника в соседнем чате,
 * написать ему или своему агенту, отчитаться о работе, показать экраны на холсте чата.
 * Запускается бинарником Electron
 * в режиме Node и передаёт команду приложению через его локальный сокет.
 */
import { createConnection } from 'node:net'
import { resolve } from 'node:path'
import { SCREEN_DEVICES, SCREEN_GRID_PARTS, describeScreenGrid } from '../shared/canvas'
import {
  OrchestrationEnv,
  PARENT_ADDRESS,
  type CanvasScreenGridInfo,
  type OrchestrationMethod,
  type OrchestrationMethods,
  type OrchestrationResponse
} from '../shared/orchestration'

const DEVICE_IDS = Object.keys(SCREEN_DEVICES).join('|')

const USAGE = `Usage: atox <command>

Delegate work to another agent in a new Atox chat in the same folder.

  atox agents                              List installed agents
  atox models <agent>                      List the agent's models and their effort levels
  atox start <agent> [--title <name>] [--model <id>] [--effort <level>] <task>
                                           Start a worker agent with a task; its report
                                           arrives in your chat as a new message.
                                           Without --model/--effort the worker uses the
                                           user's model for new chats.
                                           Pass "-" as the task to read it from stdin.
  atox workers                             List your workers
  atox send <chat-id|${PARENT_ADDRESS}> <message>     Message one of your workers, or your parent
                                           agent; it is read when the current turn ends
  atox send --now <chat-id> <message>      Interrupt the worker's current turn and give it the
                                           message right away (also --interrupt)
  atox interrupt <chat-id>                 Stop the worker's current turn; its chat and context
                                           stay, and your next atox send continues it
  atox remove <chat-id> [<chat-id>...]     Stop workers and remove their chats
  atox report <summary>                    Worker: report the result to the parent agent

Show screens (app, website, desktop UI) to the user on this chat's canvas.

  atox canvas                              Show this chat's canvas: its pages and their screens
  atox canvas new "<name>"                 Add another page to this chat's canvas (for a separate
                                           presentation, document or flow). Then pass
                                           --page "<name>" to every canvas command: it is
                                           required when the canvas has more than one page.
  atox canvas screen set <name> <file.tsx|.jsx|.html> [--device ${DEVICE_IDS}] [--size WxH]
                                           Put a React component (default export) or an HTML
                                           file on the canvas as a screen, or update the screen
                                           with that name. Then just edit the files: the canvas
                                           rebuilds by itself. Prints build errors, runtime
                                           errors and layout problems.
  atox canvas screen set <name> --size WxH | --device <device>
                                           Resize an existing screen; its file stays the same
  atox canvas screen grid <name> [--parts N | --columns N --rows M] [--on | --off]
                                           Show or set the user's grid over a screen: it splits
                                           the screen into N equal parts (N = 2, 4, 8, 16, 32)
                                           with a highlighted centre cross. It is an alignment
                                           overlay on the canvas, never part of the page. When
                                           it is on, align blocks to its lines.
  atox canvas screen preview <name>        Render the screen to a PNG and print its path, so you
                                           can open the image and check your work. Also reports
                                           build errors, runtime errors and content that does
                                           not fit the screen.
  atox canvas screen remove <name>         Remove a screen from the canvas (the file stays)
  atox canvas arrange "<A>,<B>,<C>" "<D>,<E>" ...
                                           Lay the screens out in rows: each argument is one row
                                           (screen names, left to right), rows go top to bottom.
                                           Screens you do not name go in a last row. Use it to
                                           group flows: one flow per row, so the canvas reads at
                                           a glance. The user can still drag screens afterwards.
  atox canvas group "<group name>" "<screen>" "<screen>" ...
                                           Put screens in a named frame (like "Onboarding" or
                                           "Settings") so the user finds them at a glance. Run
                                           arrange first so the group's screens stand together
                                           in one row. A screen is in one group; the same name
                                           again replaces the group's screens.
  atox canvas group remove "<group name>"  Remove the frame; the screens stay
  atox canvas link <from> <to> [--on "Sign in"]
                                           Draw a line from one screen to another so the user
                                           sees what follows what: it starts with a dot on the
                                           "from" screen and ends at the "to" screen. --on starts
                                           it at a button of the "from" screen (its text or a CSS
                                           selector); without it the line starts at the screen.
  atox canvas link remove <from> <to> [--on "Sign in"]
                                           Remove the lines between two screens (or only the one
                                           that starts at that button)
  atox canvas share                        Publish the canvas as a web page the user can send to a
                                           client: it opens in any browser, also on a phone, for
                                           viewing only. Prints the link. Run it again to update the
                                           page after changes; the link stays the same.
  atox canvas share stop                   Close the link
  atox canvas export <pdf|png|pptx> [--screens "Name,Name"] [--out <path>]
                                           Export the screens to a file for the user to send or
                                           print: pdf (one page per screen, real text), pptx
                                           (one slide per screen, as images) or png (a folder
                                           of images). Pages go in canvas order: rows top to
                                           bottom, left to right. Default: the Downloads folder.

Works only for agents running in Atox chats.`

/** Сколько ждать ответа приложения: команды выполняются сразу и не ждут работы агентов. */
const RESPONSE_TIMEOUT_MS = 30_000

class UsageError extends Error {}

async function main(args: string[]): Promise<string> {
  const [command, ...rest] = args
  switch (command) {
    case 'agents': {
      const agents = await call('agents', {})
      return agents.length > 0
        ? agents.map(({ id, name }) => `${id}\t${name}`).join('\n')
        : 'No agents are installed.'
    }
    case 'models': {
      const [agent] = rest
      if (!agent) {
        throw new UsageError('Specify the agent, for example: atox models claude')
      }
      const { defaultModel, models } = await call('models', { agent })
      return models
        .map(({ id, name, efforts, defaultEffort }) => {
          const marks = id === defaultModel ? ' (default)' : ''
          const levels = efforts
            .map((level) => (level === defaultEffort ? `${level}*` : level))
            .join(', ')
          return `${id}\t${name}${marks}\t${levels ? `effort: ${levels}` : 'no effort levels'}`
        })
        .join('\n')
    }
    case 'start': {
      const { values, positional } = parseFlags(rest, ['title', 'model', 'effort'])
      const [agent, ...taskWords] = positional
      if (!agent) {
        throw new UsageError('Specify the agent, for example: atox start claude "<task>"')
      }
      const task = await readText(taskWords, 'task')
      const worker = await call('start', {
        agent,
        task,
        title: values['title'],
        model: values['model'],
        effort: values['effort']
      })
      return `Started worker "${worker.title}" (chat ${worker.chatId}${describeModel(worker)}). Its report will arrive in this chat as a new message; you can keep working meanwhile.`
    }
    case 'workers': {
      const workers = await call('workers', {})
      return workers.length > 0
        ? workers
            .map((worker) => {
              const { chatId, title, agent, running, reported, startedAt } = worker
              const state = reported ? 'reported' : running ? 'working' : 'stopped'
              return `${chatId}\t${agent}${describeModel(worker)}\t${state}\tstarted ${formatAge(startedAt)}\t${title}`
            })
            .join('\n')
        : 'You have no workers.'
    }
    case 'send': {
      // Флаг — только перед адресатом: в тексте сообщения «--now» остаётся текстом.
      let now = false
      while (rest[0] === '--now' || rest[0] === '--interrupt') {
        now = true
        rest.shift()
      }
      const [to, ...messageWords] = rest
      if (!to) {
        throw new UsageError(
          now
            ? 'Specify the worker chat id (see atox workers).'
            : `Specify the recipient: a worker chat id or "${PARENT_ADDRESS}".`
        )
      }
      const message = await readText(messageWords, 'message')
      if (!now) {
        await call('send', { to, message })
        return 'Message sent. The agent gets it as soon as it can take input.'
      }
      const { interrupted } = await call('send', { to, message, now: true })
      return interrupted
        ? 'Interrupted the worker\'s turn. It starts on your message right away.'
        : 'The worker was not working, so nothing was interrupted. ' +
            'It starts on your message right away.'
    }
    case 'interrupt': {
      const [chatId, ...extra] = rest
      if (!chatId || extra.length > 0) {
        throw new UsageError('Specify one worker chat id to interrupt (see atox workers).')
      }
      const { interrupted, queued } = await call('interrupt', { chatId })
      if (!interrupted) {
        return `Worker ${chatId} is not working, so there was nothing to interrupt.`
      }
      const messages = queued === 1 ? '1 queued message' : `${queued} queued messages`
      const next =
        queued > 0
          ? ` It has ${messages} and starts on the next one now.`
          : ' Its chat and context stay; send it a message with atox send to continue.'
      return `Interrupted worker ${chatId}.${next}`
    }
    case 'remove': {
      if (rest.length === 0) {
        throw new UsageError('Specify the chat ids of the workers to remove (see atox workers).')
      }
      const { removed } = await call('remove', { chatIds: rest })
      return removed.length === 1
        ? `Removed worker ${removed[0]}.`
        : `Removed ${removed.length} workers: ${removed.join(', ')}.`
    }
    case 'report': {
      await call('report', { summary: await readText(rest, 'summary') })
      return 'Report sent to the parent agent. Your task is complete; stop here.'
    }
    case 'canvas':
      return canvas(rest)
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return USAGE
    default:
      throw new UsageError(`Unknown command: ${command}\n\n${USAGE}`)
  }
}

const CANVAS_SET_COMMAND = 'atox canvas screen set <name> <file.tsx> [--device <device>]'

const CANVAS_SET_USAGE = `Usage: ${CANVAS_SET_COMMAND} [--size WxH], or atox canvas screen set <name> --size WxH to resize. Quote names with spaces.`

const CANVAS_GRID_USAGE =
  'Usage: atox canvas screen grid <name> [--parts N | --columns N --rows M] [--on | --off]'

/** Как выравнивать блоки по включённой сетке — подсказка агенту. */
const GRID_ALIGN_HINT =
  'Align block edges and centres to the part lines (k/N of the width and height) and centre content on the cross.'

/** «grid on: 4 × 4 equal parts» — сетка экрана одной строкой. */
function describeGrid(grid: CanvasScreenGridInfo): string {
  return `grid ${grid.visible ? 'on' : 'off'}: ${describeScreenGrid(grid)}`
}

/** Сетка экрана подробно: текущая, где её линии и какие числа частей верные. */
function describeGridDetails(name: string, width: number, height: number, grid: CanvasScreenGridInfo): string {
  const step = (side: number, parts: number) => `${Number((side / parts).toFixed(2))}px`
  const lines = [
    `Screen "${name}", ${width}x${height}, ${describeGrid(grid)} (each part ${step(width, grid.columns)} × ${step(height, grid.rows)}; centre cross at ${width / 2}px, ${height / 2}px).`
  ]
  if (grid.visible) {
    lines.push(`The user aligns the design to this grid. ${GRID_ALIGN_HINT}`)
  }
  lines.push(
    `Valid numbers of equal parts for --parts, --columns and --rows: ${SCREEN_GRID_PARTS.join(', ')}.`
  )
  return lines.join('\n')
}

interface ScreenProblems {
  buildError: string | null
  runtimeErrors: string[]
  layout: string[]
}

/** Что не так с экраном, словами: агент правит файлы по этим строкам. */
function describeProblems({ buildError, runtimeErrors, layout }: ScreenProblems): string[] {
  const section = (title: string, lines: string[]) =>
    lines.length > 0 ? [title, ...lines.map((line) => `- ${line}`)] : []
  return [
    ...(buildError
      ? [
          `Build failed: ${buildError}`,
          'The canvas keeps the last version that built. Fix the file; it rebuilds by itself.'
        ]
      : []),
    ...section('Errors in the running screen (fix them):', runtimeErrors),
    ...section('Layout problems (fix them in the screen):', layout)
  ]
}

/** `atox canvas …`: холст чата и его экраны. */
async function canvas(rawArgs: string[]): Promise<string> {
  // `--page "<name>"` (или прежнее `--canvas`) стоит где угодно и выбирает страницу холста
  // чата; без него — единственная страница.
  const { values: flags, positional: args } = parseFlags(rawArgs, ['page', 'canvas'])
  const page = flags['page'] ?? flags['canvas']
  const target = page !== undefined ? { canvas: page } : {}
  const [group, action, ...rest] = args
  if (group === undefined) {
    const canvases = await call('canvas', target)
    if (canvases.length === 0) {
      return `This chat has no canvas yet. Add a screen with: ${CANVAS_SET_COMMAND}`
    }
    return canvases
      .map((shown) => {
        const count = shown.screens.length === 1 ? '1 screen' : `${shown.screens.length} screens`
        const lines = shown.screens.map(
          ({ name, device, width, height, file, missing, buildError, grid }) =>
            `${name}\t${device} ${width}x${height}\t${describeGrid(grid)}\t${file}${missing ? '\tfile missing' : ''}${buildError ? `\tbuild failed: ${buildError}` : ''}`
        )
        const arrows = shown.links.map(
          ({ from, to, on }) => `${from} -> ${to}${on ? `\tfrom "${on}"` : ''}`
        )
        const groups = shown.groups.map(
          ({ name, screens }) => `${name}\t${screens.map((screen) => `"${screen}"`).join(', ')}`
        )
        return [
          `Page "${shown.name}", ${count}. Edit a screen's file and the canvas updates by itself.`,
          ...lines,
          ...(shown.share ? [`Shared as a web page: ${shown.share}`] : []),
          ...(groups.length > 0 ? ['Groups:', ...groups] : []),
          ...(arrows.length > 0 ? ['Lines:', ...arrows] : [])
        ].join('\n')
      })
      .join('\n\n')
  }
  if (group === 'new') {
    const name = [action, ...rest].filter((part) => part !== undefined).join(' ')
    if (!name.trim()) {
      throw new UsageError('Usage: atox canvas new "<name>"')
    }
    const result = await call('canvasNew', { name })
    return result.created
      ? `Added the page "${result.canvas}" to the canvas. Put screens on it with --page "${result.canvas}", e.g. atox canvas screen set <name> <file.tsx> --page "${result.canvas}".`
      : `The page "${result.canvas}" already exists; use --page "${result.canvas}".`
  }
  if (group === 'screen' && action === 'set') {
    const { values, positional } = parseFlags(rest, ['device', 'size'])
    const [name, file] = positional
    const resizing = values['device'] !== undefined || values['size'] !== undefined
    if (!name || (!file && !resizing) || positional.length > 2) {
      throw new UsageError(CANVAS_SET_USAGE)
    }
    const result = await call('canvasScreenSet', {
      ...target,
      name,
      // Путь считается от папки, в которой агент запустил команду.
      ...(file !== undefined && { file: resolve(file) }),
      ...(values['device'] !== undefined && { device: values['device'] }),
      ...(values['size'] !== undefined && { size: values['size'] })
    })
    const look = `${result.device}, ${result.width}x${result.height}`
    const done = result.created
      ? `Added the screen "${result.screen}" (${look}) to the page "${result.canvas}". The user sees it now.`
      : `Updated the screen "${result.screen}" (${look}) on the page "${result.canvas}".`
    return [
      [
        ...(result.canvasCreated ? [`Created the canvas with the page "${result.canvas}" for this chat.`] : []),
        done,
        `From now on just edit ${result.file} (and the files it imports): the canvas updates by itself. Run this command again only to change the device or size.`
      ].join(' '),
      ...(result.grid.visible
        ? [`The user's grid is on: ${describeScreenGrid(result.grid)}. ${GRID_ALIGN_HINT}`]
        : []),
      ...describeProblems(result)
    ].join('\n')
  }
  if (group === 'screen' && action === 'grid') {
    const switches = rest.filter((part) => part === '--on' || part === '--off')
    const { values, positional } = parseFlags(
      rest.filter((part) => part !== '--on' && part !== '--off'),
      ['parts', 'columns', 'rows']
    )
    const [name] = positional
    if (!name || positional.length > 1 || switches.length > 1) {
      throw new UsageError(CANVAS_GRID_USAGE)
    }
    const whole = (flag: string): number | undefined => {
      const raw = values[flag]
      if (raw === undefined) {
        return undefined
      }
      const number = Number(raw)
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw new UsageError(
          `--${flag} must be one of ${SCREEN_GRID_PARTS.join(', ')} (the number of equal parts).`
        )
      }
      return number
    }
    const parts = whole('parts')
    const columns = whole('columns')
    const rows = whole('rows')
    const result = await call('canvasScreenGrid', {
      ...target,
      name,
      ...(parts !== undefined && { parts }),
      ...(columns !== undefined && { columns }),
      ...(rows !== undefined && { rows }),
      ...(switches[0] !== undefined && { visible: switches[0] === '--on' })
    })
    return describeGridDetails(result.screen, result.width, result.height, result.grid)
  }
  if (group === 'screen' && action === 'preview') {
    const name = rest.join(' ')
    if (!name.trim()) {
      throw new UsageError('Usage: atox canvas screen preview <name>')
    }
    const preview = await call('canvasScreenPreview', { ...target, name })
    return [`Screenshot of "${preview.screen}": ${preview.path}`, ...describeProblems(preview)].join(
      '\n'
    )
  }
  if (group === 'screen' && action === 'remove') {
    const name = rest.join(' ')
    if (!name.trim()) {
      throw new UsageError('Usage: atox canvas screen remove <name>')
    }
    const { screen } = await call('canvasScreenRemove', { ...target, name })
    return `Removed the screen "${screen}" from the canvas. Its file stays in the project.`
  }
  if (group === 'arrange') {
    const rows = [action, ...rest]
      .filter((part) => part !== undefined)
      .map((row) =>
        row
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
      )
      .filter((row) => row.length > 0)
    if (rows.length === 0) {
      throw new UsageError('Usage: atox canvas arrange "<A>,<B>,<C>" "<D>,<E>" ...')
    }
    const result = await call('canvasArrange', { ...target, rows })
    return [
      `Arranged ${result.screens === 1 ? '1 screen' : `${result.screens} screens`} in ${result.rows === 1 ? '1 row' : `${result.rows} rows`}.`,
      ...(result.rest.length > 0
        ? [`Not named, put in the last row: ${result.rest.map((name) => `"${name}"`).join(', ')}.`]
        : [])
    ].join('\n')
  }
  if (group === 'group') {
    const removing = action === 'remove'
    const [name, ...screens] = (removing ? rest : [action, ...rest]).filter(
      (part): part is string => part !== undefined
    )
    if (!name || (removing ? screens.length > 0 : screens.length === 0)) {
      throw new UsageError(
        removing
          ? 'Usage: atox canvas group remove "<group name>"'
          : 'Usage: atox canvas group "<group name>" "<screen>" "<screen>" ...'
      )
    }
    if (removing) {
      const result = await call('canvasGroupRemove', { ...target, name })
      return `Removed the group "${result.name}". Its screens stay on the canvas.`
    }
    const result = await call('canvasGroupSet', { ...target, name, screens })
    return `${result.created ? 'Created' : 'Updated'} the group "${result.name}" with ${result.screens.length === 1 ? '1 screen' : `${result.screens.length} screens`}.`
  }
  if (group === 'link') {
    const removing = action === 'remove'
    const { values, positional } = parseFlags(
      removing ? rest : [action, ...rest].filter((part) => part !== undefined),
      ['on']
    )
    const [from, to] = positional
    if (!from || !to || positional.length > 2) {
      throw new UsageError(
        removing
          ? 'Usage: atox canvas link remove <from> <to> [--on "Sign in"]'
          : 'Usage: atox canvas link <from> <to> [--on "Sign in"]'
      )
    }
    if (removing) {
      const { removed } = await call('canvasLinkRemove', {
        ...target,
        from,
        to,
        ...(values['on'] !== undefined && { on: values['on'] })
      })
      return removed === 0
        ? `There was no line from "${from}" to "${to}".`
        : `Removed ${removed === 1 ? '1 line' : `${removed} lines`} from "${from}" to "${to}".`
    }
    const result = await call('canvasLinkSet', {
      ...target,
      from,
      to,
      ...(values['on'] !== undefined && { on: values['on'] })
    })
    const route = `"${result.from}" -> "${result.to}"`
    return [
      `${result.created ? 'Added' : 'There already was'} the line ${route}${result.on ? ` from "${result.on}"` : ''}.`,
      ...(result.elementMissing
        ? [
            `Warning: no visible element "${result.on}" on "${result.from}", so the line starts at the screen. Use the exact text of the button or a CSS selector, and run the command again.`
          ]
        : [])
    ].join('\n')
  }
  if (group === 'share') {
    if (action === 'stop') {
      await call('canvasShareStop', target)
      return 'The link is closed. The page no longer opens.'
    }
    if (action !== undefined || rest.length > 0) {
      throw new UsageError('Usage: atox canvas share [stop]')
    }
    const { url } = await call('canvasShare', target)
    return `The canvas is published: ${url}\nGive this link to the user. It shows a snapshot (view only); run the command again after changes to update it.`
  }
  if (group === 'export') {
    const { values, positional } = parseFlags([action, ...rest].filter((part) => part !== undefined), [
      'screens',
      'out'
    ])
    const [format] = positional
    if (!format || positional.length > 1) {
      throw new UsageError('Usage: atox canvas export <pdf|png|pptx> [--screens "Name,Name"] [--out <path>]')
    }
    const names = values['screens']
      ?.split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    const result = await call('canvasExport', {
      ...target,
      format,
      ...(names && names.length > 0 && { screens: names }),
      // Путь считается от папки, в которой агент запустил команду.
      ...(values['out'] !== undefined && { out: resolve(values['out']) })
    })
    const count = result.screens === 1 ? '1 screen' : `${result.screens} screens`
    const what = result.format === 'png' ? 'folder' : 'file'
    return [
      `Exported ${count} as ${result.format.toUpperCase()}: ${result.path}`,
      `Tell the user where the ${what} is; Atox does not open it.`,
      ...result.warnings.map((warning) => `Warning: ${warning}`)
    ].join('\n')
  }
  throw new UsageError(`Unknown canvas command.\n\n${USAGE}`)
}

/** «, opus, high» — модель и эффорт помощника, если они заданы. */
function describeModel({ model, effort }: { model?: string; effort?: string }): string {
  return [model, effort].map((part) => (part ? `, ${part}` : '')).join('')
}

/** Сколько времени прошло с момента: «just now», «5m ago», «2h ago», «3d ago». */
function formatAge(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** Значения флагов `--name value` и остальные аргументы по порядку. */
function parseFlags(
  args: string[],
  names: string[]
): { values: Record<string, string>; positional: string[] } {
  const values: Record<string, string> = {}
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!.replace(/^--/, '')
    if (args[index]!.startsWith('--') && names.includes(name)) {
      const value = args[++index]
      if (value === undefined) {
        throw new UsageError(`--${name} needs a value.`)
      }
      values[name] = value
    } else {
      positional.push(args[index]!)
    }
  }
  return { values, positional }
}

/**
 * Текст из аргументов; «-» — читать stdin. Без явного «-» stdin не читается: у инструментов
 * агентов он бывает открытым каналом, который никогда не закроется.
 */
async function readText(words: string[], name: string): Promise<string> {
  const fromStdin = words.length === 1 && words[0] === '-'
  const text = fromStdin ? await readStdin() : words.join(' ')
  if (!text.trim()) {
    throw new UsageError(`The ${name} is empty.`)
  }
  return text
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function call<Method extends OrchestrationMethod>(
  method: Method,
  params: OrchestrationMethods[Method]['params']
): Promise<OrchestrationMethods[Method]['result']> {
  const socketPath = process.env[OrchestrationEnv.Socket]
  const token = process.env[OrchestrationEnv.Token]
  const chatId = process.env[OrchestrationEnv.ChatId]
  if (!socketPath || !token || !chatId) {
    return Promise.reject(
      new Error('atox works only for agents running in Atox chats.')
    )
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(RESPONSE_TIMEOUT_MS, () => {
      socket.destroy()
      reject(new Error('Atox did not respond. Make sure the app is running.'))
    })
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ token, chatId, method, params })}\n`)
    )
    socket.on('data', (chunk: string) => (response += chunk))
    socket.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        new Error(
          error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
            ? 'Atox is not running.'
            : `Could not connect to Atox (${error.code ?? error.message}). If a sandbox blocks it, run the command again with elevated permissions.`
        )
      )
    )
    socket.on('end', () => {
      try {
        const parsed = JSON.parse(response) as OrchestrationResponse<Method>
        if (parsed.ok) {
          resolve(parsed.result)
        } else {
          reject(new Error(parsed.error))
        }
      } catch {
        reject(new Error('Atox returned an invalid response.'))
      }
    })
  })
}

main(process.argv.slice(2)).then(
  (output) => {
    process.stdout.write(`${output}\n`)
  },
  (error: unknown) => {
    process.stderr.write(`atox: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = error instanceof UsageError ? 2 : 1
  }
)
