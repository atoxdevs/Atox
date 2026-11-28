import type { ProjectFileContent, ProjectFileList } from './projectFiles'
import type { AgentAccount } from './accounts'
import type { AgentCliStatus } from './agentCli'
import type { AgentId } from './agents'
import type { MessageAttachments, PickedFile } from './attachments'
import type {
  AvailableRepository,
  BoardColumn,
  BoardRepository,
  BoardState,
  TaskStart
} from './board'
import type {
  CanvasExportFormat,
  CanvasExportResult,
  CanvasState,
  CanvasShare,
  CanvasView,
  ScreenGrid,
  ScreenResize,
  ScreenLook,
  ScreenVersion
} from './canvas'
import type { ChangesResult, FileDiff } from './changes'
import type { AppCommand } from './commands'
import type { GitHubAccount } from './github'
import type {
  AgentCatalog,
  AgentCommand,
  ChatCommand,
  ContextReport,
  ChatConfiguration,
  ConversationEvent,
  ConversationSnapshot,
  ConversationSummary,
  RequestAnswer,
  UserRequestKind
} from './conversation'
import type { IntegrationKind, IntegrationList } from './integrations'
import type { Project, SpacesState, UserProfile } from './models'
import type { PlanLimitsState } from './planLimits'
import type { LinkPreview } from './linkPreview'
import type { TokenSpendSummary } from './tokenSpend'
import type {
  BranchPullRequest,
  GitHubCounts,
  GitHubItems,
  GitHubKind,
  GitHubOverview,
  ListState,
  Page,
  RepositoryResult
} from './repository'
import type { ProjectColor } from './projectColors'
import type { ProjectIcon } from './projectIcons'
import type { Settings } from './settings'
import type { UpdateCheckResult, UpdateState } from './update'

/** Размер терминала в символах. */
export interface TerminalSize {
  cols: number
  rows: number
}

/** Текущая ветка git по пути папки проекта; `null` — папка не репозиторий git. */
export type GitBranches = Record<string, string | null>

