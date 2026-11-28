import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, realpath, rename, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { app } from 'electron'
import {
  CANVAS_GROUPS_MAX,
  CANVAS_LINKS_MAX,
  DEFAULT_SCREEN_DEVICE,
  LINK_ON_MAX_LENGTH,
  SCREEN_GRID_PARTS,
  SCREEN_SIZE,
  SCREEN_DEVICES,
  STANDALONE_CANVAS_PREFIX,
  SCREEN_HISTORY_LIMIT,
  canvasScreenUrl,
  isCanvasExportFormat,
  isScreenDeviceId,
  isScreenFrame,
  effectiveScreenGrid,
  isScreenGrid,
  isScreenGridParts,
  isStandaloneCanvas,
  screenFrameOf,
  screenSourceKind,
  type CanvasExportFormat,
  type CanvasExportResult,
  type CanvasGroup,
  type CanvasShare,
  type CanvasState,
  type ScreenDevice,
  type ScreenDeviceId,
  type ScreenFrame,
  type ScreenGridParts,
  type ScreenVersion
} from '../../shared/canvas'
import type { Project } from '../../shared/models'
import type { CanvasScreenGridInfo } from '../../shared/orchestration'
import { CANVAS_KIT_ENTRY } from '../../shared/canvasRuntime'
import type { ConversationManager } from '../conversations/manager'
import { JsonFileWriter, readVersionedJson } from '../jsonFile'
import type { ChatLocation, ProjectStore } from '../store'
import { ScreenBuildError, buildScreen, type ScreenBuild } from './build'
import {
  captureScreen,
  findScreenElements,
  inspectScreen,
  renderScreenForSharing,
  type ScreenRender
} from './capture'
import { checkExportTarget, exportScreens, freeExportPath } from './export'
import type { ScreenDocument, ScreenDocumentSource } from './protocol'
import {
  CanvasError,
  SCREEN_FILE_MAX_BYTES,
  SCREEN_FILE_MAX_MB,
  appendVersion,
  arrangeRows,
  canvasNameFromTitle,
  describeOverflow,
  findCanvasByName,
  findGroupByName,
  findScreenByName,
  formatCanvasMessage,
  formatFixMessage,
  isInsideFolder,
  isScreenDimension,
  isScreenFileName,
  orderForExport,
  parseName,
  parseScreenSize,
  placeNewScreen
} from './rules'
import { renderBuildErrorPage, renderShell } from './shell'
import { ScreenSnapshots, contentHash } from './snapshots'
import {
  CANVAS_FILE_VERSION,
  normalizeCanvases,
  normalizeView,
  publicCanvas,
  type CanvasFile,
  type StoredCanvas,
  type StoredScreen,
  type StoredShare,
  type StoredVersion
} from './store'
import {
  newShareCredentials,
  publishShare,
  shareUrl,
  unpublishShare,
  type SharedCanvas,
  type SharedScreenPage
} from './share'
import { ScreenFileWatcher } from './watcher'

export interface CanvasServices {
  store: ProjectStore
  conversations: ConversationManager
  /** Папка кита `@atox/ui` и токенов темы: из неё собираются экраны-React. */
  kitDirectory: string
  onChange(state: CanvasState): void
}

/** Экран, который агент ставит на холст командой `atox canvas screen set`. */
export interface AgentScreenRequest {
  name: string
  /**
   * Абсолютный путь к файлу экрана: HTML или React-компонент. Не задан — у существующего экрана
   * меняется только устройство или размер.
   */
  file?: string
  device?: string
  /** `WxH` — свой размер экрана. */
  size?: string
  /** Холст чата по имени; не задан — единственный холст чата. */
  canvas?: string
}

/** Холст чата, к которому относится команда агента. */
export interface CanvasTarget {
  chatId: string
  /** Имя холста; не задано — единственный холст чата. */
  canvas?: string
}

export interface AgentScreenResult {
  canvas: string
  screen: string
  /** Холста у чата не было — его создала эта команда. */
  canvasCreated: boolean
  /** Экрана с таким именем не было — он добавлен. */
  created: boolean
  device: ScreenDevice
  width: number
  height: number
  file: string
  /** Что не так с раскладкой экрана; пусто — всё помещается или измерить не удалось. */
  layout: string[]
  /** Сборка экрана-React не удалась: «файл:строка: что не так»; `null` — собрался. */
  buildError: string | null
  /** Ошибки, которые вывела страница экрана при открытии. */
  runtimeErrors: string[]
  grid: CanvasScreenGridInfo
}

/** Сетка, которую ставит агент: число частей по обеим осям или по каждой и видимость. */
export interface AgentGridRequest {
  parts?: number
  columns?: number
  rows?: number
  visible?: boolean
}

export interface AgentGridResult {
  screen: string
  width: number
  height: number
  grid: CanvasScreenGridInfo
}

export interface AgentScreenPreview {
  screen: string
  /** Абсолютный путь к PNG экрана. */
  path: string
  layout: string[]
  buildError: string | null
  runtimeErrors: string[]
}

/** Выгрузка, которую просит агент: экраны по именам (все, если не названы) и путь к файлу. */
export interface AgentExportRequest {
  format: string
  screens?: string[]
  /** Абсолютный путь: файл для PDF и PPTX, папка для PNG. Не назван — папка «Загрузки». */
  out?: string
}

export interface AgentArrangeResult {
  /** Сколько рядов получилось и сколько экранов в названных рядах. */
  rows: number
  screens: number
  /** Экраны, которых в рядах не было: они уложены отдельным рядом внизу, в прежнем порядке. */
  rest: string[]
}

/** Линия, которую ставит агент: экраны по именам. */
export interface AgentLinkRequest {
  from: string
  to: string
  /** Кнопка (или другой элемент) экрана `from`: текст или CSS-селектор. */
  on?: string
}

export interface AgentLinkResult {
  from: string
  to: string
  on: string | null
  /** Линия новая, а не такая же уже была. */
  created: boolean
  /** `on` задан, но такого элемента на экране не нашли: линия идёт от края экрана. */
  elementMissing: boolean
}

/** Группа, которую ставит агент: имя и экраны по именам. */
export interface AgentGroupResult {
  name: string
  screens: string[]
  /** Группа новая, а не обновлённая. */
  created: boolean
}

export interface AgentCanvasView {
  name: string
  /** Адрес страницы для просмотра; `null` — холст не опубликован. */
  share: string | null
  groups: { name: string; screens: string[] }[]
  links: { from: string; to: string; on: string | null }[]
  screens: {
    name: string
    device: ScreenDevice
    width: number
    height: number
    file: string
    missing: boolean
    buildError: string | null
    grid: CanvasScreenGridInfo
  }[]
}

/** Сколько экранов снимается для ссылки одновременно: каждый — скрытое окно. */
const SHARE_RENDER_CONCURRENCY = 3

/** Холст без чата: проект и ключ, которым собраны его страницы. */
interface CanvasOwner {
  project: Project
  chatId: string
}

/** Имя первой страницы холста без чата, если человек его не дал. */
const DEFAULT_PAGE_NAME = 'Page 1'

/** Пустой экран: устройство, размер и рамка своего размера. */
interface BlankLook {
  device: ScreenDevice
  width: number
  height: number
  frame?: ScreenFrame
}

interface ScreenLocation {
  canvas: StoredCanvas
  screen: StoredScreen
}

/**
 * Холсты чатов: экраны из файлов проекта (React-компонент или HTML), за которыми приложение
 * следит. У экрана-React следят и за всем, что он импортирует, и пересобирают его.
 * Каждое изменение файла экрана становится версией (снимок хранится в данных приложения),
 * и окно перезагружает экран по новой ревизии. Файлы экранов принадлежат проекту: холст их
 * только читает, а пишет лишь при восстановлении версии по просьбе человека.
 */
export class CanvasService implements ScreenDocumentSource {
  /** Расстановка стрелок по экранам: на один экран одновременно идёт одна. */
  private readonly anchorJobs = new Map<string, Promise<void>>()
  private readonly watcher = new ScreenFileWatcher((key) => void this.queueCheck(key))
  /** Проверки файлов идут по одной на экран: иначе одно изменение стало бы двумя версиями. */
  private readonly checks = new Map<string, Promise<void>>()
  /** Экраны, в файл которых записана версия из истории: следующая версия — восстановление. */
  private readonly restoring = new Set<string>()
  /** Последняя удачная сборка каждого экрана-React: её показывает холст, пока новая не готова. */
  private readonly builds = new Map<string, ScreenBuild>()
  /** Хеш того, что показывает экран сейчас: у HTML — файл, у React — результат сборки. */
  private readonly outputs = new Map<string, string>()
  /** Публикации холстов чатов, которые идут сейчас: повторная просьба ждёт ту же, а не шлёт вторую. */
  private readonly sharing = new Map<string, Promise<CanvasShare>>()

  private constructor(
    private readonly services: CanvasServices,
    private readonly file: JsonFileWriter,
    private readonly snapshots: ScreenSnapshots,
    private canvases: StoredCanvas[]
  ) {}

