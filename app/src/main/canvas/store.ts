import { isAbsolute } from 'node:path'
import {
  CANVAS_GROUPS_MAX,
  CANVAS_LINKS_MAX,
  CANVAS_NAME_MAX_LENGTH,
  CANVAS_ZOOM,
  LINK_ON_MAX_LENGTH,
  SCREEN_DEVICES,
  SCREEN_GRID_DEFAULT_PARTS,
  SCREEN_HISTORY_LIMIT,
  isScreenDeviceId,
  isScreenFrame,
  isScreenGrid,
  nearestScreenGridParts,
  type Canvas,
  type CanvasGroup,
  type CanvasLink,
  type CanvasScreen,
  type LinkAnchor,
  type CanvasView,
  type ScreenDevice,
  type ScreenGrid,
  type ScreenVersion
} from '../../shared/canvas'
import { DEFAULT_CANVAS_NAME, isScreenDimension, isScreenFileName } from './rules'
import { shareUrl, type ShareCredentials } from './share'

export const CANVAS_FILE_VERSION = 1

/** Версия экрана на диске: `hash` — имя снимка её HTML в папке истории. */
export interface StoredVersion extends ScreenVersion {
  hash: string
}

export interface StoredScreen extends CanvasScreen {
  /** Версии от старой к новой; последняя — то, что сейчас показывает холст. */
  versions: StoredVersion[]
  /** Просьба «Fix», отправленная агенту: её получит следующая версия экрана. */
  pendingFix?: string
}

/** Публикация холста: адрес ссылки и секрет, по которому её обновляют и закрывают. */
export interface StoredShare extends ShareCredentials {
  publishedAt: number
}

export interface StoredCanvas extends Omit<Canvas, 'screens' | 'share'> {
  screens: StoredScreen[]
  share: StoredShare | null
}

export interface CanvasFile {
  version: typeof CANVAS_FILE_VERSION
  canvases: StoredCanvas[]
}

/** Id холстов и экранов становятся именами папок истории: только безопасные символы. */
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/

/** Снимок версии называется sha-256 его содержимого. */
const HASH_PATTERN = /^[0-9a-f]{64}$/

const VERSION_CAUSES = new Set<ScreenVersion['cause']>(['created', 'edit', 'restore'])

export function isCanvasId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/** Холст или экран без внутренних полей — то, что видит окно. */
export function publicCanvas({ screens, share, ...canvas }: StoredCanvas): Canvas {
  return {
    ...canvas,
    screens: screens.map(({ versions: _versions, pendingFix: _pendingFix, ...screen }) => screen),
    share: share && { url: shareUrl(share.id), publishedAt: share.publishedAt }
  }
}

/**
 * Страницы из файла, который мог поправить человек: неверные записи отбрасываются или
 * чинятся, а не роняют приложение. Страницы удалённых проектов не загружаются. Холст чата
 * в архиве целиком или нет: есть страница вне архива — остальные возвращаются из него, ничего
 * не теряется. Ссылка холста одна на чат: её получают все его страницы.
 */
export function normalizeCanvases(
  data: Partial<CanvasFile> | undefined,
  projectIds: ReadonlySet<string>,
  now: number
): StoredCanvas[] {
  const canvases: StoredCanvas[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(data?.canvases) ? data.canvases : []) {
    const canvas = normalizeCanvas(raw, now)
    if (!canvas || seen.has(canvas.id) || !projectIds.has(canvas.projectId)) {
      continue
    }
    seen.add(canvas.id)
    canvases.push(canvas)
  }
  const active = new Set(canvases.filter(({ archived }) => !archived).map(({ chatId }) => chatId))
  const shares = new Map<string, StoredShare>()
  for (const canvas of canvases) {
    if (canvas.share && !shares.has(canvas.chatId)) {
      shares.set(canvas.chatId, canvas.share)
    }
  }
  for (const canvas of canvases) {
    canvas.archived = !active.has(canvas.chatId)
    canvas.share = shares.get(canvas.chatId) ?? null
  }
  return canvases
}

