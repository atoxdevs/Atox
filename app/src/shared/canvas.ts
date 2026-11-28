/**
 * Холст чата: у чата он один, а в нём несколько страниц (как страницы в Figma): на каждой свои
 * экраны, группы и линии. Запись `Canvas` ниже — одна такая страница; страницы чата — это все его
 * записи `Canvas`. Холст можно создать и без чата: тогда человек сам ставит пустые экраны, а чат
 * привязывает позже. Страница — это место, где агент показывает экраны — приложение на телефоне, сайт,
 * программу для компьютера. Холст привязан к чату и к его проекту. Экраны рисует только агент
 * (HTML-файлом в проекте, командой `atox canvas`); человек двигает их, называет и увеличивает.
 * Клик по экрану открывает окно «Fix»: текст и скриншот экрана уходят в чат холста.
 */

/** Рамка, в которую окно рисует экран. */
export type ScreenFrame = 'phone' | 'tablet' | 'window' | 'browser' | 'none'

/** Раздел, в котором устройство стоит в окне выбора размера. */
export type DeviceCategory = 'desktop' | 'phone' | 'tablet' | 'document'

export interface DevicePreset {
  name: string
  /** Размер экрана в CSS-пикселях: так его видит HTML. */
  width: number
  height: number
  frame: ScreenFrame
  category: DeviceCategory
}

/**
 * Устройства, которые агент называет в `atox canvas screen set --device`, а человек выбирает,
 * создавая холст или пустой экран. Id уже записаны в холстах: их нельзя менять, только добавлять.
 */
export const SCREEN_DEVICES = {
  iphone: { name: 'iPhone', width: 390, height: 844, frame: 'phone', category: 'phone' },
  'iphone-se': { name: 'iPhone SE', width: 375, height: 667, frame: 'phone', category: 'phone' },
  'iphone-16': {
    name: 'iPhone 15/16',
    width: 393,
    height: 852,
    frame: 'phone',
    category: 'phone'
  },
  'iphone-pro-max': {
    name: 'iPhone Pro Max',
    width: 430,
    height: 932,
    frame: 'phone',
    category: 'phone'
  },
  'android-compact': {
    name: 'Android compact',
    width: 360,
    height: 800,
    frame: 'phone',
    category: 'phone'
  },
  android: { name: 'Android', width: 412, height: 915, frame: 'phone', category: 'phone' },
  'ipad-mini': { name: 'iPad mini', width: 744, height: 1133, frame: 'tablet', category: 'tablet' },
  tablet: { name: 'Tablet', width: 820, height: 1180, frame: 'tablet', category: 'tablet' },
  'ipad-pro': { name: 'iPad Pro', width: 1024, height: 1366, frame: 'tablet', category: 'tablet' },
  desktop: { name: 'Desktop app', width: 1100, height: 700, frame: 'window', category: 'desktop' },
  web: { name: 'Website', width: 1280, height: 800, frame: 'browser', category: 'desktop' },
  'web-1366': {
    name: 'Laptop HD',
    width: 1366,
    height: 768,
    frame: 'browser',
    category: 'desktop'
  },
  'web-1440': {
    name: 'MacBook Air',
    width: 1440,
    height: 900,
    frame: 'browser',
    category: 'desktop'
  },
  'web-1536': {
    name: 'Laptop 1536',
    width: 1536,
    height: 864,
    frame: 'browser',
    category: 'desktop'
  },
  'web-1920': {
    name: 'Full HD',
    width: 1920,
    height: 1080,
    frame: 'browser',
    category: 'desktop'
  },
  'web-2560': { name: 'QHD', width: 2560, height: 1440, frame: 'browser', category: 'desktop' },
  // Для презентаций и документов: без рамки, чтобы экран был ровно страницей.
  slide: { name: 'Slide', width: 1920, height: 1080, frame: 'none', category: 'document' },
  a4: { name: 'A4 page', width: 794, height: 1123, frame: 'none', category: 'document' }
} as const satisfies Record<string, DevicePreset>

export type ScreenDeviceId = keyof typeof SCREEN_DEVICES

/** Устройство экрана: из списка или свой размер. */
export type ScreenDevice = ScreenDeviceId | 'custom'

export const DEFAULT_SCREEN_DEVICE: ScreenDeviceId = 'iphone'

export function isScreenDeviceId(value: unknown): value is ScreenDeviceId {
  return typeof value === 'string' && Object.hasOwn(SCREEN_DEVICES, value)
}