  static async load(
    services: CanvasServices,
    filePath: string,
    historyDirectory: string
  ): Promise<CanvasService> {
    const data = await readVersionedJson<CanvasFile>(filePath, CANVAS_FILE_VERSION)
    const projectIds = new Set(services.store.list().map(({ id }) => id))
    const service = new CanvasService(
      services,
      new JsonFileWriter(filePath),
      new ScreenSnapshots(historyDirectory),
      normalizeCanvases(data, projectIds, Date.now())
    )
    // Пока приложение было закрыто, файлы могли поменять: проверка заметит это сразу.
    for (const canvas of service.canvases) {
      if (!canvas.archived) {
        service.watchCanvas(canvas)
      }
    }
    return service
  }

  state(): CanvasState {
    return { canvases: this.canvases.map(publicCanvas), sharing: [...this.sharing.keys()] }
  }

  /** Холст чата: его первая страница; холста нет — создаётся пустая страница с названием чата. */
  create(chatId: string): string {
    const existing = this.activeCanvasesOf(chatId)[0]
    if (existing) {
      return existing.id
    }
    // Холст чата в архиве: он возвращается вместе со страницами, а не заводится второй.
    const archived = this.pagesOf(chatId)[0]
    if (archived) {
      this.archive(archived.id, false)
      return archived.id
    }
    const location = this.services.store.findChat(chatId)
    if (!location) {
      throw new CanvasError('The chat was not found.')
    }
    const canvas = this.addCanvas(location)
    this.changed()
    return canvas.id
  }

  /** Новая пустая страница в холсте чата: в конце, с именем «Page N». Возвращает её id. */
  addPage(chatId: string): string {
    const pages = this.pagesOf(chatId)
    const owner = this.ownerOf(chatId, pages[0])
    const taken = new Set(pages.map(({ name }) => name.toLowerCase()))
    let number = pages.length + 1
    while (taken.has(`page ${number}`)) {
      number += 1
    }
    const canvas = this.addCanvas(owner, `Page ${number}`)
    this.changed()
    return canvas.id
  }

  /**
   * Холст без чата: человек создаёт его сам из списка холстов. С `look` на первой странице сразу
   * стоит пустой экран этого размера. Возвращает id первой страницы.
   */
  async createStandalone(projectId: string, name: unknown, look?: unknown): Promise<string> {
    const project = this.services.store.findProject(projectId)
    if (!project) {
      throw new CanvasError('The project was not found.')
    }
    const pageName = parseName(name, 'canvas')
    const screenLook = look === undefined ? undefined : parseScreenLook(look)
    const canvas = this.addCanvas(
      { project, chatId: `${STANDALONE_CANVAS_PREFIX}${randomUUID()}` },
      pageName
    )
    this.changed()
    if (screenLook) {
      try {
        await this.placeBlankScreen(canvas, project, screenLook)
      } catch (error) {
        // Без экрана холст не нужен: человек увидит ошибку и создаст его заново.
        await this.remove(canvas.id)
        throw error
      }
    }
    return canvas.id
  }

  /**
   * Пустой экран выбранного размера на странице: в проекте появляется пустой HTML-файл
   * (`.atox/canvas/…`), и экран следит за ним, как за любым другим. Агент потом заменяет файл
   * своим, не трогая размер. Возвращает id экрана.
   */
  async addBlankScreen(canvasId: string, look: unknown): Promise<string> {
    const canvas = this.getCanvas(canvasId)
    const project = this.services.store.findProject(canvas.projectId)
    if (!project) {
      throw new CanvasError('The project of this canvas was not found.')
    }
    return this.placeBlankScreen(canvas, project, parseScreenLook(look))
  }

  private async placeBlankScreen(
    canvas: StoredCanvas,
    project: Project,
    look: BlankLook
  ): Promise<string> {
    const taken = new Set(canvas.screens.map(({ name }) => name.toLowerCase()))
    let number = canvas.screens.length + 1
    while (taken.has(`screen ${number}`)) {
      number += 1
    }
    const name = `Screen ${number}`
    const file = await writeBlankScreenFile(project.path, `${canvas.name}-${name}`, look)
    if (!this.canvases.includes(canvas)) {
      throw new CanvasError('The canvas was deleted.')
    }
    const screen: StoredScreen = {
      id: randomUUID(),
      name,
      device: look.device,
      width: look.width,
      height: look.height,
      ...(look.frame && { frame: look.frame }),
      file,
      ...placeNewScreen(canvas.screens, look.width),
      revision: 0,
      missing: false,
      buildError: null,
      updatedAt: Date.now(),
      versions: []
    }
    canvas.screens.push(screen)
    canvas.updatedAt = Date.now()
    this.changed()
    const key = screenKey(canvas.id, screen.id)
    if (!canvas.archived) {
      this.watcher.watch(key, [file])
      await this.queueCheck(key)
    }
    return screen.id
  }

  /**
   * Привязывает холст без чата (все его страницы) к чату того же проекта: теперь агент этого чата
   * рисует на нём, и туда уходят просьбы. У чата не должно быть своего холста — их не сливаем.
   */
  linkChat(canvasId: string, chatId: string): void {
    const canvas = this.getCanvas(canvasId)
    if (!isStandaloneCanvas(canvas)) {
      throw new CanvasError('This canvas is already linked to a chat.')
    }
    const location = this.services.store.findChat(chatId)
    if (!location) {
      throw new CanvasError('The chat was not found.')
    }
    if (location.project.id !== canvas.projectId) {
      throw new CanvasError('Link the canvas to a chat of its own project.')
    }
    if (this.pagesOf(chatId).length > 0) {
      throw new CanvasError('This chat already has a canvas.')
    }
    if (this.sharing.has(canvas.chatId)) {
      throw new CanvasError('Wait until the canvas is shared, then link it.')
    }
    const key = canvas.chatId
    const now = Date.now()
    for (const page of this.pagesOf(key)) {
      page.chatId = chatId
      page.updatedAt = now
    }
    this.changed()
  }

  /** Имена страниц чата разные: по имени агент находит страницу. */
  rename(canvasId: string, name: unknown): void {
    const canvas = this.getCanvas(canvasId)
    const pageName = parseName(name, 'page')
    const namesake = findCanvasByName(this.pagesOf(canvas.chatId), pageName)
    if (namesake && namesake !== canvas) {
      throw new CanvasError(`Another page of this canvas is already called “${namesake.name}”.`)
    }
    canvas.name = pageName
    canvas.updatedAt = Date.now()
    this.changed()
  }

  /**
   * Новый порядок страниц чата. `pageIds` — все страницы чата: чужая или пропавшая страница —
   * ошибка, чтобы устаревший список не потерял страницу.
   */
  reorderPages(chatId: string, pageIds: readonly string[]): void {
    const pages = this.pagesOf(chatId)
    const byId = new Map(pages.map((page) => [page.id, page]))
    const ordered = pageIds.map((id) => byId.get(id))
    if (
      ordered.length !== pages.length ||
      new Set(pageIds).size !== pageIds.length ||
      ordered.some((page) => page === undefined)
    ) {
      throw new CanvasError('The list of pages is out of date.')
    }
    // Страницы чата занимают в общем списке те же места, но в новом порядке.
    const queue = ordered as StoredCanvas[]
    let next = 0
    this.canvases = this.canvases.map((canvas) =>
      canvas.chatId === chatId ? (queue[next++] as StoredCanvas) : canvas
    )
    this.changed()
  }

  /** Имена экранов на холсте разные: по имени агент находит экран. */
  renameScreen(canvasId: string, screenId: string, name: unknown): void {
    const { canvas, screen } = this.getScreen(canvasId, screenId)
    const screenName = parseName(name, 'screen')
    const namesake = findScreenByName(canvas.screens, screenName)
    if (namesake && namesake !== screen) {
      throw new CanvasError(`Another screen on this canvas is already called “${namesake.name}”.`)
    }
    screen.name = screenName
    this.changed()
  }

  /**
   * Сетка поверх экрана: инструмент человека на холсте. Хранится у экрана, но не меняет его файл,
   * не уходит в выгрузку и в ссылку. Число частей по каждой оси — одно из верных.
   */
  setScreenGrid(canvasId: string, screenId: string, grid: unknown): void {
    const { screen } = this.getScreen(canvasId, screenId)
    if (!isScreenGrid(grid)) {
      throw new CanvasError('Invalid screen grid.')
    }
    screen.grid = { visible: grid.visible, columns: grid.columns, rows: grid.rows }
    this.changed()
  }

  /**
   * Новый размер экрана из панели инструментов: устройство из списка или свой размер. Меняется
   * сам экран на холсте (его ширина и высота), а не HTML. Свой размер сохраняет рамку экрана.
   * Сетка берёт ближайшую верную клетку для нового размера.
   */
  resizeScreen(canvasId: string, screenId: string, look: unknown): void {
    const { canvas, screen } = this.getScreen(canvasId, screenId)
    const next = parseResizeLook(look)
    if (next.device === 'custom') {
      const frame = screenFrameOf(screen)
      Object.assign(screen, { device: 'custom', width: next.width, height: next.height })
      if (frame === 'none') {
        delete screen.frame
      } else {
        screen.frame = frame
      }
    } else {
      Object.assign(screen, deviceLook(next.device))
      delete screen.frame
    }
    canvas.updatedAt = Date.now()
    this.changed()
    // Другой размер экрана сдвигает кнопки: линии от них находят их заново.
    void this.refreshAnchors(canvas, screen)
  }