function normalizeCanvas(raw: unknown, now: number): StoredCanvas | null {
  const value = record(raw)
  if (
    !isCanvasId(value['id']) ||
    typeof value['chatId'] !== 'string' ||
    typeof value['projectId'] !== 'string'
  ) {
    return null
  }
  const screens: StoredScreen[] = []
  const screenIds = new Set<string>()
  for (const rawScreen of Array.isArray(value['screens']) ? value['screens'] : []) {
    const screen = normalizeScreen(rawScreen, now)
    if (screen && !screenIds.has(screen.id)) {
      screenIds.add(screen.id)
      screens.push(screen)
    }
  }
  return {
    id: value['id'],
    name: normalizedName(value['name']) ?? DEFAULT_CANVAS_NAME,
    chatId: value['chatId'],
    projectId: value['projectId'],
    screens,
    links: normalizeLinks(value['links'], screenIds),
    groups: normalizeGroups(value['groups'], screenIds),
    share: normalizeShare(value['share'], now),
    archived: value['archived'] === true,
    view: normalizeView(value['view']),
    createdAt: timestamp(value['createdAt'], now),
    updatedAt: timestamp(value['updatedAt'], now)
  }
}

function normalizeLinks(raw: unknown, screenIds: ReadonlySet<string>): CanvasLink[] {
  const links: CanvasLink[] = []
  const ids = new Set<string>()
  for (const item of Array.isArray(raw) ? raw : []) {
    const value = record(item)
    const { id, from, to } = value
    if (
      !isCanvasId(id) ||
      ids.has(id) ||
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      from === to ||
      !screenIds.has(from) ||
      !screenIds.has(to)
    ) {
      continue
    }
    ids.add(id)
    links.push({
      id,
      from,
      to,
      on: boundedText(value['on'], LINK_ON_MAX_LENGTH),
      anchor: normalizeAnchor(value['anchor'])
    })
    if (links.length >= CANVAS_LINKS_MAX) {
      break
    }
  }
  return links
}

function normalizeShare(raw: unknown, now: number): StoredShare | null {
  const { id, token, publishedAt } = record(raw)
  return typeof id === 'string' &&
    /^[\w-]{16,64}$/.test(id) &&
    typeof token === 'string' &&
    /^\S{20,200}$/.test(token)
    ? { id, token, publishedAt: timestamp(publishedAt, now) }
    : null
}

/** Группы из файла: экран входит не больше чем в одну, пустые группы и повторы имён отпадают. */
function normalizeGroups(raw: unknown, screenIds: ReadonlySet<string>): CanvasGroup[] {
  const groups: CanvasGroup[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  const grouped = new Set<string>()
  for (const item of Array.isArray(raw) ? raw : []) {
    const value = record(item)
    const name = normalizedName(value['name'])
    if (
      !isCanvasId(value['id']) ||
      ids.has(value['id']) ||
      !name ||
      names.has(name.toLowerCase())
    ) {
      continue
    }
    const screens = (Array.isArray(value['screens']) ? value['screens'] : []).filter(
      (id): id is string => typeof id === 'string' && screenIds.has(id) && !grouped.has(id)
    )
    const members = [...new Set(screens)]
    if (members.length === 0) {
      continue
    }
    ids.add(value['id'])
    names.add(name.toLowerCase())
    members.forEach((id) => grouped.add(id))
    groups.push({ id: value['id'], name, screens: members })
    if (groups.length >= CANVAS_GROUPS_MAX) {
      break
    }
  }
  return groups
}

function boundedText(value: unknown, max: number): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, max) : null
}

function normalizeAnchor(raw: unknown): LinkAnchor | null {
  const value = record(raw)
  const { x, y, width, height } = value
  return [x, y, width, height].every((part) => typeof part === 'number' && Number.isFinite(part)) &&
    (width as number) > 0 &&
    (height as number) > 0
    ? {
        x: x as number,
        y: y as number,
        width: width as number,
        height: height as number
      }
    : null
}