/** Устройства раздела в порядке списка. */
export function devicesOf(category: DeviceCategory): ScreenDeviceId[] {
  return (Object.keys(SCREEN_DEVICES) as ScreenDeviceId[]).filter(
    (id) => SCREEN_DEVICES[id].category === category
  )
}

/** Свой размер экрана в пикселях: меньше не видно, больше тянет память. */
export const SCREEN_SIZE = { min: 120, max: 4000 } as const

/**
 * Сетка поверх экрана — инструмент человека на холсте, как направляющие в макете дизайнера:
 * делит экран на N равных частей по ширине и M по высоте (линия k — ровно на k/N ширины и k/M
 * высоты), центральный крест выделен. Части не обязаны быть квадратными и не зависят от размера
 * экрана. Рисуется над iframe и никогда не меняет страницу (не попадает в файл экрана, выгрузку,
 * ссылку и миниатюры). Агент видит сетку в `atox canvas` и выравнивает по ней блоки.
 */
export interface ScreenGrid {
  visible: boolean
  /** На сколько равных частей делится ширина. */
  columns: ScreenGridParts
  /** На сколько равных частей делится высота. */
  rows: ScreenGridParts
}

/** Сколько равных частей может быть по одной оси: половины, четверти, восьмые… */
export const SCREEN_GRID_PARTS = [2, 4, 8, 16, 32] as const

export type ScreenGridParts = (typeof SCREEN_GRID_PARTS)[number]

/** Сетка при первом включении: четверти по обеим осям. */
export const SCREEN_GRID_DEFAULT_PARTS: ScreenGridParts = 4

export function isScreenGridParts(value: unknown): value is ScreenGridParts {
  return SCREEN_GRID_PARTS.some((parts) => parts === value)
}

/**
 * Ближайшее верное число частей (по степеням двойки: 6 → 8, 24 → 32, 100 → 32). Не число —
 * сетка по умолчанию.
 */
export function nearestScreenGridParts(value: number): ScreenGridParts {
  if (!Number.isFinite(value) || value <= 0) {
    return SCREEN_GRID_DEFAULT_PARTS
  }
  let best: ScreenGridParts = SCREEN_GRID_PARTS[0]
  for (const parts of SCREEN_GRID_PARTS) {
    if (Math.abs(Math.log2(parts / value)) < Math.abs(Math.log2(best / value))) {
      best = parts
    }
  }
  return best
}

/** «4 × 4 equal parts». */
export function describeScreenGrid({ columns, rows }: Pick<ScreenGrid, 'columns' | 'rows'>): string {
  return `${columns} × ${rows} equal parts`
}

/** Сетка, которую экран показывает сейчас: сохранённая, а без неё — скрытая сетка по умолчанию. */
export function effectiveScreenGrid(screen: Pick<CanvasScreen, 'grid'>): ScreenGrid {
  return (
    screen.grid ?? {
      visible: false,
      columns: SCREEN_GRID_DEFAULT_PARTS,
      rows: SCREEN_GRID_DEFAULT_PARTS
    }
  )
}

/** Сетка из файла или от окна: видимость и верное число частей по каждой оси. */
export function isScreenGrid(value: unknown): value is ScreenGrid {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const { visible, columns, rows } = value as Record<string, unknown>
  return typeof visible === 'boolean' && isScreenGridParts(columns) && isScreenGridParts(rows)
}

export function isScreenFrame(value: unknown): value is ScreenFrame {
  return (
    value === 'phone' ||
    value === 'tablet' ||
    value === 'window' ||
    value === 'browser' ||
    value === 'none'
  )
}

/**
 * Рамка экрана: у устройства из списка — его рамка, у своего размера — та, что выбрал человек
 * (`frame`), а без неё (так ставит агент через `--size`) рамки нет.
 */
export function screenFrameOf(screen: Pick<CanvasScreen, 'device' | 'frame'>): ScreenFrame {
  return screen.device === 'custom' ? (screen.frame ?? 'none') : SCREEN_DEVICES[screen.device].frame
}

/**
 * Размер нового пустого экрана, который выбирает человек: устройство из списка или свой размер
 * с рамкой на выбор.
 */
export type ScreenLook =
  | { device: ScreenDeviceId }
  | { device: 'custom'; width: number; height: number; frame: ScreenFrame }

/** Новый размер существующего экрана: устройство из списка или свой размер (рамка остаётся). */
export type ScreenResize =
  | { device: ScreenDeviceId }
  | { device: 'custom'; width: number; height: number }