  /**
   * Сетка экрана по команде агента: показать, выбрать число равных частей (обе оси или каждую),
   * включить или спрятать. Неверное число — ошибка со списком верных.
   */
  setGridForAgent(target: CanvasTarget, name: string, request: AgentGridRequest): AgentGridResult {
    const canvas = this.agentCanvas(target)
    const screen = this.screenNamed(canvas, name)
    const { parts, columns, rows } = request
    if (parts !== undefined && (columns !== undefined || rows !== undefined)) {
      throw new CanvasError('Use either --parts or --columns/--rows, not both.')
    }
    const picked = (flag: string, value: number | undefined): ScreenGridParts | undefined => {
      if (value === undefined) {
        return undefined
      }
      if (!isScreenGridParts(value)) {
        throw new CanvasError(
          `--${flag} ${value} is not a valid grid. Valid numbers of equal parts: ${SCREEN_GRID_PARTS.join(', ')}.`
        )
      }
      return value
    }
    const nextColumns = picked(parts !== undefined ? 'parts' : 'columns', parts ?? columns)
    const nextRows = picked(parts !== undefined ? 'parts' : 'rows', parts ?? rows)
    if (nextColumns !== undefined || nextRows !== undefined || request.visible !== undefined) {
      const current = effectiveScreenGrid(screen)
      // Выбор числа частей показывает сетку: иначе он ничего бы не изменил на экране.
      const visible =
        request.visible ??
        (nextColumns !== undefined || nextRows !== undefined ? true : current.visible)
      screen.grid = {
        visible,
        columns: nextColumns ?? current.columns,
        rows: nextRows ?? current.rows
      }
      this.changed()
    }
    return {
      screen: screen.name,
      width: screen.width,
      height: screen.height,
      grid: gridInfoOf(screen)
    }
  }

