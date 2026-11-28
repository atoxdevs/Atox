import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SCREEN_DEVICE, SCREEN_DEVICES, SCREEN_SIZE } from '../../shared/canvas'
import { CANVAS_KIT_EXAMPLES, CANVAS_KIT_GUIDE } from '../../shared/canvasRuntime'
import { CANVAS_MESSAGE_PREFIX, SCREEN_FILE_MAX_MB } from '../canvas/rules'
import { quoteShell } from '../shellQuote'

/** Права исполняемого файла команды. */
const EXECUTABLE = 0o755

/**
 * Создаёт исполняемый файл `atox` в `binDirectory`: он запускает собранную команду бинарником
 * приложения в режиме Node, так что отдельный Node.js пользователю не нужен. Файл
 * пересоздаётся при каждом запуске: путь к приложению мог измениться после обновления.
 */
export async function installCli(
  binDirectory: string,
  executablePath: string,
  scriptPath: string
): Promise<string> {
  // На Windows команда — `.cmd`: он находится по имени `atox`, как и программа без расширения.
  const windows = process.platform === 'win32'
  const cliPath = join(binDirectory, windows ? 'atox.cmd' : 'atox')
  const content = windows
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${executablePath}" "${scriptPath}" %*\r\n`
    : `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec ${quoteShell(executablePath)} ${quoteShell(scriptPath)} "$@"
`
  await mkdir(binDirectory, { recursive: true })
  await writeFile(cliPath, content, { mode: EXECUTABLE })
  return cliPath
}

const SKILL = `---
name: atox
description: Delegate work to other coding agents (Claude Code, Codex) that run in parallel Atox chats, and talk to them. Use inside Atox (the ATOX_CHAT_ID environment variable is set) when the user asks to hand a task to another agent, run agents in parallel, or get a second opinion from Codex or Claude; also use it when you are an Atox worker that must report back.
---

# Atox agents

Inside Atox every chat is a conversation with a coding agent (Claude Code or Codex). The \`atox\` command starts another agent in a new chat in the same folder; the user sees it nested under your chat. Its report comes back to your chat as a new message starting with "[Atox] Worker".

## Commands

\`\`\`sh
atox agents                                  # installed agents; start only these
atox models claude                           # the agent's models: id, name, effort levels (* = default)
atox start claude --title "Fix checkout" "<task>"
atox start claude --model opus --effort high --title "Plan the migration" "<task>"
atox workers                                 # your workers, oldest first: id, agent and model, state, age, title
atox send <worker-chat-id> "<message>"       # follow-up or answer to a worker's question; read after its current turn
atox send --now <worker-chat-id> "<message>" # interrupt the worker's turn and give it the message right away
atox interrupt <worker-chat-id>              # stop the worker's current turn; chat and context stay
atox remove <worker-chat-id> [...]           # stop workers and remove their chats
atox send parent "<question>"                # worker: ask the agent that started you
atox report "<summary>"                      # worker: final result, exactly once
\`\`\`

## Starting workers

- Run \`atox agents\` first. If the agent the user asked for is not installed, say so and offer the installed ones instead.
- Make each task self-contained: the files in scope, the change to make, constraints, and how to verify it. The worker sees nothing of your conversation.
- Without \`--model\`/\`--effort\` a worker gets the model the user starts new chats with. Set them when the user asks for a model or effort, or when the task clearly calls for a stronger or cheaper one. Take the ids and levels from \`atox models <agent>\`; an unknown model or effort is rejected with the list to choose from.
- Workers share the folder with you and each other, so give them separate files or areas.
- After starting, keep working or end your turn. Do not poll or wait in a loop: the report arrives as a new message. Use \`atox workers\` only when the user asks for status.
- Workers cannot start workers of their own.

## Correcting and interrupting workers

- \`atox send\` queues the message: the worker reads it only after its current turn ends. If the correction cannot wait (wrong direction, wrong files, the user changed the task), use \`atox send --now <worker-chat-id> "<message>"\`: the worker's turn stops and it starts on your message right away, with its context intact.
- \`atox interrupt <worker-chat-id>\` only stops the current turn: the worker goes idle and keeps its chat and context; your next \`atox send\` continues it. Messages already queued for it are taken next. Interrupting an idle worker does nothing.
- Prefer these over \`atox remove\` for a correction: removing loses the worker's context. You can interrupt only your own workers.

## Removing workers

- Clean up after yourself: when a worker has reported and you have checked its result and need nothing more from it, remove it with \`atox remove <worker-chat-id>\` right away, without asking the user. Keep it only while you still plan to send it a follow-up.
- Also remove a worker you started by mistake, or one the user no longer needs. Removing stops the agent and deletes its chat; this cannot be undone.
- Remove a worker that is still working only when the user asks or the task was started by mistake: its unfinished work is lost.
- Take the ids from \`atox workers\`. You can remove only your own workers.

## As a worker

If your first message says you are a worker, do the task, then run \`atox report\` once with what you did, what you found, and what is left. Ask questions with \`atox send parent\`, not the user.

## Troubleshooting

- \`atox\` not found: run "$ATOX_CLI" with the same arguments.
- Blocked by a sandbox or permissions: run it again with elevated permissions; it only talks to the local Atox app.
`