/** API, который preload пробрасывает в renderer как `window.atox`. */
export interface AtoxApi {
  projects: {
    list(): Promise<Project[]>
    /**
     * Открывает системный диалог выбора папки и добавляет её в пространство. Если папка уже
     * добавлена, возвращает её проект. `null` — пользователь закрыл диалог.
     */
    add(spaceId: string): Promise<{ projects: Project[]; projectId: string } | null>
    /** Переносит проект в другое пространство. */
    moveToSpace(projectId: string, spaceId: string): Promise<Project[]>
    remove(projectId: string): Promise<Project[]>
    rename(projectId: string, name: string): Promise<Project[]>
    /** Цвет папки проекта; `null` — без цвета. */
    setColor(projectId: string, color: ProjectColor | null): Promise<Project[]>
    /** Значок проекта вместо папки; `null` — обычная папка. */
    setIcon(projectId: string, icon: ProjectIcon | null): Promise<Project[]>
    /** Запоминает чаты проекта, открытые рядом (слева направо); `null` — один чат. */
    setSplit(projectId: string, chatIds: [string, string] | null): Promise<Project[]>
    /** Положение разделителя между чатами — доля ширины левого. */
    setSplitPosition(projectId: string, position: number): Promise<Project[]>
    /** Переносит проект на позицию `toIndex` в списке. */
    move(projectId: string, toIndex: number): Promise<Project[]>
    /** Открывает папку проекта в Finder. */
    reveal(projectId: string): Promise<void>
  }
  spaces: {
    list(): Promise<SpacesState>
    /** Создаёт пространство и открывает его. */
    create(): Promise<SpacesState>
    rename(spaceId: string, name: string): Promise<SpacesState>
    setColor(spaceId: string, color: ProjectColor | null): Promise<SpacesState>
    setActive(spaceId: string): Promise<SpacesState>
    /**
     * Удаляет пространство, переносив его проекты в соседнее (после подтверждения, если они есть).
     * `null` — пользователь передумал.
     */
    remove(spaceId: string): Promise<{ spaces: SpacesState; projects: Project[] } | null>
  }
  agents: {
    /** Агенты, которые установлены на компьютере. */
    available(): Promise<AgentId[]>
    /** Модели агента; `null` — агент не установлен или не ответил. */
    catalog(agent: AgentId): Promise<AgentCatalog | null>
    /** Списки моделей агента устарели — например, после входа в другой аккаунт. */
    subscribeListsStale(listener: (agent: AgentId) => void): () => void
    /**
     * Плагины, скиллы или серверы MCP агента — вместе с проектными у `projectId`. Ответ бывает
     * долгим: агент запускается, а серверы MCP успевают подключиться.
     */
    integrations<Kind extends IntegrationKind>(
      agent: AgentId,
      kind: Kind,
      projectId: string | null
    ): Promise<IntegrationList<Kind>>
  }
  agentCli: {
    /** Установлены ли программы агентов, их версии и идущие установки. */
    list(): Promise<AgentCliStatus[]>
    /** Ставит программу агента; ход установки приходит через `onChanged`. */
    install(agent: AgentId): Promise<void>
    /** Обновляет программу агента тем способом, которым она установлена. */
    update(agent: AgentId): Promise<void>
    /** Убирает сообщение о неудачной установке или обновлении. */
    dismiss(agent: AgentId): Promise<void>
    onChanged(listener: (statuses: AgentCliStatus[]) => void): () => void
  }
  chats: {
    /**
     * Создаёт чат с агентом. Выбранный агент становится агентом по умолчанию; без агента
     * берётся агент по умолчанию.
     */
    create(projectId: string, agent?: AgentId): Promise<{ projects: Project[]; chatId: string }>
    /** Копия чата с его разговором: встаёт под исходным и идёт дальше сама по себе. */
    fork(chatId: string): Promise<{ projects: Project[]; chatId: string }>
    remove(chatId: string): Promise<Project[]>
    /**
     * Убирает чат в архив вместе с его помощниками (после подтверждения, если их агенты
     * работают — архив их останавливает). История чата остаётся.
     */
    archive(chatId: string): Promise<Project[]>
    /** Возвращает чат из архива наверх списка его проекта. */
    restore(chatId: string): Promise<Project[]>
    /** Удаляет чат из архива вместе с историей — после подтверждения. */
    removeArchived(chatId: string): Promise<Project[]>
    /** Переименование пользователем: после него первое сообщение название не меняет. */
    rename(chatId: string, title: string): Promise<Project[]>
    /** Переносит чат на позицию `toIndex` среди чатов верхнего уровня его проекта. */
    move(chatId: string, toIndex: number): Promise<Project[]>
    /** Меняет агента, модель или эффорт чата. */
    configure(chatId: string, configuration: ChatConfiguration): Promise<Project[]>
    /** Список чатов изменился без участия окна — например, агент запустил помощника. */
    onChanged(listener: (projects: Project[]) => void): () => void
  }
  conversations: {
    /** Лента чата и то, работает ли сейчас его агент. */
    snapshot(chatId: string): Promise<ConversationSnapshot>
    /** Сводки всех начатых разговоров — для обзора агентов. */
    summaries(): Promise<ConversationSummary[]>
    /** `attachments` — пути к картинкам и файлам, которые агент получит вместе с текстом. */
    send(chatId: string, text: string, attachments?: MessageAttachments): Promise<void>
    /** Команды агента чата для подсказок после «/». */
    commands(chatId: string): Promise<AgentCommand[]>
    /** Выполняет команду Atox (`/usage`, `/context`, `/clear`), не отправляя её агенту. */
    runCommand(chatId: string, command: ChatCommand): Promise<void>
    /** Из чего сейчас состоит контекст чата — для окна у кольца, без записи в ленту. */
    context(chatId: string): Promise<ContextReport>
    /** Останавливает текущий ответ агента; сообщения в очереди уходят ему следом. */
    interrupt(chatId: string): Promise<void>
    /** Останавливает одну фоновую задачу агента чата; отклоняется, если агент её не остановил. */
    stopTask(chatId: string, taskId: string): Promise<void>
    /** Убирает сообщение из очереди, пока агент его не взял. */
    cancelQueued(chatId: string, itemId: string): Promise<void>
    sendQueuedNow(chatId: string, itemId: string): Promise<void>
    /** Меняет текст сообщения в очереди; если агент уже взял его, ничего не меняется. */
    editQueued(chatId: string, itemId: string, text: string): Promise<void>
    /** Ставит сообщения очереди в этом порядке. */
    reorderQueued(chatId: string, itemIds: string[]): Promise<void>
    /** Ответ на разрешение, вопросы или форму агента — элемент ленты `approval` или `question`. */
    answerRequest(chatId: string, itemId: string, answer: RequestAnswer): Promise<void>
    /** Вход в аккаунт агента чата — кнопка под ошибкой входа, то же, что `/login`. */
    signIn(chatId: string): Promise<void>
    /** События ленты одного чата. */
    onEvent(chatId: string, listener: (event: ConversationEvent) => void): () => void
    /** В каком-либо чате что-то произошло: пора обновить обзор агентов. */
    onAnyEvent(listener: () => void): () => void
    /** Агент какого-либо чата начал или закончил работу. */
    onRunningChange(listener: (chatId: string, running: boolean) => void): () => void
    /** Агент какого-либо чата начал (`waitingFor`) или перестал (`null`) ждать ответа. */
    onWaitingChange(
      listener: (chatId: string, waitingFor: UserRequestKind | null) => void
    ): () => void
  }
  /** Терминал проекта в панели справа от чатов: оболочка в папке проекта. */
  terminals: {
    /** Запускает оболочку проекта, если она не запущена, и возвращает её накопленный вывод. */
    attach(projectId: string, size: TerminalSize): Promise<string>
    write(projectId: string, data: string): void
    resize(projectId: string, size: TerminalSize): void
    onData(projectId: string, listener: (data: string) => void): () => void
    /** Оболочка завершилась, например по `exit`. */
    onExit(projectId: string, listener: () => void): () => void
  }
  files: {
    /** Путь на диске к файлу, перетащенному в окно. */
    getPath(file: File): string
    /** Системный диалог выбора файлов для сообщения; пустой список — пользователь передумал. */
    pick(): Promise<PickedFile[]>
    /** Сохраняет вставленную картинку во временный файл и возвращает путь к нему. */
    savePastedImage(image: File): Promise<string>
    /**
     * Открывает файл или папку по ссылке из ответа агента; относительный путь — от
     * `baseDirectory`. Программы и скрипты не запускаются, а показываются в файловом менеджере.
     */
    open(path: string, baseDirectory?: string): Promise<void>
  }
  links: {
    /**
     * Карточка ссылки из ответа агента: PR или issue GitHub — под учётной записью gh чата,
     * сайт — его заголовок и описание. `null` — показать нечего.
     */
    preview(url: string, chatId?: string): Promise<LinkPreview | null>
  }
  images: {
    /** Картинка с диска как data URL; `null` — файла нет, он слишком большой или это не картинка. */
    read(path: string): Promise<string | null>
    /** Диалог «Сохранить как» для картинки; `false` — пользователь передумал. */
    saveAs(path: string): Promise<boolean>
  }
  git: {
    branches(): Promise<GitBranches>
    subscribe(listener: (branches: GitBranches) => void): () => void
  }
  /** Незакоммиченные изменения в папке проекта. */
  projectFiles: {
    /** Файлы проекта для просмотра кода, без игнорируемых git. */
    list(projectId: string): Promise<ProjectFileList>
    /** Содержимое файла проекта; путь — относительно папки проекта. */
    read(projectId: string, path: string): Promise<ProjectFileContent>
  }
  changes: {
    list(projectId: string): Promise<ChangesResult>
    /** Изменения файла построчно; `null` — файл уже не изменён. */
    diff(projectId: string, path: string): Promise<FileDiff | null>
    /** Спрашивает подтверждение и возвращает файл к последнему коммиту; `false` — передумали. */
    discard(projectId: string, path: string): Promise<boolean>
  }
  repository: {
    /** Первые страницы pull request'ов и issue проекта с GitHub. */
    github(projectId: string, loaded?: GitHubCounts): Promise<RepositoryResult<GitHubOverview>>
    /** Следующая страница одного из списков GitHub. */
    moreGitHub<Kind extends GitHubKind>(
      projectId: string,
      kind: Kind,
      state: ListState,
      cursor: string
    ): Promise<RepositoryResult<Page<GitHubItems[Kind]>>>
    /**
     * PR текущей ветки папки чата; `null` — чат в основной ветке, у ветки нет PR или GitHub
     * недоступен. Ответ кэшируется ненадолго; `fresh` — спросить GitHub заново.
     */
    chatPullRequest(chatId: string, fresh?: boolean): Promise<BranchPullRequest | null>
  }
  updates: {
    /** Скачивается ли новая версия или она уже готова к установке; `null` — обновлений нет. */
    state(): Promise<UpdateState>
    subscribe(listener: (state: UpdateState) => void): () => void
    /** Версия запущенного приложения. */
    currentVersion(): Promise<string>
    /** Проверяет обновления сейчас; новая версия сразу начинает скачиваться. */
    check(): Promise<UpdateCheckResult>
    /** Перезапускает приложение с установкой обновления. */
    install(): void
  }
  shortcuts: {
    /**
     * Пока в настройках записывают новое сочетание, горячие клавиши меню не срабатывают:
     * иначе нажатое сочетание выполнило бы команду вместо того, чтобы записаться.
     */
    setRecording(recording: boolean): void
  }
  system: {
    getUserProfile(): Promise<UserProfile>
    /** Выводит окно приложения на передний план, например по клику на уведомление. */
    focusWindow(): void
    /** Число на иконке приложения в доке: сколько чатов ждут пользователя; 0 — убрать. */
    setBadgeCount(count: number): void
  }
  planLimits: {
    /** Последние известные лимиты подписки агентов. */
    get(): Promise<PlanLimitsState>
    subscribe(listener: (state: PlanLimitsState) => void): () => void
    /** Принудительно перечитать лимиты у всех агентов — например, после смены аккаунта. */
    refresh(): Promise<void>
  }
  /** Аккаунты агентов: основной у каждого и дополнительные подписки, которые добавил пользователь. */
  accounts: {
    /** Аккаунты всех агентов — то, что известно сейчас. */
    list(): Promise<AgentAccount[]>
    /** Спрашивает у агентов, в какие аккаунты они вошли, и возвращает обновлённый список. */
    refresh(): Promise<AgentAccount[]>
    /** Добавляет аккаунт агенту; войти в него — `signIn`. */
    add(agent: AgentId): Promise<AgentAccount>
    rename(accountId: string, name: string): Promise<void>
    /**
     * Удаляет дополнительный аккаунт после подтверждения: выходит из него и стирает его папку.
     * `false` — пользователь передумал. Чаты под ним продолжаются под основным аккаунтом.
     */
    remove(accountId: string): Promise<boolean>
    /**
     * Открывает страницу входа в браузере и ждёт, пока человек её пройдёт. Завершается, когда
     * вход закончен; отклоняется, если он не удался или его отменили.
     */
    signIn(accountId: string): Promise<void>
    cancelSignIn(accountId: string): Promise<void>
    onChanged(listener: (accounts: AgentAccount[]) => void): () => void
  }
  tokenSpend: {
    /** Сколько токенов потратили агенты: сегодня и за всё время. */
    get(): Promise<TokenSpendSummary>
    subscribe(listener: (summary: TokenSpendSummary) => void): () => void
  }
  settings: {
    /**
     * Синхронно: раскладка (ширина сайдбара, терминала) нужна уже в первом кадре — иначе
     * окно сначала отрисовалось бы с размерами по умолчанию, а потом прыгнуло.
     */
    get(): Settings
    update(patch: Partial<Settings>): Promise<Settings>
    subscribe(listener: (settings: Settings) => void): () => void
  }
  commands: {
    subscribe(listener: (command: AppCommand) => void): () => void
  }
  github: {
    /** Учётные записи github.com, в которые выполнен вход в `gh`. */
    accounts(): Promise<GitHubAccount[]>
    /** Делает учётную запись активной в `gh` и возвращает обновлённый список. */
    activate(login: string): Promise<GitHubAccount[]>
  }
  board: {
    get(): Promise<BoardState>
    /** Перечитывает задачи с GitHub. */
    refresh(): Promise<BoardState>
    subscribe(listener: (state: BoardState) => void): () => void
    /** Репозитории всех учётных записей `gh`, которые можно добавить на доску. */
    availableRepositories(): Promise<AvailableRepository[]>
    setRepositories(repositories: BoardRepository[]): Promise<BoardState>
    /**
     * Переносит задачу в колонку; в очереди она уйдёт агенту, как только будет место.
     * `start` — с каким агентом и сообщением её запустить; нет — с агентом доски по умолчанию.
     */
    move(issueId: string, column: BoardColumn, start?: TaskStart): Promise<BoardState>
    /** Проект, под которым чат агента появится по умолчанию; `null` — репозиторий ещё склонируют. */
    defaultProject(repository: string): Promise<string | null>
  }
  /**
   * Холст чата: экраны, которые агент показывает на отдельной странице; в холсте несколько
   * страниц (в API страница называется `canvasId`). Содержимое экранов окно не
   * получает вызовом: iframe открывает их по адресу `canvasScreenUrl` (протокол `atox-canvas`).
   */
  canvas: {
    get(): Promise<CanvasState>
    subscribe(listener: (state: CanvasState) => void): () => void
    /**
     * Создаёт холст чата с пустой страницей. Холст у чата один: если он уже есть, возвращается
     * id его первой страницы.
     */
    create(chatId: string): Promise<string>
    /** Добавляет в холст чата (или холст без чата, по его ключу) пустую страницу; её id. */
    addPage(chatId: string): Promise<string>
    /**
     * Создаёт холст без чата в проекте и возвращает id его первой страницы. С `look` на ней сразу
     * стоит пустой экран этого размера.
     */
    createStandalone(projectId: string, name: string, look?: ScreenLook): Promise<string>
    /** Ставит на страницу пустой экран выбранного размера и возвращает его id. */
    addBlankScreen(canvasId: string, look: ScreenLook): Promise<string>
    /** Привязывает холст без чата (все его страницы) к чату того же проекта, у которого холста нет. */
    linkChat(canvasId: string, chatId: string): Promise<void>
    /** Задаёт порядок страниц холста чата: `pageIds` — все его страницы. */
    reorderPages(chatId: string, pageIds: string[]): Promise<void>
    /** Переименовывает страницу; имена страниц одного холста разные. */
    rename(canvasId: string, name: string): Promise<void>
    renameScreen(canvasId: string, screenId: string, name: string): Promise<void>
    /**
     * Сетка поверх экрана (инструмент Grid): видна ли и на сколько равных частей (2, 4, 8, 16, 32)
     * делит ширину и высоту. Страницу экрана сетка не меняет.
     */
    setScreenGrid(canvasId: string, screenId: string, grid: ScreenGrid): Promise<void>
    /**
     * Новый размер экрана на холсте (панель инструментов): устройство из списка или свой размер,
     * рамка экрана остаётся. Меняется экран, а не его HTML; сетка остаётся той же.
     */
    resizeScreen(canvasId: string, screenId: string, look: ScreenResize): Promise<void>
    /**
     * Вызывается, когда человек отпустил экран; позицию в процессе перетаскивания держит окно.
     * Позиция уже стоит по линиям сетки: об этом заботится окно.
     */
    moveScreen(canvasId: string, screenId: string, x: number, y: number): Promise<void>
    renameGroup(canvasId: string, groupId: string, name: string): Promise<void>
    /** Человек отпустил заголовок группы: все её экраны сдвигаются на это расстояние. */
    moveGroup(canvasId: string, groupId: string, dx: number, dy: number): Promise<void>
    /**
     * Публикует снимок холста (всех его страниц) на сайте и возвращает ссылку для просмотра.
     * Уже опубликованный холст обновляется по той же ссылке. `null` — не вышло: причину человек
     * уже увидел.
     */
    share(canvasId: string): Promise<CanvasShare | null>
    /** Закрывает ссылку: страница по ней больше не открывается. */
    stopSharing(canvasId: string): Promise<void>
    /** Распускает группу: рамка исчезает, экраны остаются. */
    ungroup(canvasId: string, groupId: string): Promise<void>
    /** Запоминает сдвиг и масштаб холста; окно зовёт редко (после паузы), не на каждый кадр. */
    setView(canvasId: string, view: CanvasView): Promise<void>
    /** Убирает в архив весь холст чата (все страницы вместе) или возвращает его. */
    archive(canvasId: string, archived: boolean): Promise<void>
    /**
     * Удаляет страницу после подтверждения и сохранённые версии её экранов. Файлы экранов
     * в проекте не трогает: они принадлежат проекту.
     */
    remove(canvasId: string): Promise<void>
    /** Удаляет холст чата целиком, со всеми страницами, после подтверждения. */
    removeCanvas(chatId: string): Promise<void>
    /**
     * Отправляет просьбу человека в чат холста. С `screenId` это «Fix»: к тексту добавляются имя
     * экрана, путь к его файлу и скриншот. Без него — обычное сообщение. Если чата уже нет,
     * бросает ошибку.
     */
    request(canvasId: string, text: string, screenId?: string): Promise<void>
    /**
     * Убирает экран с холста после подтверждения в системном диалоге. Файл экрана остаётся
     * в проекте: он принадлежит проекту.
     */
    removeScreen(canvasId: string, screenId: string): Promise<void>
    history(canvasId: string, screenId: string): Promise<ScreenVersion[]>
    /** Записывает снимок версии в файл экрана; агент и холст видят его как обычную правку. */
    restore(canvasId: string, screenId: string, versionId: string): Promise<void>
    /**
     * Выгружает все экраны холста в PDF, PNG (папка) или PPTX. Место спрашивает системный
     * диалог; `null` — пользователь передумал. После выгрузки показывает файл в Finder.
     */
    export(canvasId: string, format: CanvasExportFormat): Promise<CanvasExportResult | null>
  }
}