  moveScreen(canvasId: string, screenId: string, x: unknown, y: unknown): void {
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      throw new CanvasError('Invalid screen position.')
    }
    const { screen } = this.getScreen(canvasId, screenId)
    screen.x = x
    screen.y = y
    this.changed()
  }

  setView(canvasId: string, view: unknown): void {
    const canvas = this.getCanvas(canvasId)
    const normalized = normalizeView(view)
    if (!normalized) {
      throw new CanvasError('Invalid canvas view.')
    }
    canvas.view = normalized
    this.changed()
  }

  /**
   * Убирает в архив весь холст чата, которому принадлежит страница, или возвращает его: страницы
   * архивируются вместе. В архиве за файлами не следят; вернувшийся холст сразу проверяет их.
   */
  archive(canvasId: string, archived: boolean): void {
    const { chatId } = this.getCanvas(canvasId)
    const pages = this.pagesOf(chatId).filter((page) => page.archived !== archived)
    for (const page of pages) {
      page.archived = archived
      if (archived) {
        this.unwatchCanvas(page)
      } else {
        this.watchCanvas(page)
      }
    }
    if (pages.length > 0) {
      this.changed()
    }
  }

  /**
   * Удаляет страницу и снимки её версий; файлы экранов остаются в проекте. Удалена последняя
   * страница чата — вместе с ней закрывается ссылка холста.
   */
  async remove(canvasId: string): Promise<void> {
    const canvas = this.getCanvas(canvasId)
    const share = this.chatShareOf(canvas.chatId)
    // Без сети страница всё равно удаляется.
    if (share && this.pagesOf(canvas.chatId).length === 1) {
      await unpublishShare(share).catch((error) =>
        console.error('Failed to close the link of a deleted canvas', error)
      )
    }
    this.unwatchCanvas(canvas)
    this.canvases = this.canvases.filter((other) => other !== canvas)
    this.changed()
    await this.snapshots
      .removeCanvas(canvas.id)
      .catch((error) => console.error('Failed to remove the canvas history', error))
  }

  /** Удаляет холст чата целиком, со всеми страницами. */
  async removeChatCanvas(chatId: string): Promise<void> {
    for (const page of this.pagesOf(chatId)) {
      await this.remove(page.id)
    }
  }

  /** Проект убрали из Atox — его холсты больше негде показать. */
  async removeProject(projectId: string): Promise<void> {
    const canvases = this.canvases.filter((canvas) => canvas.projectId === projectId)
    // По очереди: последняя страница чата закрывает ссылку холста.
    for (const canvas of canvases) {
      await this.remove(canvas.id)
    }
  }

  /**
   * Просьба человека в чат холста. С экраном это «Fix»: к тексту добавляются файл экрана
   * и его скриншот, а текст запоминается для следующей версии экрана.
   */
  async request(canvasId: string, text: unknown, screenId?: string): Promise<void> {
    const canvas = this.getCanvas(canvasId)
    const message = typeof text === 'string' ? text.trim() : ''
    if (!message) {
      throw new CanvasError('The message is empty.')
    }
    const chatId = this.chatOf(canvas)
    // Чат назван по просьбе человека, а не по служебному началу сообщения.
    const options = { titleFrom: message }
    if (screenId === undefined) {
      await this.services.conversations.send(chatId, formatCanvasMessage(message, canvas.name), {}, options)
      return
    }
    const { screen } = this.getScreen(canvasId, screenId)
    const screenshot = (await this.render(canvas, screen))?.path ?? null
    const previousFix = screen.pendingFix
    // Вторая просьба до правки файла не заменяет первую: версия получит обе.
    screen.pendingFix = previousFix === undefined ? message : `${previousFix}\n${message}`
    this.persist()
    try {
      await this.services.conversations.send(
        chatId,
        formatFixMessage({
          screenName: screen.name,
          pageName: canvas.name,
          text: message,
          file: screen.file,
          screenshot,
          buildError: screen.buildError
        }),
        {},
        options
      )
    } catch (error) {
      if (previousFix === undefined) {
        delete screen.pendingFix
      } else {
        screen.pendingFix = previousFix
      }
      this.persist()
      throw error
    }
  }

  /** Версии экрана, от новой к старой. */
  history(canvasId: string, screenId: string): ScreenVersion[] {
    const { screen } = this.getScreen(canvasId, screenId)
    return screen.versions.toReversed().map(({ hash: _hash, ...version }) => version)
  }

  /**
   * Записывает снимок версии в файл экрана. Проверка файла делает из этого новую версию
   * с причиной «restore» — её видят и холст, и агент, который правит файл.
   */
  async restore(canvasId: string, screenId: string, versionId: string): Promise<void> {
    const { canvas, screen } = this.getScreen(canvasId, screenId)
    const version = screen.versions.find(({ id }) => id === versionId)
    if (!version) {
      throw new CanvasError('This version is no longer in the history.')
    }
    if (version === screen.versions.at(-1) && !screen.missing) {
      return
    }
    const content = await this.snapshots.read(canvas.id, screen.id, version.hash).catch(() => {
      throw new CanvasError('The saved copy of this version is missing.')
    })
    const key = screenKey(canvas.id, screen.id)
    this.restoring.add(key)
    try {
      await writeFileAtomically(screen.file, content)
    } catch (error) {
      this.restoring.delete(key)
      console.error('Failed to restore a canvas screen', error)
      throw new CanvasError(`Could not write ${screen.file}.`)
    }
    await this.queueCheck(key)
  }

  async screenDocument(
    canvasId: string,
    screenId: string,
    versionId?: string
  ): Promise<ScreenDocument | null> {
    const location = this.findScreen(canvasId, screenId)
    if (!location) {
      return null
    }
    const { canvas, screen } = location
    const version = versionId
      ? screen.versions.find(({ id }) => id === versionId)
      : screen.versions.at(-1)
    if (versionId && !version) {
      return null
    }
    const source = version
      ? await this.snapshots.read(canvas.id, screen.id, version.hash).catch(() => null)
      : // Версий ещё нет (первая проверка файла не закончилась) — показывается сам файл.
        await readScreenFile(screen.file)
    if (source === null) {
      return null
    }
    if (screenSourceKind(screen.file) !== 'react') {
      return { html: source, modules: false }
    }
    return this.reactDocument(canvas, screen, versionId ? source : undefined)
  }

  /**
   * Страница экрана-React. Текущий экран — последняя удачная сборка (идущую сборку
   * дожидаемся); версия из истории собирается из своего снимка с нынешними импортами.
   */
  private async reactDocument(
    canvas: StoredCanvas,
    screen: StoredScreen,
    versionSource?: string
  ): Promise<ScreenDocument> {
    const key = screenKey(canvas.id, screen.id)
    try {
      await this.checks.get(key)
      const build = versionSource
        ? await buildScreen(this.buildRequest(canvas, screen, versionSource))
        : this.builds.get(key)
      if (!build) {
        throw new ScreenBuildError(screen.buildError ?? 'The screen has not been built yet.', [])
      }
      return {
        html: await renderShell(build, this.services.kitDirectory),
        modules: true
      }
    } catch (error) {
      if (!(error instanceof ScreenBuildError)) {
        console.error('Failed to render a React canvas screen', error)
      }
      const message =
        error instanceof ScreenBuildError ? error.message : 'The screen could not be built.'
      return { html: renderBuildErrorPage(message), modules: false }
    }
  }

  private buildRequest(canvas: StoredCanvas, screen: StoredScreen, source: string) {
    const { store, kitDirectory } = this.services
    const roots = [
      store.findProject(canvas.projectId)?.path,
      store.findChat(canvas.chatId)?.chat.worktree
    ].filter((root) => root !== undefined)
    return {
      source,
      file: screen.file,
      roots,
      kit: join(kitDirectory, CANVAS_KIT_ENTRY)
    }
  }

  /** Холсты чата для `atox canvas`: названный или все. */
  describe(target: CanvasTarget): AgentCanvasView[] {
    const canvases =
      target.canvas === undefined
        ? this.activeCanvasesOf(target.chatId)
        : [this.agentCanvas(target)]
    return canvases.map((canvas) => this.viewOf(canvas))
  }

  private shareLinkOf(chatId: string): string | null {
    const share = this.chatShareOf(chatId)
    return share && shareUrl(share.id)
  }

  private viewOf(canvas: StoredCanvas): AgentCanvasView {
    return {
      name: canvas.name,
      share: this.shareLinkOf(canvas.chatId),
      groups: canvas.groups.map(({ name, screens }) => ({
        name,
        screens: screens.flatMap(
          (id) => canvas.screens.find((screen) => screen.id === id)?.name ?? []
        )
      })),
      links: canvas.links.flatMap(({ from, to, on }) => {
        const source = canvas.screens.find(({ id }) => id === from)
        const target = canvas.screens.find(({ id }) => id === to)
        return source && target ? [{ from: source.name, to: target.name, on }] : []
      }),
      screens: canvas.screens.map((screen) => ({
        name: screen.name,
        device: screen.device,
        width: screen.width,
        height: screen.height,
        file: screen.file,
        missing: screen.missing,
        buildError: screen.buildError,
        grid: gridInfoOf(screen)
      }))
    }
  }

  /**
   * Новый холст чата по команде агента. Холст с таким именем уже есть — он и возвращается:
   * лишних холстов агент не плодит.
   */
  createForAgent(caller: ChatLocation, nameInput: string): { canvas: string; created: boolean } {
    const name = parseName(nameInput, 'canvas')
    const existing = findCanvasByName(this.activeCanvasesOf(caller.chat.id), name)
    if (existing) {
      return { canvas: existing.name, created: false }
    }
    const canvas = this.addCanvas(caller, name)
    this.changed()
    return { canvas: canvas.name, created: true }
  }

  /**
   * Ставит экран на холст чата по просьбе агента: новый — с именем и местом по раскладке,
   * существующий (по имени) — меняет его файл и устройство, но не имя и не место: их
   * выбирает человек.
   */
  async setScreen(caller: ChatLocation, request: AgentScreenRequest): Promise<AgentScreenResult> {
    const name = parseName(request.name, 'screen')
    if (request.device !== undefined && request.size !== undefined) {
      throw new CanvasError('Use either --device or --size, not both.')
    }
    const device = request.device !== undefined ? parseDevice(request.device) : undefined
    const size = request.size !== undefined ? parseScreenSize(request.size) : undefined
    // Агент задачи с доски работает в worktree: его экраны лежат там.
    const folders = [caller.project.path, caller.chat.worktree].filter(
      (folder) => folder !== undefined
    )
    if (request.file === undefined) {
      // Без файла команда только меняет размер существующего экрана.
      if (device === undefined && size === undefined) {
        throw new CanvasError('Give the screen file, or --device or --size to resize the screen.')
      }
      const known = this.canvasOf({
        chatId: caller.chat.id,
        ...(request.canvas !== undefined && { canvas: request.canvas })
      })
      if (!known || !findScreenByName(known.screens, name)) {
        throw new CanvasError(
          `There is no screen "${name}" yet. Give its file: atox canvas screen set "${name}" <file.tsx>.`
        )
      }
    }
    const file =
      request.file === undefined ? undefined : await verifyScreenFile(request.file, folders)
    // Пока проверяли файл, чат могли удалить.
    const location = this.services.store.findChat(caller.chat.id)
    if (!location) {
      throw new CanvasError('This chat no longer exists.')
    }
    const existing = this.canvasOf({
      chatId: location.chat.id,
      ...(request.canvas !== undefined && { canvas: request.canvas })
    })
    const canvas = existing ?? this.addCanvas(location)
    let screen = findScreenByName(canvas.screens, name)
    const created = screen === undefined
    // Без --device и --size существующий экран остаётся на своём устройстве.
    const look = size ? { device: 'custom' as const, ...size } : device && deviceLook(device)
    if (screen) {
      if (file !== undefined && screen.file !== file) {
        this.forgetOutput(screenKey(canvas.id, screen.id))
      }
      Object.assign(screen, look, file !== undefined && { file })
      if (look) {
        // Агент выбрал устройство или свой размер: рамка, которую выбирал человек, уходит.
        delete screen.frame
      }
    } else if (file === undefined) {
      // Экран удалили, пока шла команда.
      throw new CanvasError(`There is no screen "${name}" any more.`)
    } else {
      const newLook = look ?? deviceLook(DEFAULT_SCREEN_DEVICE)
      screen = {
        id: randomUUID(),
        name,
        ...newLook,
        file,
        ...placeNewScreen(canvas.screens, newLook.width),
        revision: 0,
        missing: false,
        buildError: null,
        updatedAt: Date.now(),
        versions: []
      }
      canvas.screens.push(screen)
    }
    canvas.updatedAt = Date.now()
    this.changed()
    const key = screenKey(canvas.id, screen.id)
    this.watcher.watch(key, [screen.file])
    await this.queueCheck(key)
    if (!created && look) {
      // Другой размер экрана сдвигает кнопки: линии от них находят их заново.
      void this.refreshAnchors(canvas, screen)
    }
    const inspection = await this.inspect(canvas, screen)
    return {
      canvas: canvas.name,
      screen: screen.name,
      canvasCreated: existing === undefined,
      created,
      device: screen.device,
      width: screen.width,
      height: screen.height,
      file: screen.file,
      layout: describeOverflow(screen, inspection?.size ?? null),
      buildError: screen.buildError,
      runtimeErrors: inspection?.errors ?? [],
      grid: gridInfoOf(screen)
    }
  }

  /**
   * Снимает экран так, как он выглядит на холсте, чтобы агент проверил свою работу, и
   * измеряет раскладку.
   */
  async previewScreen(target: CanvasTarget, name: string): Promise<AgentScreenPreview> {
    const canvas = this.agentCanvas(target)
    const screen = findScreenByName(canvas.screens, name)
    if (!screen) {
      const names = canvas.screens.map((other) => `"${other.name}"`).join(', ') || 'none'
      throw new CanvasError(`There is no screen "${name.trim()}" on the canvas. Screens: ${names}.`)
    }
    // Файл сверяется заново, не дожидаясь слежения: агент мог записать его только что, и снимок
    // без этого показал бы прежнюю сборку. Неизменившийся файл ревизию не меняет.
    await this.queueCheck(screenKey(canvas.id, screen.id))
    const rendered = await this.render(canvas, screen)
    if (!rendered) {
      throw new CanvasError(
        `Could not render the screen "${screen.name}". Check that ${screen.file} exists and opens without errors.`
      )
    }
    return {
      screen: screen.name,
      path: rendered.path,
      layout: describeOverflow(screen, rendered.size),
      buildError: screen.buildError,
      runtimeErrors: rendered.errors
    }
  }

  /**
   * Выгружает экраны холста в PDF, PNG или PPTX. Экраны идут в порядке холста: ряды сверху вниз,
   * в ряду слева направо. Без `screenIds` выгружаются все.
   */
  async exportCanvas(
    canvasId: string,
    format: CanvasExportFormat,
    target: string,
    screenIds?: readonly string[]
  ): Promise<CanvasExportResult> {
    const canvas = this.getCanvas(canvasId)
    const screens = screenIds
      ? screenIds.map((id) => this.getScreen(canvasId, id).screen)
      : canvas.screens
    return this.runExport(canvas, screens, format, target)
  }

  /** Выгрузка по просьбе агента из `atox canvas export`. */
  async exportForAgent(
    target: CanvasTarget,
    request: AgentExportRequest
  ): Promise<CanvasExportResult> {
    const canvas = this.agentCanvas(target)
    const { format, screens: names, out } = request
    if (!isCanvasExportFormat(format)) {
      throw new CanvasError('The format must be pdf, png or pptx.')
    }
    const screens = names
      ? names.map((name) => {
          const screen = findScreenByName(canvas.screens, name)
          if (!screen) {
            const known = canvas.screens.map((other) => `"${other.name}"`).join(', ') || 'none'
            throw new CanvasError(
              `There is no screen "${name.trim()}" on the canvas. Screens: ${known}.`
            )
          }
          return screen
        })
      : canvas.screens
    if (out !== undefined && !isAbsolute(out)) {
      throw new CanvasError('The output path must be absolute.')
    }
    const destination = out ?? (await freeExportPath(app.getPath('downloads'), canvas.name, format))
    checkExportTarget(format, destination)
    return this.runExport(canvas, screens, format, destination)
  }

  private async runExport(
    canvas: StoredCanvas,
    screens: readonly StoredScreen[],
    format: CanvasExportFormat,
    target: string
  ): Promise<CanvasExportResult> {
    if (screens.length === 0) {
      throw new CanvasError('The canvas has no screens to export.')
    }
    // Файлы сверяются заново, не дожидаясь слежения: агент мог записать их только что.
    await Promise.all(screens.map((screen) => this.queueCheck(screenKey(canvas.id, screen.id))))
    const warnings: string[] = []
    for (const screen of screens) {
      const key = screenKey(canvas.id, screen.id)
      if (screenSourceKind(screen.file) === 'react' && !this.builds.has(key)) {
        throw new CanvasError(
          `The screen "${screen.name}" does not build, so it cannot be exported: ${screen.buildError ?? 'no build'}`
        )
      }
      if (screen.buildError) {
        warnings.push(`"${screen.name}": the last build failed, the last good version is exported.`)
      } else if (screen.missing) {
        warnings.push(`"${screen.name}": the file is missing, the last saved version is exported.`)
      }
    }
    const ordered = orderForExport(screens)
    await exportScreens(
      format,
      ordered.map((screen) => ({
        name: screen.name,
        url: canvasScreenUrl(canvas.id, screen.id, screen.revision),
        width: screen.width,
        height: screen.height
      })),
      target,
      canvas.name
    )
    return { path: target, screens: ordered.length, warnings }
  }

  /**
   * Ставит линию `from` → `to` на холст чата; такая же уже есть — ничего не меняется. С `on`
   * линия начинается у этой кнопки: приложение находит её на экране и помнит, где она, пока
   * экран меняется.
   */
  async setLink(target: CanvasTarget, request: AgentLinkRequest): Promise<AgentLinkResult> {
    const canvas = this.agentCanvas(target)
    const from = this.screenNamed(canvas, request.from)
    const to = this.screenNamed(canvas, request.to)
    if (from === to) {
      throw new CanvasError('A line needs two different screens.')
    }
    const on = linkText(request.on, LINK_ON_MAX_LENGTH, 'element')
    let link = canvas.links.find(
      (other) =>
        other.from === from.id &&
        other.to === to.id &&
        (other.on ?? '').toLowerCase() === (on ?? '').toLowerCase()
    )
    const created = link === undefined
    if (!link) {
      if (canvas.links.length >= CANVAS_LINKS_MAX) {
        throw new CanvasError(`A canvas has at most ${CANVAS_LINKS_MAX} lines.`)
      }
      link = { id: randomUUID(), from: from.id, to: to.id, on, anchor: null }
      canvas.links.push(link)
      canvas.updatedAt = Date.now()
      this.changed()
    }
    if (on) {
      await this.refreshAnchors(canvas, from)
    }
    return {
      from: from.name,
      to: to.name,
      on: link.on,
      created,
      elementMissing: on !== null && link.anchor === null
    }
  }

  /** Убирает линии между экранами; с `on` — только те, что начинаются у этой кнопки. */
  removeLink(target: CanvasTarget, fromName: string, toName: string, on?: string): number {
    const canvas = this.agentCanvas(target)
    const from = this.screenNamed(canvas, fromName)
    const to = this.screenNamed(canvas, toName)
    const wanted = linkText(on, LINK_ON_MAX_LENGTH, 'element')?.toLowerCase()
    const before = canvas.links.length
    canvas.links = canvas.links.filter(
      (link) =>
        link.from !== from.id ||
        link.to !== to.id ||
        (wanted !== undefined && (link.on ?? '').toLowerCase() !== wanted)
    )
    const removed = before - canvas.links.length
    if (removed > 0) {
      canvas.updatedAt = Date.now()
      this.changed()
    }
    return removed
  }

  /**
   * Собирает экраны в группу с этим именем: нет такой — создаётся, есть — получает ровно эти
   * экраны. Экран входит в одну группу, поэтому из прежней группы он уходит; опустевшая
   * группа исчезает.
   */
  setGroup(
    target: CanvasTarget,
    nameInput: string,
    screenNames: readonly string[]
  ): AgentGroupResult {
    const canvas = this.agentCanvas(target)
    const name = parseName(nameInput, 'group')
    const members = [
      ...new Set(screenNames.map((screenName) => this.screenNamed(canvas, screenName)))
    ]
    if (members.length === 0) {
      throw new CanvasError('Name at least one screen for the group.')
    }
    const ids = new Set(members.map(({ id }) => id))
    let group = findGroupByName(canvas.groups, name)
    const created = group === undefined
    if (!group) {
      if (canvas.groups.length >= CANVAS_GROUPS_MAX) {
        throw new CanvasError(`A canvas has at most ${CANVAS_GROUPS_MAX} groups.`)
      }
      group = { id: randomUUID(), name, screens: [] }
      canvas.groups.push(group)
    }
    group.screens = members.map(({ id }) => id)
    for (const other of canvas.groups) {
      if (other !== group) {
        other.screens = other.screens.filter((id) => !ids.has(id))
      }
    }
    canvas.groups = canvas.groups.filter(({ screens }) => screens.length > 0)
    canvas.updatedAt = Date.now()
    this.changed()
    return {
      name: group.name,
      screens: members.map((screen) => screen.name),
      created
    }
  }

  /** Распускает группу по имени: экраны остаются на холсте. */
  removeGroup(target: CanvasTarget, name: string): string {
    const canvas = this.agentCanvas(target)
    const group = findGroupByName(canvas.groups, name)
    if (!group) {
      const names = canvas.groups.map((other) => `"${other.name}"`).join(', ') || 'none'
      throw new CanvasError(`There is no group "${name.trim()}" on the canvas. Groups: ${names}.`)
    }
    this.dropGroup(canvas, group)
    return group.name
  }

  /** Человек распускает группу из меню её заголовка. */
  ungroup(canvasId: string, groupId: string): void {
    const { canvas, group } = this.getGroup(canvasId, groupId)
    this.dropGroup(canvas, group)
  }

  renameGroup(canvasId: string, groupId: string, name: unknown): void {
    const { canvas, group } = this.getGroup(canvasId, groupId)
    const groupName = parseName(name, 'group')
    const namesake = findGroupByName(canvas.groups, groupName)
    if (namesake && namesake !== group) {
      throw new CanvasError(`Another group on this canvas is already called “${namesake.name}”.`)
    }
    group.name = groupName
    canvas.updatedAt = Date.now()
    this.changed()
  }

  /** Сдвигает группу вместе со всеми её экранами на одно расстояние. */
  moveGroup(canvasId: string, groupId: string, dx: unknown, dy: unknown): void {
    if (!isFiniteNumber(dx) || !isFiniteNumber(dy)) {
      throw new CanvasError('Invalid group offset.')
    }
    const { canvas, group } = this.getGroup(canvasId, groupId)
    for (const screen of canvas.screens) {
      if (group.screens.includes(screen.id)) {
        screen.x += dx
        screen.y += dy
      }
    }
    this.changed()
  }

  private dropGroup(canvas: StoredCanvas, group: CanvasGroup): void {
    canvas.groups = canvas.groups.filter((other) => other !== group)
    canvas.updatedAt = Date.now()
    this.changed()
  }

  private getGroup(
    canvasId: string,
    groupId: string
  ): { canvas: StoredCanvas; group: CanvasGroup } {
    const canvas = this.getCanvas(canvasId)
    const group = canvas.groups.find(({ id }) => id === groupId)
    if (!group) {
      throw new CanvasError('The group was not found.')
    }
    return { canvas, group }
  }

  private screenNamed(canvas: StoredCanvas, name: string): StoredScreen {
    const screen = findScreenByName(canvas.screens, name)
    if (!screen) {
      const names = canvas.screens.map((other) => `"${other.name}"`).join(', ') || 'none'
      throw new CanvasError(`There is no screen "${name.trim()}" on the canvas. Screens: ${names}.`)
    }
    return screen
  }

  /**
   * Находит на экране кнопки, от которых начинаются линии, и запоминает, где они. Зовётся,
   * когда линию поставили и когда экран изменился. Экран, который не открылся, оставляет
   * прежние места: линии не прыгают из-за случайного сбоя.
   */
  private async refreshAnchors(canvas: StoredCanvas, screen: StoredScreen): Promise<void> {
    const key = screenKey(canvas.id, screen.id)
    const previous = this.anchorJobs.get(key) ?? Promise.resolve()
    const job = previous
      .then(() => this.measureAnchors(canvas, screen))
      .catch((error) => {
        console.error('Failed to place the lines of a screen', error)
      })
    this.anchorJobs.set(key, job)
    try {
      await job
    } finally {
      if (this.anchorJobs.get(key) === job) {
        this.anchorJobs.delete(key)
      }
    }
  }

  private async measureAnchors(canvas: StoredCanvas, screen: StoredScreen): Promise<void> {
    const links = canvas.links.filter((link) => link.from === screen.id && link.on !== null)
    if (links.length === 0) {
      return
    }
    const key = screenKey(canvas.id, screen.id)
    if (screenSourceKind(screen.file) === 'react' && !this.builds.has(key)) {
      return
    }
    const found = await findScreenElements(
      canvasScreenUrl(canvas.id, screen.id, screen.revision),
      screen.width,
      screen.height,
      links.map((link) => link.on as string)
    )
    if (!found || !this.canvases.includes(canvas) || !canvas.screens.includes(screen)) {
      return
    }
    let changed = false
    links.forEach((link, index) => {
      const rect = found[index] ?? null
      const next = rect && {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      }
      if (JSON.stringify(next) !== JSON.stringify(link.anchor)) {
        link.anchor = next
        changed = true
      }
    })
    if (changed && canvas.links.some((link) => links.includes(link))) {
      this.changed()
    }
  }

  /**
   * Раскладывает экраны рядами по просьбе агента: каждый ряд — список имён слева направо, ряды
   * идут сверху вниз. Не названные экраны уходят отдельным рядом вниз: ни один не пропадает и
   * не накладывается на другой. Так агент собирает потоки (вход → код → регистрация) в ряды.
   */
  arrangeScreens(target: CanvasTarget, rows: readonly (readonly string[])[]): AgentArrangeResult {
    const canvas = this.agentCanvas(target)
    const placed = new Set<StoredScreen>()
    const named = rows
      .map((names) =>
        names.map((name) => {
          const screen = this.screenNamed(canvas, name)
          if (placed.has(screen)) {
            throw new CanvasError(`The screen "${screen.name}" is listed twice.`)
          }
          placed.add(screen)
          return screen
        })
      )
      .filter((row) => row.length > 0)
    if (named.length === 0) {
      throw new CanvasError('Name at least one screen to arrange.')
    }
    const rest = canvas.screens
      .filter((screen) => !placed.has(screen))
      .toSorted((a, b) => a.y - b.y || a.x - b.x)
    const places = arrangeRows(rest.length > 0 ? [...named, rest] : named)
    for (const [screen, { x, y }] of places) {
      screen.x = x
      screen.y = y
    }
    canvas.updatedAt = Date.now()
    this.changed()
    return {
      rows: named.length + (rest.length > 0 ? 1 : 0),
      screens: placed.size,
      rest: rest.map(({ name }) => name)
    }
  }

  /** Убирает экран с холста чата по имени; файл экрана остаётся в проекте. */
  async removeScreen(target: CanvasTarget, name: string): Promise<string> {
    const canvas = this.agentCanvas(target)
    const screen = findScreenByName(canvas.screens, name)
    if (!screen) {
      const names = canvas.screens.map((other) => `"${other.name}"`).join(', ') || 'none'
      throw new CanvasError(`There is no screen "${name.trim()}" on the canvas. Screens: ${names}.`)
    }
    await this.dropScreen(canvas, screen)
    return screen.name
  }

  /**
   * Публикует снимок холста чата по ссылке: страницы экранов в нынешнем виде, их места, группы и
   * линии на всех его страницах. Повторный вызов обновляет ту же ссылку.
   */
  async share(canvasId: string): Promise<CanvasShare> {
    return this.publish(this.getCanvas(canvasId).chatId)
  }

  async shareForAgent(target: CanvasTarget): Promise<CanvasShare> {
    // Ссылка общая для всех страниц, но страница, которую назвали, должна существовать.
    return this.publish(this.agentCanvas(target).chatId)
  }

  /**
   * Публикация холста чата. Пока она идёт, повторная просьба (вторая кнопка, агент) ждёт её же,
   * а не начинает вторую; окно видит, что холст публикуется, и после перехода по страницам.
   */
  private publish(chatId: string): Promise<CanvasShare> {
    const running = this.sharing.get(chatId)
    if (running) {
      return running
    }
    const job = this.runPublish(chatId).finally(() => {
      this.sharing.delete(chatId)
      this.services.onChange(this.state())
    })
    this.sharing.set(chatId, job)
    this.services.onChange(this.state())
    return job
  }

  private async runPublish(chatId: string): Promise<CanvasShare> {
    const pages = this.activeCanvasesOf(chatId).filter((page) => page.screens.length > 0)
    if (pages.length === 0) {
      throw new CanvasError('Put at least one screen on the canvas before sharing it.')
    }
    const screens = await this.renderForSharing(pages)
    const credentials = this.chatShareOf(chatId) ?? newShareCredentials()
    await publishShare(credentials, { canvas: sharedCanvas(chatId, pages, this.services), screens })
    const share = { ...credentials, publishedAt: Date.now() }
    for (const page of this.pagesOf(chatId)) {
      page.share = share
    }
    this.changed()
    return { url: shareUrl(share.id), publishedAt: share.publishedAt }
  }

  /**
   * Снимает каждый экран для сайта: статичную страницу без скриптов и картинку для обзора. Так
   * страница по ссылке лёгкая и на телефоне. Снимков идёт несколько сразу, но не все: каждый —
   * скрытое окно с экраном.
   */
  private async renderForSharing(
    canvasPages: readonly StoredCanvas[]
  ): Promise<Map<string, SharedScreenPage>> {
    const pages = new Map<string, SharedScreenPage>()
    const queue = canvasPages.flatMap((canvas) => canvas.screens.map((screen) => ({ canvas, screen })))
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const { canvas, screen } = item
        await this.queueCheck(screenKey(canvas.id, screen.id))
        const page = await renderScreenForSharing(
          canvasScreenUrl(canvas.id, screen.id, screen.revision),
          screen.width,
          screen.height
        )
        if (!page) {
          throw new CanvasError(
            `Could not render the screen "${screen.name}" for sharing. Check that it opens without errors and try again.`
          )
        }
        pages.set(screen.id, page)
      }
    }
    await Promise.all(Array.from({ length: SHARE_RENDER_CONCURRENCY }, worker))
    return pages
  }

  /** Закрывает ссылку: страница по ней перестаёт открываться. Не вышло закрыть — ссылка остаётся. */
  async unshare(canvasId: string): Promise<void> {
    await this.closeShare(this.getCanvas(canvasId).chatId)
  }

  async unshareForAgent(target: CanvasTarget): Promise<void> {
    await this.closeShare(this.agentCanvas(target).chatId)
  }

  private async closeShare(chatId: string): Promise<void> {
    const share = this.chatShareOf(chatId)
    if (share) {
      await unpublishShare(share)
      for (const page of this.pagesOf(chatId)) {
        page.share = null
      }
      this.changed()
    }
  }

  /** Убирает экран с холста по просьбе человека; файл экрана остаётся в проекте. */
  async removeScreenById(canvasId: string, screenId: string): Promise<void> {
    const { canvas, screen } = this.getScreen(canvasId, screenId)
    await this.dropScreen(canvas, screen)
  }

  private async dropScreen(canvas: StoredCanvas, screen: StoredScreen): Promise<void> {
    this.watcher.unwatch(screenKey(canvas.id, screen.id))
    this.forgetOutput(screenKey(canvas.id, screen.id))
    canvas.screens = canvas.screens.filter((other) => other !== screen)
    canvas.links = canvas.links.filter(({ from, to }) => from !== screen.id && to !== screen.id)
    canvas.groups = canvas.groups
      .map((group) => ({
        ...group,
        screens: group.screens.filter((id) => id !== screen.id)
      }))
      .filter(({ screens }) => screens.length > 0)
    canvas.updatedAt = Date.now()
    this.changed()
    await this.snapshots
      .removeScreen(canvas.id, screen.id)
      .catch((error) => console.error('Failed to remove the screen history', error))
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  dispose(): void {
    this.watcher.dispose()
  }

  /** Открывает экран в скрытом окне; экран, который не собрался ни разу, не открывается. */
  private async inspect(canvas: StoredCanvas, screen: StoredScreen) {
    const key = screenKey(canvas.id, screen.id)
    const built = screenSourceKind(screen.file) !== 'react' || this.builds.has(key)
    return built
      ? inspectScreen(
          canvasScreenUrl(canvas.id, screen.id, screen.revision),
          screen.width,
          screen.height
        )
      : null
  }

  private forgetOutput(key: string): void {
    this.builds.delete(key)
    this.outputs.delete(key)
  }

  private render(canvas: StoredCanvas, screen: StoredScreen): Promise<ScreenRender | null> {
    return captureScreen(
      canvasScreenUrl(canvas.id, screen.id, screen.revision),
      screen.width,
      screen.height
    )
  }

  private addCanvas(owner: ChatLocation | CanvasOwner, name?: string): StoredCanvas {
    const now = Date.now()
    const { project } = owner
    const chatId = 'chat' in owner ? owner.chat.id : owner.chatId
    const canvas: StoredCanvas = {
      id: randomUUID(),
      name: name ?? ('chat' in owner ? canvasNameFromTitle(owner.chat.title) : DEFAULT_PAGE_NAME),
      chatId,
      projectId: project.id,
      screens: [],
      links: [],
      groups: [],
      // Новая страница получает ссылку холста; в снимок она попадёт при следующем обновлении.
      share: this.chatShareOf(chatId),
      archived: false,
      view: null,
      createdAt: now,
      updatedAt: now
    }
    // Холст чата в архиве целиком или нет: страница, которую добавили к холсту в архиве,
    // возвращает его.
    const archivedPage = this.pagesOf(chatId).find((page) => page.archived)
    if (archivedPage) {
      this.archive(archivedPage.id, false)
    }
    this.canvases.push(canvas)
    return canvas
  }

  /** Чат, которому уходят просьбы холста; удалённый или архивный — ошибка, понятная человеку. */
  private chatOf(canvas: StoredCanvas): string {
    if (this.services.store.findChat(canvas.chatId)) {
      return canvas.chatId
    }
    if (isStandaloneCanvas(canvas)) {
      throw new CanvasError(
        'This canvas has no chat yet. Link it to a chat or start an agent from the canvas.'
      )
    }
    throw new CanvasError(
      this.services.store.findArchivedChat(canvas.chatId)
        ? 'The chat of this canvas is archived. Restore the chat to send requests.'
        : 'The chat of this canvas was deleted, so there is no agent to send this to.'
    )
  }

  /**
   * Кому принадлежит новая страница холста: чату, а у холста без чата — его ключу и проекту
   * его страниц.
   */
  private ownerOf(chatId: string, page: StoredCanvas | undefined): ChatLocation | CanvasOwner {
    const location = this.services.store.findChat(chatId)
    if (location) {
      return location
    }
    const project = page && this.services.store.findProject(page.projectId)
    if (page && project && isStandaloneCanvas(page)) {
      return { project, chatId }
    }
    throw new CanvasError('The chat was not found.')
  }

  private activeCanvasesOf(chatId: string): StoredCanvas[] {
    return this.canvases.filter((canvas) => canvas.chatId === chatId && !canvas.archived)
  }

  /** Все страницы холста чата, в их порядке. */
  private pagesOf(chatId: string): StoredCanvas[] {
    return this.canvases.filter((canvas) => canvas.chatId === chatId)
  }

  /** Ссылка холста чата: она одна на все страницы и записана у каждой. */
  private chatShareOf(chatId: string): StoredShare | null {
    return this.pagesOf(chatId).find((page) => page.share)?.share ?? null
  }

  /**
   * Холст чата для команды агента. Задано имя — холст с этим именем, нет такого — ошибка со
   * списком. Имени нет — единственный холст чата; их несколько — просим назвать, чтобы экраны
   * не попали не на тот холст; ни одного — `undefined`.
   */
  private canvasOf({ chatId, canvas: name }: CanvasTarget): StoredCanvas | undefined {
    const own = this.activeCanvasesOf(chatId)
    const names = own.map((canvas) => `“${canvas.name}”`).join(', ')
    if (name === undefined) {
      if (own.length > 1) {
        throw new CanvasError(
          `This chat has several canvas pages: ${names}. Specify one with --page "<name>".`
        )
      }
      return own[0]
    }
    const found = findCanvasByName(own, name)
    if (!found) {
      throw new CanvasError(
        own.length > 0
          ? `This chat has no canvas page “${name.trim()}”. Its pages: ${names}.`
          : `This chat has no canvas page “${name.trim()}”. Create it with: atox canvas new "<name>".`
      )
    }
    return found
  }

  /** Как `canvasOf`, но холст обязан быть. */
  private agentCanvas(target: CanvasTarget): StoredCanvas {
    const canvas = this.canvasOf(target)
    if (!canvas) {
      throw new CanvasError(
        'This chat has no canvas. Put a screen on it first, or add a page: atox canvas new "<name>".'
      )
    }
    return canvas
  }

  private getCanvas(canvasId: string): StoredCanvas {
    const canvas = this.canvases.find(({ id }) => id === canvasId)
    if (!canvas) {
      throw new CanvasError('The canvas was not found.')
    }
    return canvas
  }

  private findScreen(canvasId: string, screenId: string): ScreenLocation | undefined {
    const canvas = this.canvases.find(({ id }) => id === canvasId)
    const screen = canvas?.screens.find(({ id }) => id === screenId)
    return canvas && screen ? { canvas, screen } : undefined
  }

  private getScreen(canvasId: string, screenId: string): ScreenLocation {
    this.getCanvas(canvasId)
    const location = this.findScreen(canvasId, screenId)
    if (!location) {
      throw new CanvasError('The screen was not found.')
    }
    return location
  }

  private watchCanvas(canvas: StoredCanvas): void {
    for (const screen of canvas.screens) {
      const key = screenKey(canvas.id, screen.id)
      this.watcher.watch(key, [screen.file])
      void this.queueCheck(key)
    }
  }

  private unwatchCanvas(canvas: StoredCanvas): void {
    for (const screen of canvas.screens) {
      const key = screenKey(canvas.id, screen.id)
      this.watcher.unwatch(key)
      this.forgetOutput(key)
    }
  }

  private queueCheck(key: string): Promise<void> {
    const next = (this.checks.get(key) ?? Promise.resolve())
      .then(() => this.check(key))
      .catch((error) => console.error('Failed to check a canvas screen', error))
    this.checks.set(key, next)
    void next.finally(() => {
      if (this.checks.get(key) === next) {
        this.checks.delete(key)
      }
    })
    return next
  }

  /**
   * Сверяет файл экрана с тем, что показывает холст. У экрана-React сначала собирается
   * файл вместе с импортами: пока сборка не удалась, холст остаётся на прежней сборке,
   * а ошибка попадает в `buildError`. Изменился файл экрана — появляется версия; изменился
   * только импорт — меняется ревизия (экран перезагружается), версия не нужна.
   */
  private async check(key: string): Promise<void> {
    const location = this.findScreenByKey(key)
    if (!location) {
      return
    }
    const { canvas, screen } = location
    const content = await readScreenFile(screen.file)
    if (this.findScreenByKey(key)?.screen !== screen) {
      return
    }
    if (content === null) {
      this.restoring.delete(key)
      if (!screen.missing) {
        screen.missing = true
        this.changed()
      }
      return
    }
    const hash = contentHash(content)
    const output = await this.compile(key, canvas, screen, content)
    if (this.findScreenByKey(key)?.screen !== screen) {
      return
    }
    if (output === null) {
      this.restoring.delete(key)
      return
    }
    const latest = screen.versions.at(-1)
    const previous = this.outputs.get(key)
    this.outputs.set(key, output)
    const fileChanged = latest?.hash !== hash
    const outputChanged = previous !== undefined && previous !== output
    if (!fileChanged && !outputChanged) {
      this.restoring.delete(key)
      if (screen.missing) {
        screen.missing = false
        this.changed()
      }
      return
    }
    // Версия пишется, когда изменился файл экрана или за ним стоит просьба «Fix»: так просьба
    // остаётся в истории, даже если агент правил только импортированный компонент.
    const record = fileChanged || screen.pendingFix !== undefined
    if (record) {
      await this.snapshots.save(canvas.id, screen.id, hash, content)
      if (this.findScreenByKey(key)?.screen !== screen) {
        // Экран удалили, пока писался снимок: его история не должна остаться на диске.
        await (this.canvases.includes(canvas)
          ? this.snapshots.removeScreen(canvas.id, screen.id)
          : this.snapshots.removeCanvas(canvas.id))
        return
      }
    }
    const cause = this.restoring.delete(key) ? 'restore' : latest ? 'edit' : 'created'
    this.addVersion(canvas, screen, record ? { hash, cause } : null)
  }

  /**
   * Собирает экран-React и берёт под слежку всё, что он импортирует. Возвращает хеш того,
   * что экран показывает; `null` — сборка не удалась (ошибка записана в экран).
   */
  private async compile(
    key: string,
    canvas: StoredCanvas,
    screen: StoredScreen,
    content: string
  ): Promise<string | null> {
    if (screenSourceKind(screen.file) !== 'react') {
      this.setBuildError(screen, null)
      return contentHash(content)
    }
    try {
      const build = await buildScreen(this.buildRequest(canvas, screen, content))
      this.builds.set(key, build)
      this.watcher.watch(key, build.inputs)
      this.setBuildError(screen, null)
      return contentHash(`${build.js}\n${build.css}`)
    } catch (error) {
      if (error instanceof ScreenBuildError) {
        this.watcher.watch(key, [screen.file, ...error.inputs])
      } else {
        console.error('Failed to build a canvas screen', error)
      }
      this.setBuildError(
        screen,
        error instanceof ScreenBuildError ? error.message : 'The screen could not be built.'
      )
      return null
    }
  }

  private setBuildError(screen: StoredScreen, buildError: string | null): void {
    if (screen.buildError !== buildError) {
      screen.buildError = buildError
      this.changed()
    }
  }

  /** Новый вид экрана: ревизия растёт, версия — по `version`; `null` — версию не писать. */
  private addVersion(
    canvas: StoredCanvas,
    screen: StoredScreen,
    version: { hash: string; cause: ScreenVersion['cause'] } | null
  ): void {
    const now = Date.now()
    let dropped: StoredVersion[] = []
    if (version) {
      const fix = version.cause === 'edit' ? screen.pendingFix : undefined
      if (fix !== undefined) {
        delete screen.pendingFix
      }
      const entry: StoredVersion = {
        id: randomUUID(),
        savedAt: now,
        cause: version.cause,
        hash: version.hash,
        ...(fix && { fix })
      }
      const appended = appendVersion(screen.versions, entry, SCREEN_HISTORY_LIMIT)
      screen.versions = appended.versions
      dropped = appended.dropped
    }
    screen.missing = false
    screen.revision += 1
    screen.updatedAt = now
    canvas.updatedAt = now
    this.changed()
    // Экран изменился — кнопки могли сдвинуться, и линии от них идут по новым местам.
    void this.refreshAnchors(canvas, screen)
    const kept = new Set(screen.versions.map(({ hash }) => hash))
    const unused = new Set(dropped.map(({ hash }) => hash).filter((hash) => !kept.has(hash)))
    if (unused.size > 0) {
      void this.snapshots
        .remove(canvas.id, screen.id, unused)
        .catch((error) => console.error('Failed to remove old screen versions', error))
    }
  }

  private findScreenByKey(key: string): ScreenLocation | undefined {
    const [canvasId = '', screenId = ''] = key.split('/')
    return this.findScreen(canvasId, screenId)
  }

  private persist(): void {
    const data: CanvasFile = {
      version: CANVAS_FILE_VERSION,
      canvases: this.canvases
    }
    this.file.write(data)
  }

  /** Сохраняет холсты и сообщает окну новое состояние. */
  private changed(): void {
    this.persist()
    this.services.onChange(this.state())
  }
}