/**
 * Холст без чата: вместо id чата у него свой ключ с этой приставкой. По ключу страницы такого
 * холста собираются вместе так же, как страницы холста чата.
 */
export const STANDALONE_CANVAS_PREFIX = 'standalone:'

/** У холста нет чата: его создал человек, и агента к нему ещё не позвали. */
export function isStandaloneCanvas(canvas: Pick<Canvas, 'chatId'>): boolean {
  return canvas.chatId.startsWith(STANDALONE_CANVAS_PREFIX)
}

/** Клетка сетки холста, в пикселях холста: экраны и группы встают только по её линиям. */
export const CANVAS_GRID = 40

/** Ближайшая линия сетки. */
export function snapToGrid(value: number): number {
  return Math.round(value / CANVAS_GRID) * CANVAS_GRID
}

/** Ближайшая линия сетки не левее `value`: так экран встаёт после соседа, не наезжая на него. */
export function snapUpToGrid(value: number): number {
  return Math.ceil(value / CANVAS_GRID) * CANVAS_GRID
}

/** Расстояние между рамками экранов на холсте: кратно клетке сетки. */
export const SCREEN_GAP = 120

/** Границы масштаба холста. */
export const CANVAS_ZOOM = { min: 0.1, max: 2, default: 0.6 } as const

/** Сколько версий экрана хранится: старые вытесняются. */
export const SCREEN_HISTORY_LIMIT = 30

/** Длиннее имя страницы или экрана не помещается в подпись. */
export const CANVAS_NAME_MAX_LENGTH = 60

/** Файл экрана: HTML показывается как есть, React-компонент (`export default`) собирается приложением. */
export const HTML_SCREEN_EXTENSIONS = ['.html', '.htm'] as const
export const REACT_SCREEN_EXTENSIONS = ['.tsx', '.jsx'] as const

export type ScreenSourceKind = 'html' | 'react'

/** Вид файла экрана по его имени; `null` — такой файл экраном быть не может. */
export function screenSourceKind(file: string): ScreenSourceKind | null {
  const name = file.toLowerCase()
  if (HTML_SCREEN_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return 'html'
  }
  if (REACT_SCREEN_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return 'react'
  }
  return null
}

export interface CanvasScreen {
  id: string
  /** Имя: агент даёт при создании, человек может изменить. По имени агент находит экран. */
  name: string
  device: ScreenDevice
  width: number
  height: number
  /** Рамка экрана своего размера (`custom`); у устройства из списка не задаётся. */
  frame?: ScreenFrame
  /** Сетка поверх экрана, которую выбрал человек; нет — сетка скрыта и по умолчанию. */
  grid?: ScreenGrid
  /**
   * Абсолютный путь к файлу экрана в проекте: HTML или React-компонент. Приложение следит за
   * файлом и всем, что он импортирует, и обновляет экран.
   */
  file: string
  /** Левый верхний угол экрана на холсте, в координатах холста. */
  x: number
  y: number
  /** Растёт при каждом изменении файла: по нему окно перезагружает экран. */
  revision: number
  /** Файл пропал или не читается: экран показывает последнюю сохранённую версию. */
  missing: boolean
  /**
   * Сборка React-экрана не удалась: здесь текст ошибки, а экран показывает последнюю удачную
   * сборку. `null` — ошибок нет (и у HTML-экрана тоже).
   */
  buildError: string | null
  updatedAt: number
}