/** Устройства холста с размерами — из того же списка, что проверяет команда. */
const CANVAS_DEVICES = Object.entries(SCREEN_DEVICES)
  .map(
    ([id, { name, width, height, category }]) =>
      `- \`${id}\`: ${name}, ${width}x${height} (${category})`
  )
  .join('\n')

const CANVAS_SKILL = `---
name: atox-canvas
description: Show UI designs, presentations and documents to the user on the Atox canvas as live React screens, and export them to PDF, PowerPoint or images. Use inside Atox (the ATOX_CHAT_ID environment variable is set) when the user asks to design, draw, show, mock up, prototype or preview screens, a UI, a page, a website, a dashboard, a landing page or an app screen, to make a presentation, slides, a commercial proposal, a report or a PDF, and whenever a message starts with "${CANVAS_MESSAGE_PREFIX}".
---

# Atox canvas

The canvas is a page in Atox where the user sees the screens of this chat side by side: phone app screens, website pages, desktop app windows, and also presentation slides and document pages. Each screen is a React component in a file of the project. Atox builds it, shows it in a device frame and watches the files: every time you edit the screen or a file it imports, the canvas rebuilds by itself. The user moves, renames and zooms screens; you only write the code.

Before you design, read \`kit.md\` in this skill's folder once (about 230 lines): the component kit (\`@atox/ui\`) reference and the design rules. Use the kit instead of building buttons, inputs and layouts from scratch. \`examples.md\` next to it has three full screens; open it only when you want a complete example. For a small change to a screen you already built you do not need to read them again. For a presentation, a commercial proposal or any document, also read section 8 of \`kit.md\` (slide and A4 sizes, type scale, page structure) and use the \`slide\` or \`a4\` device.

Quick reference (details and props are in \`kit.md\`):

- Phone: \`<Screen>\` with \`StatusBar\`, \`NavBar\`, \`ScrollArea\`, \`TabBar\`. Desktop app: \`<Screen className="flex-row">\` with \`Sidebar\` and a column of \`Topbar\` + \`ScrollArea\`. Website: \`<Screen layout="page">\` with \`SiteNav\`, \`Hero\`, \`FeatureGrid\`, \`Footer\`.
- Controls: \`Button\`, \`IconButton\`, \`Input\`, \`Field\`, \`Select\`, \`Switch\`, \`Checkbox\`, \`SegmentedControl\`, \`Tabs\`. Display: \`Card\`, \`Stat\`, \`Badge\`, \`Avatar\`, \`List\`/\`ListItem\`, \`Table\`, \`EmptyState\`, \`Alert\`. Charts: \`LineChart\`, \`BarChart\`, \`Donut\`, \`Sparkline\`.
- Colors: change the accent with \`<Screen accent="emerald">\` (indigo, blue, emerald, rose, amber, violet) and use the semantic classes (\`bg-accent\`, \`text-fg\`, \`bg-surface\`, \`border-border\`), not raw Tailwind colors like \`bg-green-600\`: raw colors break dark mode.

## Commands

\`\`\`sh
atox canvas                                                    # this chat's canvas: pages and their screens with device, size, grid, file and build status
atox canvas new "Pitch deck"                                   # one more page of the canvas (see "Several pages")
atox canvas screen set Login .atox/canvas/login.tsx --device iphone
atox canvas screen set "Admin dashboard" .atox/canvas/admin.tsx --device web
atox canvas screen set Widget .atox/canvas/widget.tsx --size 360x640
atox canvas screen set Widget --size 384x640                   # resize an existing screen; the file stays
atox canvas screen grid Login                                  # the user's grid over the screen: N equal parts and the size of one part
atox canvas screen grid Login --parts 8                        # split into 8 equal parts (2, 4, 8, 16, 32) and show it; --off hides it
atox canvas screen grid Login --columns 4 --rows 8             # a different number of parts across and down
atox canvas screen preview Login                               # PNG of the screen as the user sees it, plus problems
atox canvas screen remove Login                                # removes the screen; the files stay
atox canvas arrange "Login,Code,Sign up" "Feed,Post"          # rows of screens, left to right; rows top to bottom
atox canvas link Login Home --on "Sign in"                     # a line from the Sign in button of Login to the Home screen
atox canvas link Home Settings                                 # a line from the Home screen to Settings
atox canvas link remove Login Home                             # removes the lines between two screens
atox canvas export pdf                                         # all screens to a PDF (selectable text) in the Downloads folder
atox canvas export pdf --screens "Cover,Price" --out /abs/path/offer.pdf
atox canvas export pptx                                        # PowerPoint, one image slide per screen
atox canvas export png                                         # a folder of PNG images
\`\`\`

## Workflow

1. Write the screen as a .tsx file in the project, for example \`.atox/canvas/login.tsx\`, with a default-exported component: \`export default function Login() { ... }\`.
2. Put shared parts in their own files: \`.atox/canvas/components/*.tsx\`, sample data in \`.atox/canvas/data.ts\`. Import them with relative paths (\`./components/Card\`). Keep each file small. Run \`atox\` commands and name files with paths relative to the project root, and do not \`cd\` into \`.atox/canvas\`.
3. Put the screen on the canvas once: \`atox canvas screen set Login .atox/canvas/login.tsx --device iphone\`. The canvas is created for this chat if it has none. Run \`set\` again only to change the device or size, or to add another screen. Use one screen per file, and several screens for a flow (Login, Home, Settings).
4. Check your own work: run \`atox canvas screen preview <name>\` after the first draft and after bigger changes, open the PNG it prints, and fix whatever looks wrong (broken layout, overlaps, unreadable text, empty areas) before you tell the user it is done.
5. \`set\` and \`preview\` also report problems in plain text: "Build failed" (file:line and the error), "Errors in the running screen" (exceptions and console errors), and "Layout problems" such as "Content is 1240 px tall but the screen is 844 px: it is cut off." Fix them in the code. When the build fails, the canvas keeps the last version that built; \`atox canvas\` shows the build error of each screen.

Edit files with your editor tool, not with \`sed -i\` (on macOS it differs from GNU sed and fails). A command that printed an error changed nothing: do not assume the canvas shows the new version.

## Screen tools and the grid

The user double-clicks a screen on the canvas (or picks "Screen tools" in its context menu) to make it the working screen: a tools panel opens at the top right of the canvas, Escape closes it. In the panel the user changes the screen's size (width × height or a preset; this resizes the screen on the canvas, not your code) and turns on a Grid.

- The grid is the user's alignment guide, like a designer's layout guide. It is drawn by the canvas over the screen and is never part of the page: not in your file, not in previews, exports, share links or thumbnails. Never draw it yourself.
- It splits the screen into N equal parts across and M equal parts down (N and M are 2, 4, 8, 16 or 32; usually the same). Line k sits exactly at k/N of the width and k/M of the height, so 2 means halves, 4 quarters, 8 eighths. The parts are equal but not necessarily square, and any screen size has every grid. The centre cross (the lines at 1/2) is highlighted.
- \`atox canvas\` shows each screen's grid ("grid on: 4 × 4 equal parts" or "grid off: …"). When the grid is on, the user wants the design aligned to it: put block edges and centres on the part lines (at k/N of the width and k/M of the height; on a 1280px-wide screen with 8 parts: 160, 320, 480, 640 px …), make blocks span whole parts, and centre the main content on the cross. When it is off, design as usual.
- \`atox canvas screen grid <name>\` prints the grid and the size of one part; \`--parts N\` sets both axes, \`--columns N\` and \`--rows M\` set one axis each, and picking a number shows the grid; \`--on\`/\`--off\` shows or hides it. Any other number is rejected with the list of valid ones. Change the grid or the size only when the user asks or agrees: these are the user's tools.
- \`atox canvas screen set <name> --size WxH\` (or \`--device <id>\`) resizes an existing screen without changing its file. The grid keeps its number of parts, so its lines move with the new size.

## Arranging screens

New screens are added to the right of the last one, so a long list ends up as one long row. Group them yourself: after adding the screens, run \`atox canvas arrange "<row>" "<row>"\`. Each argument is one row of screen names separated by commas, left to right; rows go top to bottom; screens you do not name go in a last row. Put one flow or one area of the app per row (the main path first: "Login,Code,Sign up", then "Feed,Post,Payment", then "Author mode"). Do it again whenever you add a group of screens. This is your job, not the user's: do not tell the user to drag screens. Never edit the canvas data files.

## Grouping screens

When the canvas has many screens, put them in named groups so the user finds things at a glance: \`atox canvas group "<name>" "<screen>" "<screen>" ...\` draws a rounded frame with that name around those screens (like "Onboarding", "Settings", "Checkout"). Arrange first, one group per row, so the screens of a group stand together: a frame follows its screens and would otherwise cover the ones in between. A screen is in one group; running the command again with the same name replaces the group's screens; \`atox canvas group remove "<name>"\` removes the frame and keeps the screens. The user can rename a group, drag it with all its screens or ungroup it from its title bar, so use the name from \`atox canvas\`.

## Showing the flow

When screens follow each other (a user flow, onboarding, checkout), connect them with lines so the user sees what leads where: \`atox canvas link <from> <to> --on "<button text>"\`. A line starts with a dot at the button (or at the screen when you leave \`--on\` out) and ends at the target screen: the dot shows the direction. Use the exact visible text of the button, link or tab that causes the transition (or a CSS selector); if it is not found, the command warns and the line starts at the screen. Draw only real transitions, one line per button, and add the lines after the screens exist. The lines follow the buttons when the screens change. Lines carry no labels: name the screens well instead ("Login", "Home", "Order confirmed"). The user cannot edit lines; to change them, run \`link\` and \`link remove\`.

## Sharing with a client

When the user wants to show the canvas to someone (a client, a teammate), run \`atox canvas share\`: it publishes a snapshot as a web page and prints a link. The page opens in any browser, also on a phone, with pan and zoom, and is view only (no comments, no editing). Give the link to the user. After you change screens, run the command again: the page updates and the link stays the same. \`atox canvas share stop\` closes the link. The user can do the same with the Share button on the canvas.

## Several pages

A chat has one canvas, and the canvas can have several pages (like pages in Figma), for example the app screens and a separate presentation. The user adds and renames pages in the Pages panel on the canvas. Do not mix them: \`atox canvas new "<name>"\` adds a page, only when the user asks for it or the new work clearly does not belong on an existing page. When the canvas has several pages, every canvas command needs \`--page "<name>"\` (for example \`atox canvas screen set Cover .atox/canvas/cover.tsx --device slide --page "Pitch deck"\`); without it the command refuses and lists the names. With one page you can leave it out. The messages "[Atox canvas] On the canvas page ..." and "[Atox canvas] Fix the screen ..." name the page: pass that name. \`atox canvas share\` publishes all pages under one link.

## Presentations and documents

When the user asks for a presentation, slides, a commercial proposal, a report or "a PDF", make it on the canvas: one screen per slide or page, \`--device slide\` (1920x1080) or \`--device a4\` (794x1123), added in reading order (the export goes left to right, rows top to bottom). Follow section 8 of \`kit.md\`. Preview every page. When the user wants the file, run \`atox canvas export pdf\` and tell them the path it prints. The user can also export from the Export button on the canvas, and can ask for changes by clicking a page.

The user, not you, names and arranges screens. If they renamed a screen, use the new name from \`atox canvas\`.

## What you can use

- \`react\` (hooks, state: the screen is interactive), \`lucide-react\` for icons, \`@atox/ui\` for the component kit.
- Tailwind CSS v4 utility classes, inline styles, and \`import "./styles.css"\`.
- Relative imports of .tsx, .ts, .json, .css files and small images or fonts (they are embedded). Files must stay inside the project folder.
- Nothing else: any other package fails the build with "Package "x" is not available on a canvas". There is no network: fetch, CDNs, web fonts and remote images are blocked. Images only as inline SVG, \`data:\` URIs or small imported files. No localStorage and no routing: the page is sandboxed.
- A self-contained .html file also works as a screen, but prefer React.

## Devices

\`--device\` (default \`${DEFAULT_SCREEN_DEVICE}\`), sizes in CSS pixels:
${CANVAS_DEVICES}

\`--size WxH\` sets a custom size without a device frame (each side ${SCREEN_SIZE.min} to ${SCREEN_SIZE.max}). Prefer a device from the list when one matches: it has the right frame (phone, tablet, browser or window).

## Blank screens from the user

The user can create a canvas without a chat, or add a blank screen to a page, and choose its size (a device above, or a custom size with a frame). Such a screen points to an empty \`.html\` file in \`.atox/canvas/\`. When the user asks you to design it, write your \`.tsx\` file and run \`atox canvas screen set "<that screen's name>" <your file>\` without \`--device\` and \`--size\`: the screen keeps the size and frame the user chose. A canvas the user created without a chat becomes this chat's canvas when the user links it or starts an agent from it; then \`atox canvas\` shows it like any other.

## Design rules

- Design for the exact size of the device. The component fills the frame: give the root element \`h-full w-full\`. Never use \`100vh\`, \`100dvh\` or \`h-screen\`: use \`h-full\`. No outer scrollbars: if the content is longer, scroll inside an inner element (\`overflow-y-auto\`), the way a real app does.
- Realistic content: real names, numbers, labels and states (loading, empty, error), not lorem ipsum.
- Follow the design rules in kit.md: spacing, hierarchy, contrast, touch targets of at least 44 px on phones.
- No external requests of any kind.

## "${CANVAS_MESSAGE_PREFIX} Fix the screen ..." messages

The user right-clicked a screen, chose Fix and asked for a change. The message has the request, \`File:\` with the screen's file, usually \`Screenshot:\` with a PNG of how it looks now, and sometimes \`Build error:\` when the screen does not build right now.

- Open the File, look at the Screenshot, make the change in the code. The canvas rebuilds by itself. If there is a Build error, fix it first.
- Do not run \`atox canvas screen set\` again unless the device or size must change.
- The page is named in the message; when the canvas has several pages, pass it with \`--page "<name>"\` to \`atox canvas\` commands.
- Do not ask the user for screenshots or which file: both are in the message.
- After a bigger change run \`atox canvas screen preview <name>\` to check the result.
- Answer in one or two lines with what you changed.

Other "${CANVAS_MESSAGE_PREFIX} On the canvas page ..." messages are requests about one page as a whole, for example a new screen: put it on that page.

## Troubleshooting

- \`atox\` not found: run "$ATOX_CLI" with the same arguments.
- Blocked by a sandbox or permissions: run it again with elevated permissions; it only talks to the local Atox app.
- The file must be inside the project folder, a .tsx, .jsx or .html file, at most ${SCREEN_FILE_MAX_MB} MB.
`