/** Элемент линии: пробелы по краям убираются, пустое — «не задано». */
/** Холст чата для страницы просмотра: его страницы и что видно на них, без путей к файлам. */
function sharedCanvas(
  chatId: string,
  pages: readonly StoredCanvas[],
  { store }: Pick<CanvasServices, 'store'>
): SharedCanvas {
  return {
    name: canvasNameFromTitle(store.findChat(chatId)?.chat.title ?? pages[0]?.name ?? ''),
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      screens: page.screens.map((screen) => ({
        id: screen.id,
        name: screen.name,
        device: screen.device,
        frame: screenFrameOf(screen),
        width: screen.width,
        height: screen.height,
        x: screen.x,
        y: screen.y,
        revision: screen.revision
      })),
      groups: page.groups,
      links: page.links.map(({ id, from, to, anchor }) => ({ id, from, to, anchor }))
    }))
  }
}

function linkText(value: string | undefined, max: number, subject: string): string | null {
  const text = value?.trim() ?? ''
  if (text.length > max) {
    throw new CanvasError(`The line ${subject} is longer than ${max} characters.`)
  }
  return text || null
}

function screenKey(canvasId: string, screenId: string): string {
  return `${canvasId}/${screenId}`
}

function deviceLook(device: ScreenDeviceId): {
  device: ScreenDevice
  width: number
  height: number
} {
  const { width, height } = SCREEN_DEVICES[device]
  return { device, width, height }
}

