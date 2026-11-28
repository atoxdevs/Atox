/**
 * Протокол, по которому агенты в терминалах Atox управляют приложением через команду `atox`:
 * запускают помощников в соседних чатах, переписываются с ними и получают отчёты.
 * Команда подключается к локальному сокету приложения и отправляет одну строку JSON.
 */

import type { ScreenGridParts } from './canvas'

/** Переменные окружения, которые получает терминал каждого чата. */
export const OrchestrationEnv = {
  /** Путь к сокету приложения. */
  Socket: 'ATOX_SOCKET',
  /** Секрет запуска приложения: без него сокет не принимает команды. */
  Token: 'ATOX_TOKEN',
  /** Чат, из терминала которого вызвана команда. */
  ChatId: 'ATOX_CHAT_ID',
  /** Полный путь к команде `atox` — на случай, если профиль оболочки переписал PATH. */
  Cli: 'ATOX_CLI'
} as const

/** Адресат сообщения помощника — агент, который его запустил. */
export const PARENT_ADDRESS = 'parent'

export interface AgentInfo {
  id: string
  name: string
}

/** Модель агента, которую можно дать помощнику. */
export interface WorkerModelInfo {
  id: string
  name: string
  /** Уровни эффорта модели; пусто — выбора нет. */
  efforts: string[]
  /** Эффорт модели, если его не выбрали. */
  defaultEffort?: string
}

export interface WorkerInfo {
  chatId: string
  title: string
  agent: string
  /** Терминал помощника работает. */
  running: boolean
  /** Модель и эффорт помощника; нет — по умолчанию у агента. */
  model?: string
  effort?: string
  /** Помощник уже прислал отчёт. */
  reported: boolean
  /** Когда помощника запустили, мс с начала эпохи. */
  startedAt: number
}

/** Экран на холсте чата, как его видит агент. */
/** Какой холст чата имеет в виду команда; не задан — единственный холст чата. */
export interface CanvasTargetParams {
  canvas?: string
}

export interface CanvasScreenInfo {
  name: string
  /** Устройство из списка холста или `custom` — свой размер. */
  device: string
  width: number
  height: number
  /** Абсолютный путь к HTML-файлу экрана. */
  file: string
  /** Файла нет или он не читается: холст показывает последнюю сохранённую версию. */
  missing: boolean
  /** Экран-React не собирается: «файл:строка: что не так»; `null` — собирается. */
  buildError: string | null
  grid: CanvasScreenGridInfo
}

/**
 * Сетка экрана, как её видит агент: инструмент человека поверх экрана, в страницу не попадает.
 * Делит экран на `columns` равных частей по ширине и `rows` по высоте, центральный крест выделен.
 */
export interface CanvasScreenGridInfo {
  /** Человек (или агент) включил сетку: блоки стоит ставить по её линиям. */
  visible: boolean
  columns: ScreenGridParts
  rows: ScreenGridParts
}