/** Каталоги навыков агентов: Claude Code читает свой, Codex — общий для агентов ~/.agents. */
const SKILL_TARGETS = [
  { agentHome: '.claude', skillsDirectory: ['.claude', 'skills'] },
  { agentHome: '.codex', skillsDirectory: ['.agents', 'skills'] }
]

/**
 * Устанавливает навыки Atox тем агентам, что есть у пользователя, — так агент знает, что
 * может запускать помощников и показывать экраны на холсте. Справка по набору компонентов
 * и примеры экранов из `kitDirectory` ложатся рядом с навыком холста как `kit.md` и
 * `examples.md`: справку агент читает всегда, примеры — по нужде, поэтому файлы раздельные.
 * Файл перезаписывается, только если его текст изменился.
 */
export async function installSkills(kitDirectory: string): Promise<void> {
  const home = homedir()
  const [kitGuide, kitExamples] = await Promise.all(
    [CANVAS_KIT_GUIDE, CANVAS_KIT_EXAMPLES].map((name) =>
      readFile(join(kitDirectory, name), 'utf8').catch(() => null)
    )
  )
  const skills = [
    { name: 'atox', files: { 'SKILL.md': SKILL } },
    {
      name: 'atox-canvas',
      files: {
        'SKILL.md': CANVAS_SKILL,
        ...(kitGuide !== null && { 'kit.md': kitGuide }),
        ...(kitExamples !== null && { 'examples.md': kitExamples })
      }
    }
  ]
  const targets = SKILL_TARGETS.filter(({ agentHome }) => existsSync(join(home, agentHome)))
  await Promise.all(
    targets.flatMap(({ skillsDirectory }) =>
      skills.flatMap(({ name, files }) =>
        Object.entries(files).map(async ([fileName, content]) => {
          const directory = join(home, ...skillsDirectory, name)
          const file = join(directory, fileName)
          if ((await readFile(file, 'utf8').catch(() => null)) !== content) {
            await mkdir(directory, { recursive: true })
            await writeFile(file, content)
          }
        })
      )
    )
  )
}

/**
 * Правило Codex: `atox` запускается без вопроса и вне песочницы — иначе песочница не даёт
 * подключиться к сокету приложения, и каждую команду помощника пришлось бы одобрять вручную.
 * Codex читает все файлы правил из ~/.codex/rules.
 */
const CODEX_RULES = `prefix_rule(pattern=["atox"], decision="allow")
`

export async function installCodexRules(): Promise<void> {
  const codexHome = join(homedir(), '.codex')
  if (!existsSync(codexHome)) {
    return
  }
  const directory = join(codexHome, 'rules')
  const file = join(directory, 'atox.rules')
  if ((await readFile(file, 'utf8').catch(() => null)) !== CODEX_RULES) {
    await mkdir(directory, { recursive: true })
    await writeFile(file, CODEX_RULES)
  }
}