function parseDevice(value: string): ScreenDeviceId {
  if (!isScreenDeviceId(value)) {
    throw new CanvasError(
      `Unknown device "${value}". Use one of: ${Object.keys(SCREEN_DEVICES).join(', ')}.`
    )
  }
  return value
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Содержимое файла экрана; `null` — файла нет, он не читается или слишком велик. */
async function readScreenFile(file: string): Promise<string | null> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > SCREEN_FILE_MAX_BYTES) {
      return null
    }
    return await readFile(file, 'utf-8')
  } catch {
    return null
  }
}

/** Что агент слышит, если файл не годится в экран. */
function notAScreenFile(file: string): CanvasError {
  return new CanvasError(
    `${file} is not a screen file. A screen is a .tsx or .jsx file with a default-exported React component, or one self-contained .html file.`
  )
}

/**
 * Проверяет файл, который агент ставит на холст, и возвращает его настоящий путь (без
 * символических ссылок). Файл должен быть экраном (React или HTML) разумного размера внутри
 * папки чата: холст не показывает файлы вне проекта.
 */
async function verifyScreenFile(file: string, folders: readonly string[]): Promise<string> {
  if (!isAbsolute(file) || !isScreenFileName(file)) {
    throw notAScreenFile(file)
  }
  const real = await realpath(file).catch(() => {
    throw new CanvasError(
      `File not found: ${file}. Write the screen file first, then run this command.`
    )
  })
  const info = await stat(real)
  if (!info.isFile() || !isScreenFileName(real)) {
    throw notAScreenFile(file)
  }
  if (info.size > SCREEN_FILE_MAX_BYTES) {
    throw new CanvasError(
      `${file} is larger than ${SCREEN_FILE_MAX_MB} MB. Keep the file light: inline SVG instead of embedded photos, split code into imported files.`
    )
  }
  const roots = await Promise.all(folders.map((folder) => realpath(folder).catch(() => null)))
  if (!roots.some((root) => root !== null && isInsideFolder(real, root))) {
    throw new CanvasError(
      `${file} is outside this chat's project folder (${folders[0]}). Put screen files inside the project, for example .atox/canvas/${basename(file)}.`
    )
  }
  return real
}