function normalizeScreen(raw: unknown, now: number): StoredScreen | null {
  const value = record(raw)
  const name = normalizedName(value['name'])
  const file = value['file']
  if (
    !isCanvasId(value['id']) ||
    !name ||
    typeof file !== 'string' ||
    !isAbsolute(file) ||
    !isScreenFileName(file)
  ) {
    return null
  }
  const size = normalizeSize(value['device'], value['width'], value['height'])
  const frame = value['frame']
  const versions = (Array.isArray(value['versions']) ? value['versions'] : [])
    .map(normalizeVersion)
    .filter((version) => version !== null)
    .slice(-SCREEN_HISTORY_LIMIT)
  const revision = value['revision']
  const pendingFix = value['pendingFix']
  const grid = value['grid']
  return {
    id: value['id'],
    name,
    ...size,
    ...(size.device === 'custom' && isScreenFrame(frame) && frame !== 'none' && { frame }),
    ...(normalizeGrid(grid, size.width, size.height) ?? {}),
    file,
    x: finite(value['x']),
    y: finite(value['y']),
    revision:
      typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0 ? revision : 0,
    missing: value['missing'] === true,
    buildError: null,
    updatedAt: timestamp(value['updatedAt'], now),
    versions,
    ...(typeof pendingFix === 'string' && pendingFix.trim() && { pendingFix })
  }
}

/**
 * Сетка экрана из файла. Раньше хранилась квадратная клетка (`cell`, px) или только число
 * столбцов (`columns`, любое): они переводятся в ближайшее верное число равных частей, а что не
 * разобрать — в сетку по умолчанию.
 */
function normalizeGrid(raw: unknown, width: number, height: number): { grid: ScreenGrid } | null {
  if (isScreenGrid(raw)) {
    return { grid: { visible: raw.visible, columns: raw.columns, rows: raw.rows } }
  }
  const value = record(raw)
  const visible = value['visible']
  if (typeof visible !== 'boolean') {
    return null
  }
  const positive = (number: unknown): number | null =>
    typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null
  const cell = positive(value['cell'])
  const columns = positive(value['columns'])
  const rows = positive(value['rows'])
  if (cell !== null) {
    return {
      grid: {
        visible,
        columns: nearestScreenGridParts(width / cell),
        rows: nearestScreenGridParts(height / cell)
      }
    }
  }
  return {
    grid: {
      visible,
      columns: columns === null ? SCREEN_GRID_DEFAULT_PARTS : nearestScreenGridParts(columns),
      rows: nearestScreenGridParts(rows ?? columns ?? SCREEN_GRID_DEFAULT_PARTS)
    }
  }
}

/** Размер устройства из списка всегда берётся из списка: его могли поменять в новой версии. */
function normalizeSize(
  device: unknown,
  width: unknown,
  height: unknown
): { device: ScreenDevice; width: number; height: number } {
  if (isScreenDeviceId(device)) {
    const preset = SCREEN_DEVICES[device]
    return { device, width: preset.width, height: preset.height }
  }
  if (isScreenDimension(width) && isScreenDimension(height)) {
    return { device: 'custom', width, height }
  }
  const fallback = SCREEN_DEVICES.web
  return { device: 'web', width: fallback.width, height: fallback.height }
}

function normalizeVersion(raw: unknown): StoredVersion | null {
  const value = record(raw)
  const cause = value['cause'] as ScreenVersion['cause']
  const fix = value['fix']
  if (
    typeof value['id'] !== 'string' ||
    typeof value['savedAt'] !== 'number' ||
    !Number.isFinite(value['savedAt']) ||
    !VERSION_CAUSES.has(cause) ||
    typeof value['hash'] !== 'string' ||
    !HASH_PATTERN.test(value['hash'])
  ) {
    return null
  }
  return {
    id: value['id'],
    savedAt: value['savedAt'],
    cause,
    hash: value['hash'],
    ...(typeof fix === 'string' && fix && { fix })
  }
}

/** Вид холста: числа конечные, масштаб в допустимых пределах; иначе вида нет. */
export function normalizeView(raw: unknown): CanvasView | null {
  const { x, y, zoom } = record(raw)
  if (![x, y, zoom].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null
  }
  return {
    x: x as number,
    y: y as number,
    zoom: Math.min(CANVAS_ZOOM.max, Math.max(CANVAS_ZOOM.min, zoom as number))
  }
}

function normalizedName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim().slice(0, CANVAS_NAME_MAX_LENGTH).trim() : ''
  return name || null
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function timestamp(value: unknown, now: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : now
}