export const IpcChannel = {
  ProjectsList: 'projects:list',
  ProjectsAdd: 'projects:add',
  ProjectsRemove: 'projects:remove',
  ProjectsRename: 'projects:rename',
  ProjectsSetColor: 'projects:set-color',
  ProjectsSetIcon: 'projects:set-icon',
  ProjectsMoveToSpace: 'projects:move-to-space',
  SpacesList: 'spaces:list',
  SpacesCreate: 'spaces:create',
  SpacesRename: 'spaces:rename',
  SpacesSetColor: 'spaces:set-color',
  SpacesSetActive: 'spaces:set-active',
  SpacesRemove: 'spaces:remove',
  ProjectsSetSplit: 'projects:set-split',
  ProjectsSetSplitPosition: 'projects:set-split-position',
  ProjectsMove: 'projects:move',
  ProjectsReveal: 'projects:reveal',
  AgentsAvailable: 'agents:available',
  AgentsCatalog: 'agents:catalog',
  AgentsIntegrations: 'agents:integrations',
  AgentCliList: 'agent-cli:list',
  AgentCliInstall: 'agent-cli:install',
  AgentCliUpdate: 'agent-cli:update',
  AgentCliDismiss: 'agent-cli:dismiss',
  AgentCliChanged: 'agent-cli:changed',
  ChatsCreate: 'chats:create',
  ChatsFork: 'chats:fork',
  ChatsRemove: 'chats:remove',
  ChatsArchive: 'chats:archive',
  ChatsRestore: 'chats:restore',
  ChatsRemoveArchived: 'chats:remove-archived',
  ChatsRename: 'chats:rename',
  ChatsMove: 'chats:move',
  ChatsConfigure: 'chats:configure',
  ProjectsChanged: 'projects:changed',
  ConversationsSnapshot: 'conversations:snapshot',
  ConversationsSummaries: 'conversations:summaries',
  ConversationsSend: 'conversations:send',
  ConversationsInterrupt: 'conversations:interrupt',
  ConversationsStopTask: 'conversations:stop-task',
  ConversationsCancelQueued: 'conversations:cancel-queued',
  ConversationsSendQueuedNow: 'conversations:send-queued-now',
  ConversationsEditQueued: 'conversations:edit-queued',
  ConversationsReorderQueued: 'conversations:reorder-queued',
  ConversationsAnswerRequest: 'conversations:answer-request',
  ConversationsSignIn: 'conversations:sign-in',
  ConversationsCommands: 'conversations:commands',
  ConversationsRunCommand: 'conversations:run-command',
  ConversationsContext: 'conversations:context',
  ConversationsEvent: 'conversations:event',
  TerminalsAttach: 'terminals:attach',
  TerminalsWrite: 'terminals:write',
  TerminalsResize: 'terminals:resize',
  TerminalsData: 'terminals:data',
  TerminalsExit: 'terminals:exit',
  FilesSavePastedImage: 'files:save-pasted-image',
  FilesPick: 'files:pick',
  FilesOpen: 'files:open',
  LinksPreview: 'links:preview',
  ImagesRead: 'images:read',
  ImagesSaveAs: 'images:save-as',
  GitBranches: 'git:branches',
  GitBranchesChanged: 'git:branches-changed',
  ProjectFilesList: 'project-files:list',
  ProjectFilesRead: 'project-files:read',
  ChangesList: 'changes:list',
  ChangesDiff: 'changes:diff',
  ChangesDiscard: 'changes:discard',
  RepositoryGitHub: 'repository:github',
  RepositoryMoreGitHub: 'repository:more-github',
  RepositoryChatPullRequest: 'repository:chat-pull-request',
  UpdatesState: 'updates:state',
  UpdatesStateChanged: 'updates:state-changed',
  UpdatesInstall: 'updates:install',
  UpdatesCheck: 'updates:check',
  UpdatesCurrentVersion: 'updates:current-version',
  SystemUserProfile: 'system:user-profile',
  SystemFocusWindow: 'system:focus-window',
  SystemBadgeCount: 'system:badge-count',
  AppCommand: 'app:command',
  PlanLimitsGet: 'plan-limits:get',
  PlanLimitsRefresh: 'plan-limits:refresh',
  PlanLimitsChanged: 'plan-limits:changed',
  AccountsList: 'accounts:list',
  AccountsRefresh: 'accounts:refresh',
  AccountsAdd: 'accounts:add',
  AccountsRename: 'accounts:rename',
  AccountsRemove: 'accounts:remove',
  AccountsSignIn: 'accounts:sign-in',
  AccountsCancelSignIn: 'accounts:cancel-sign-in',
  AccountsChanged: 'accounts:changed',
  AgentsListsStale: 'agents:lists-stale',
  TokenSpendGet: 'token-spend:get',
  TokenSpendChanged: 'token-spend:changed',
  SettingsGet: 'settings:get',
  SettingsUpdate: 'settings:update',
  SettingsChanged: 'settings:changed',
  ShortcutsRecording: 'shortcuts:recording',
  GitHubAccounts: 'github:accounts',
  GitHubActivate: 'github:activate',
  BoardGet: 'board:get',
  BoardRefresh: 'board:refresh',
  BoardChanged: 'board:changed',
  BoardAvailableRepositories: 'board:available-repositories',
  BoardSetRepositories: 'board:set-repositories',
  BoardMove: 'board:move',
  BoardDefaultProject: 'board:default-project',
  CanvasGet: 'canvas:get',
  CanvasChanged: 'canvas:changed',
  CanvasCreate: 'canvas:create',
  CanvasAddPage: 'canvas:add-page',
  CanvasCreateStandalone: 'canvas:create-standalone',
  CanvasAddBlankScreen: 'canvas:add-blank-screen',
  CanvasLinkChat: 'canvas:link-chat',
  CanvasReorderPages: 'canvas:reorder-pages',
  CanvasRemoveCanvas: 'canvas:remove-canvas',
  CanvasRename: 'canvas:rename',
  CanvasRenameScreen: 'canvas:rename-screen',
  CanvasSetScreenGrid: 'canvas:set-screen-grid',
  CanvasResizeScreen: 'canvas:resize-screen',
  CanvasMoveScreen: 'canvas:move-screen',
  CanvasRenameGroup: 'canvas:rename-group',
  CanvasMoveGroup: 'canvas:move-group',
  CanvasUngroup: 'canvas:ungroup',
  CanvasShare: 'canvas:share',
  CanvasStopSharing: 'canvas:stop-sharing',
  CanvasSetView: 'canvas:set-view',
  CanvasArchive: 'canvas:archive',
  CanvasRemove: 'canvas:remove',
  CanvasRemoveScreen: 'canvas:remove-screen',
  CanvasRequest: 'canvas:request',
  CanvasHistory: 'canvas:history',
  CanvasRestore: 'canvas:restore',
  CanvasExport: 'canvas:export'
} as const