/**
 * Записывает файл через временный рядом с ним: агент или редактор не прочитают его
 * наполовину записанным. Папку файла создаёт, если её удалили.
 */
async function writeFileAtomically(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`)
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(content, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
}

/** Размер пустого экрана из окна: устройство из списка или свой размер с рамкой. */
function parseScreenLook(value: unknown): BlankLook {
  const look = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const device = look['device']
  if (isScreenDeviceId(device)) {
    return deviceLook(device)
  }
  if (device !== 'custom') {
    throw new CanvasError('Choose a device or a custom size for the screen.')
  }
  const { width, height, frame } = look
  if (!isScreenDimension(width) || !isScreenDimension(height)) {
    throw new CanvasError(
      `The width and height must be whole numbers from ${SCREEN_SIZE.min} to ${SCREEN_SIZE.max}.`
    )
  }
  return {
    device: 'custom',
    width,
    height,
    ...(isScreenFrame(frame) && frame !== 'none' && { frame })
  }
}

/** Пустая страница экрана: белый лист нужного размера, который агент потом заменит своим файлом. */
function blankScreenHtml(look: BlankLook): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=${look.width}" />
    <title>Blank screen</title>
    <style>html, body { margin: 0; height: 100%; background: #fff; }</style>
  </head>
  <body></body>
</html>
`
}