/** Прямоугольник элемента внутри экрана, в пикселях экрана (от его левого верхнего угла). */
export interface LinkAnchor {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Линия от одного экрана к другому: что за чем идёт. Ставит и убирает только агент. Начинается
 * точкой у кнопки (`on`) на экране-источнике или у края экрана, если кнопки нет; точка — это и есть
 * направление.
 */
export interface CanvasLink {
  id: string
  /** Экран, откуда идёт линия, и экран, куда она приходит (id). */
  from: string
  to: string
  /** Кнопка или другой элемент экрана-источника: её текст или CSS-селектор. */
  on: string | null
  /** Где этот элемент на экране; `null` — не нашли, линия идёт от края экрана. */
  anchor: LinkAnchor | null
}

/** Длиннее название кнопки не нужно; число линий на холсте ограничено ради порядка. */
export const LINK_ON_MAX_LENGTH = 120
export const CANVAS_LINKS_MAX = 200

/**
 * Группа: именованная рамка вокруг нескольких экранов, чтобы нужное находилось сразу. Рамку
 * ставит и убирает агент; человек переименовывает её, тянет вместе с экранами или распускает.
 * Экран входит не больше чем в одну группу. Рамка строится по самим экранам, места она не хранит.
 */
export interface CanvasGroup {
  id: string
  name: string
  /** Экраны группы (id). */
  screens: string[]
}

/** Число групп на холсте ограничено ради порядка. */
export const CANVAS_GROUPS_MAX = 60

/**
 * Поля рамки группы вокруг её экранов, в пикселях холста; кратны клетке сетки, чтобы рамка стояла
 * по сетке вместе со своими экранами. Сверху место под название группы и подписи экранов: они
 * стоят на месте и растут вместе с холстом.
 */
export const GROUP_PADDING = {
  top: CANVAS_GRID * 6,
  side: CANVAS_GRID * 2,
  bottom: CANVAS_GRID * 2
} as const

/** Сдвиг и масштаб холста: окно возвращает человека туда, где он остановился. */
export interface CanvasView {
  x: number
  y: number
  zoom: number
}

/**
 * Холст опубликован по ссылке: любой, у кого она есть, видит снимок всех страниц холста в браузере.
 * Ссылка одна на холст чата, поэтому она записана у всех его страниц.
 */
export interface CanvasShare {
  url: string
  /** Когда в последний раз опубликован снимок: новее правок холста, пока человек не обновит ссылку. */
  publishedAt: number
}

export interface Canvas {
  id: string
  /** Имя страницы: у страниц одного чата разные, по имени агент находит страницу. */
  name: string
  /**
   * Чат холста: в нём агент рисует экраны и в него уходят правки человека. У холста без чата
   * здесь его собственный ключ (`STANDALONE_CANVAS_PREFIX`, см. `isStandaloneCanvas`).
   */
  chatId: string
  projectId: string
  screens: CanvasScreen[]
  archived: boolean
  /** Линии между экранами. */
  links: CanvasLink[]
  /** Именованные рамки вокруг экранов. */
  groups: CanvasGroup[]
  /** Ссылка для просмотра; `null` — холст не опубликован. */
  share: CanvasShare | null
  /** Сохранённый вид; нет — окно вписывает все экраны само. */
  view: CanvasView | null
  createdAt: number
  updatedAt: number
}

export interface CanvasState {
  /** Все страницы всех холстов, и в архиве тоже; страницы одного чата — в своём порядке. */
  canvases: Canvas[]
  /** Чаты, холст которых публикуется по ссылке прямо сейчас. */
  sharing: string[]
}

/** Версия экрана: снимок его HTML, который приложение сохранило при изменении файла. */
export interface ScreenVersion {
  id: string
  savedAt: number
  /** Что породило версию. */
  cause: 'created' | 'edit' | 'restore'
  /** Просьба человека («Fix»), после которой версия появилась; нет — правка не по просьбе. */
  fix?: string
}

/**
 * Адрес экрана для iframe. Отдаёт его протокол `atox-canvas` в основном процессе, со строгой
 * политикой безопасности (CSP): без сети и без доступа к приложению. `versionId` — старая версия.
 */
export const CANVAS_PROTOCOL = 'atox-canvas'

export function canvasScreenUrl(
  canvasId: string,
  screenId: string,
  revision: number,
  versionId?: string
): string {
  const version = versionId ? `&v=${encodeURIComponent(versionId)}` : ''
  return `${CANVAS_PROTOCOL}://screen/${canvasId}/${screenId}?r=${revision}${version}`
}

/** Во что выгружаются экраны холста. */
export const CANVAS_EXPORT_FORMATS = ['pdf', 'png', 'pptx'] as const

export type CanvasExportFormat = (typeof CANVAS_EXPORT_FORMATS)[number]

export function isCanvasExportFormat(value: unknown): value is CanvasExportFormat {
  return typeof value === 'string' && (CANVAS_EXPORT_FORMATS as readonly string[]).includes(value)
}

/** Расширение файла выгрузки: PNG выгружается папкой, у неё расширения нет. */
export const CANVAS_EXPORT_EXTENSIONS: Record<CanvasExportFormat, string> = {
  pdf: '.pdf',
  png: '',
  pptx: '.pptx'
}

/** Результат выгрузки: куда легли файлы и сколько экранов в них вошло. */
export interface CanvasExportResult {
  /** Файл (PDF, PPTX) или папка с PNG. */
  path: string
  screens: number
  /** Экраны, которые вошли в выгрузку не в том виде: не собрались или потеряли файл. */
  warnings: string[]
}