/** Команды и их параметры/результаты. */
export interface OrchestrationMethods {
  agents: { params: Record<string, never>; result: AgentInfo[] }
  /** Модели агента и эффорты каждой — из них выбирают `model` и `effort` для `start`. */
  models: {
    params: { agent: string }
    result: { defaultModel: string; models: WorkerModelInfo[] }
  }
  start: {
    /** `model` и `effort` не заданы — те, с которыми пользователь начинает новые чаты. */
    params: { agent: string; task: string; title?: string; model?: string; effort?: string }
    result: { chatId: string; title: string; model?: string; effort?: string }
  }
  /**
   * Ставит сообщение в очередь агенту. `now` — только своему помощнику: его текущий ход
   * прерывается, и сообщение уходит сразу следующим.
   */
  send: {
    params: { to: string; message: string; now?: boolean }
    result: { chatId: string; interrupted?: boolean }
  }
  report: { params: { summary: string }; result: { chatId: string } }
  workers: { params: Record<string, never>; result: WorkerInfo[] }
  /**
   * Прерывает текущий ход своего помощника; чат и разговор остаются. `interrupted` — помощник
   * работал; `queued` — сколько сообщений ждёт: следующее он возьмёт сразу.
   */
  interrupt: { params: { chatId: string }; result: { interrupted: boolean; queued: number } }
  /** Останавливает помощников и убирает их чаты из списка. */
  remove: { params: { chatIds: string[] }; result: { removed: string[] } }
  /**
   * Холсты чата, их экраны и линии между ними: названный или все; пусто — холстов у чата нет.
   */
  canvas: {
    params: CanvasTargetParams
    result: {
      name: string
      screens: CanvasScreenInfo[]
      links: { from: string; to: string; on: string | null }[]
      groups: { name: string; screens: string[] }[]
      /** Адрес страницы для просмотра; `null` — холст не опубликован. */
      share: string | null
    }[]
  }
  /** Заводит ещё один холст чата; холст с таким именем уже есть — возвращает его. */
  canvasNew: {
    params: { name: string }
    result: { canvas: string; created: boolean }
  }
  /**
   * Ставит на холст чата экран из файла (HTML или React-компонент) или обновляет экран с тем же именем (без учёта
   * регистра). Холста нет — он создаётся. `file` — абсолютный путь (.html, .tsx, .jsx), `size` — `WxH`.
   */
  canvasScreenSet: {
    /** Без `file` — только у существующего экрана: меняется устройство или размер, файл прежний. */
    params: CanvasTargetParams & { name: string; file?: string; device?: string; size?: string }
    result: {
      canvas: string
      screen: string
      canvasCreated: boolean
      created: boolean
      device: string
      width: number
      height: number
      file: string
      /** Проблемы раскладки словами; пусто — всё помещается или измерить не удалось. */
      layout: string[]
      /** Экран-React не собрался: «файл:строка: что не так»; `null` — собрался. */
      buildError: string | null
      /** Ошибки страницы при открытии: необработанные исключения, `console.error`. */
      runtimeErrors: string[]
      grid: CanvasScreenGridInfo
    }
  }
  /**
   * Сетка экрана: без параметров — только показать. `parts` (обе оси) или `columns`/`rows`
   * выбирают число равных частей (и показывают сетку), `visible` включает или прячет. Неверное
   * число — ошибка со списком верных.
   */
  canvasScreenGrid: {
    params: CanvasTargetParams & {
      name: string
      parts?: number
      columns?: number
      rows?: number
      visible?: boolean
    }
    result: { screen: string; width: number; height: number; grid: CanvasScreenGridInfo }
  }
  /** Снимает экран в PNG, как он выглядит на холсте, и проверяет раскладку. */
  canvasScreenPreview: {
    params: CanvasTargetParams & { name: string }
    result: {
      screen: string
      path: string
      layout: string[]
      buildError: string | null
      runtimeErrors: string[]
    }
  }
  /**
   * Раскладывает экраны рядами: каждый ряд — имена слева направо, ряды сверху вниз. Не названные
   * экраны уходят отдельным рядом вниз.
   */
  canvasArrange: {
    params: CanvasTargetParams & { rows: string[][] }
    result: { rows: number; screens: number; rest: string[] }
  }
  /**
   * Ставит линию между двумя экранами (по именам): что за чем идёт. С `on` линия начинается
   * у кнопки экрана `from` (её текст или CSS-селектор).
   */
  canvasLinkSet: {
    params: CanvasTargetParams & { from: string; to: string; on?: string }
    result: {
      from: string
      to: string
      on: string | null
      created: boolean
      elementMissing: boolean
    }
  }
  /** Убирает линии между экранами; с `on` — только от этой кнопки. */
  canvasLinkRemove: {
    params: CanvasTargetParams & { from: string; to: string; on?: string }
    result: { removed: number }
  }
  /**
   * Собирает экраны (по именам) в именованную группу — рамку вокруг них. Группа с таким именем
   * уже есть — получает ровно эти экраны.
   */
  canvasGroupSet: {
    params: CanvasTargetParams & { name: string; screens: string[] }
    result: { name: string; screens: string[]; created: boolean }
  }
  /** Распускает группу по имени; экраны остаются на холсте. */
  canvasGroupRemove: { params: CanvasTargetParams & { name: string }; result: { name: string } }
  /**
   * Публикует холст по ссылке для просмотра в браузере (клиенту, с телефона): снимок экранов
   * без комментариев и правок. Повторный вызов обновляет снимок по той же ссылке.
   */
  canvasShare: { params: CanvasTargetParams; result: { url: string } }
  /** Закрывает ссылку на холст. */
  canvasShareStop: { params: CanvasTargetParams; result: Record<string, never> }
  /** Убирает экран с холста; HTML-файл остаётся. */
  canvasScreenRemove: {
    params: CanvasTargetParams & { name: string }
    result: { screen: string }
  }
  /**
   * Выгружает экраны холста в PDF, PNG (папка) или PPTX: ряды сверху вниз, в ряду слева направо.
   * `screens` — имена; не заданы — все. `out` — абсолютный путь; не задан — папка «Загрузки».
   */
  canvasExport: {
    params: CanvasTargetParams & { format: string; screens?: string[]; out?: string }
    result: { path: string; format: string; screens: number; warnings: string[] }
  }
}

export type OrchestrationMethod = keyof OrchestrationMethods

export interface OrchestrationRequest<Method extends OrchestrationMethod = OrchestrationMethod> {
  token: string
  chatId: string
  method: Method
  params: OrchestrationMethods[Method]['params']
}

export type OrchestrationResponse<Method extends OrchestrationMethod = OrchestrationMethod> =
  { ok: true; result: OrchestrationMethods[Method]['result'] } | { ok: false; error: string }