/**
 * Пишет пустой экран в папку `.atox/canvas` проекта (там же агент держит свои экраны) под
 * свободным именем: чужие файлы не перезаписываются. Возвращает настоящий путь файла.
 */
async function writeBlankScreenFile(
  projectPath: string,
  title: string,
  look: BlankLook
): Promise<string> {
  const folder = join(projectPath, '.atox', 'canvas')
  try {
    await mkdir(folder, { recursive: true })
  } catch (error) {
    console.error('Failed to create the canvas folder', error)
    throw new CanvasError(`Could not create ${folder}.`)
  }
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'screen'
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const file = join(folder, attempt === 1 ? `${slug}.html` : `${slug}-${attempt}.html`)
    const exists = await access(file).then(
      () => true,
      () => false
    )
    if (exists) {
      continue
    }
    try {
      await writeFileAtomically(file, blankScreenHtml(look))
    } catch (error) {
      console.error('Failed to write a blank canvas screen', error)
      throw new CanvasError(`Could not write ${file}.`)
    }
    return realpath(file)
  }
  throw new CanvasError(`Could not find a free file name in ${folder}.`)
}

/** Сетка экрана для агента: включена ли и на сколько равных частей делит экран. */
function gridInfoOf(screen: StoredScreen): CanvasScreenGridInfo {
  const { visible, columns, rows } = effectiveScreenGrid(screen)
  return { visible, columns, rows }
}

/** Новый размер экрана из панели: устройство из списка или свой размер (рамку берёт экран). */
function parseResizeLook(
  value: unknown
): { device: ScreenDeviceId } | { device: 'custom'; width: number; height: number } {
  const look = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const device = look['device']
  if (isScreenDeviceId(device)) {
    return { device }
  }
  const { width, height } = look
  if (device !== 'custom' || !isScreenDimension(width) || !isScreenDimension(height)) {
    throw new CanvasError(
      `The width and height must be whole numbers from ${SCREEN_SIZE.min} to ${SCREEN_SIZE.max}.`
    )
  }
  return { device: 'custom', width, height }
}
