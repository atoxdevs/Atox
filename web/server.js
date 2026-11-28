import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT) || 3000
/**
 * Репозиторий с релизами Atox. Он закрытый, поэтому файлы релизов берутся через API GitHub
 * с токеном на чтение, а приложение и сайт получают их по адресам `/updates/...` этого сервера.
 */
const GITHUB_REPO = process.env.GITHUB_REPO || 'atoxdevs/Atox'
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`
/** Манифесты обновлений — те же, по которым обновляется само приложение. */
const MANIFESTS = {
  mac: 'latest-mac.json',
  linux: 'latest-linux.json',
  windows: 'latest-windows.json'
}
/** Адрес файла релиза: `/updates/latest/<файл>` или `/updates/v<версия>/<файл>`. */
const UPDATES_PATH = '/updates'
const RELEASE_TAG = /^(latest|v\d+(\.\d+)*)$/
const ASSET_NAME = /^[\w.-]+$/

/** Сколько держать сведения о релизе для страницы скачивания, прежде чем спросить GitHub снова. */
const RELEASE_CACHE_MS = 5 * 60 * 1000
/** Сколько помнить, какой релиз последний: новый релиз должен находиться быстро. */
const LATEST_TAG_CACHE_MS = 60 * 1000
/** Релиз конкретной версии не меняется — его файлы можно помнить долго. */
const TAGGED_RELEASE_CACHE_MS = 60 * 60 * 1000
/**
 * Временная ссылка GitHub на файл действует около часа; переиспользуется заметно меньше,
 * чтобы у скачивания был запас времени.
 */
const ASSET_URL_CACHE_MS = 10 * 60 * 1000
/** Сколько ждать ответа GitHub, прежде чем отдать то, что уже известно. */
const GITHUB_TIMEOUT_MS = 5000

/**
 * Сборки Atox: адрес `/download/<сборка>` → файл релиза. В манифесте платформы под каждую
 * архитектуру указан файл обновления; файл для скачивания — той же сборки и назван так же,
 * отличается только окончание имени: `Atox-0.1.42-arm64.zip` → `Atox-0.1.42-arm64.dmg`.
 */
const BUILDS = {
  arm64: { platform: 'mac', arch: 'arm64', update: /\.zip$/, download: () => '.dmg' },
  x64: { platform: 'mac', arch: 'x64', update: /\.zip$/, download: () => '.dmg' },
  linux: { platform: 'linux', arch: 'x64', update: /\.AppImage$/, download: () => '.AppImage' },
  windows: { platform: 'windows', arch: 'x64', update: /\.exe$/, download: () => '.exe' },
  // В имени AppImage архитектура записана по-своему (x86_64), в имени пакета pacman — как x64.
  pacman: {
    platform: 'linux',
    arch: 'x64',
    update: /-[^-]+\.AppImage$/,
    download: (arch) => `-${arch}.pacman`
  }
}

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = join(ROOT, 'public')
const PAGES_DIR = join(ROOT, 'pages')
const PARTIALS_DIR = join(ROOT, 'partials')

/** Страницы сайта: адрес → файл и пункт меню, который на ней подсвечен. */
const PAGES = {
  '/': { file: 'index.html', nav: 'home' },
  '/features': { file: 'features.html', nav: 'features' },
  '/about': { file: 'about.html', nav: 'about' },
  '/download': { file: 'download.html', nav: 'download' },
  '/terms': { file: 'terms.html', nav: null },
  '/privacy': { file: 'privacy.html', nav: null }
}

/** Старые адреса, которые переехали: ссылки на них не должны ломаться. */
const MOVED_PAGES = {
  '/docs': '/download',
  '/privacy-policy': '/privacy',
  '/tos': '/terms'
}

/**
 * Страницы платных тарифов, которых пока нет: ведут на главную. Переадресация временная —
 * тарифы могут вернуться, и браузеры не должны запомнить её навсегда.
 */
const HIDDEN_PAGES = ['/pricing', '/refunds', '/refund', '/refund-policy']
const NOT_FOUND_PAGE = { file: '404.html', nav: null }

/** Общие куски страниц: метка в странице → файл, который встаёт на её место. */
const PARTIALS = {
  header: 'header.html',
  footer: 'footer.html'
}
const PARTIAL_SLOT = /<!-- (\w+) -->/g

/** Ссылки страницы на свои стили и скрипты: к ним добавляется версия файла. */
const ASSET_REFERENCE = /(href|src)="(\/[^"?#]+\.(?:css|js))"/g

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
}

const HTML = 'text/html; charset=utf-8'

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY'
}

let cachedRelease = null
let cachedAt = 0
let pendingRelease = null

/** Последний релиз: версия и ссылки на файлы по сборкам. При сбое — то, что было. */
async function latestRelease() {
  if (cachedRelease && Date.now() - cachedAt < RELEASE_CACHE_MS) {
    return cachedRelease
  }
  pendingRelease ??= fetchRelease()
    .then((release) => {
      cachedRelease = release
      cachedAt = Date.now()
      return release
    })
    .catch((error) => {
      console.error('Failed to load the latest release', error)
      return cachedRelease
    })
    .finally(() => {
      pendingRelease = null
    })
  return pendingRelease
}

/**
 * Версия и ссылки на файлы последнего релиза. Сборки для Linux и Windows появились не в первом
 * релизе, поэтому их манифестов может не быть — тогда ссылок на них просто нет.
 */
async function fetchRelease() {
  const release = await githubRelease('latest')
  const [mac, linux, windows] = await Promise.all([
    fetchManifest(release, MANIFESTS.mac),
    fetchManifest(release, MANIFESTS.linux).catch(() => null),
    fetchManifest(release, MANIFESTS.windows).catch(() => null)
  ])
  const manifests = { mac, linux, windows }
  const downloads = {}
  for (const [build, { platform, arch, update, download }] of Object.entries(BUILDS)) {
    const name = manifests[platform]?.files?.[arch]?.name
    if (typeof name === 'string' && update.test(name)) {
      downloads[build] = `${UPDATES_PATH}/${release.tag}/${name.replace(update, download(arch))}`
    }
  }
  return { version: String(mac.version ?? ''), downloads }
}

/** Манифест обновлений из файлов релиза. */
async function fetchManifest(release, name) {
  const response = await fetch(await assetUrl(release, name), {
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`GitHub responded with ${response.status} for ${name}`)
  }
  return response.json()
}

function githubFetch(path, init = {}) {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      ...init.headers
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
  })
}

/** Запоминает ответы на время и не повторяет одинаковые запросы, пока первый не ответил. */
function cached(load) {
  const entries = new Map()
  return (key, ttl) => {
    const entry = entries.get(key)
    if (entry && Date.now() - entry.at < ttl) {
      return entry.value
    }
    const value = load(key).catch((error) => {
      entries.delete(key)
      throw error
    })
    entries.set(key, { value, at: Date.now() })
    return value
  }
}

/** Нет такого релиза или файла: запрос не повторяется, отвечаем «не найдено». */
class NotFoundError extends Error {}

/**
 * Релиз по тегу (`latest` — последний): его тег и файлы по имени. Отсутствие релиза
 * не запоминается — релиз мог как раз выйти.
 */
const loadRelease = cached(async (tag) => {
  const response = await githubFetch(tag === 'latest' ? '/releases/latest' : `/releases/tags/${tag}`)
  if (response.status === 404) {
    throw new NotFoundError(`Release ${tag} not found`)
  }
  if (!response.ok) {
    throw new Error(`GitHub responded with ${response.status} for release ${tag}`)
  }
  const release = await response.json()
  return {
    tag: release.tag_name,
    assets: new Map(release.assets.map((asset) => [asset.name, asset.id]))
  }
})

function githubRelease(tag) {
  return loadRelease(tag, tag === 'latest' ? LATEST_TAG_CACHE_MS : TAGGED_RELEASE_CACHE_MS)
}

/** Временная ссылка GitHub на файл релиза: по ней файл скачивается без токена. */
const loadAssetUrl = cached(async (id) => {
  const response = await githubFetch(`/releases/assets/${id}`, {
    headers: { Accept: 'application/octet-stream' },
    redirect: 'manual'
  })
  const location = response.headers.get('location')
  if (!location) {
    throw new Error(`GitHub did not return a download link for asset ${id} (${response.status})`)
  }
  return location
})

async function assetUrl(release, name) {
  const id = release.assets.get(name)
  if (id === undefined) {
    throw new NotFoundError(`Release ${release.tag} has no file ${name}`)
  }
  return loadAssetUrl(id, ASSET_URL_CACHE_MS)
}

/** Страница с общими кусками; пункт меню текущей страницы отмечен для подсветки. */
async function renderPage({ file, nav }) {
  const page = await readFile(join(PAGES_DIR, file), 'utf-8')
  const names = [...new Set([...page.matchAll(PARTIAL_SLOT)].map(([, name]) => name))].filter(
    (name) => Object.hasOwn(PARTIALS, name)
  )
  const partials = new Map(
    await Promise.all(
      names.map(async (name) => [name, await readFile(join(PARTIALS_DIR, PARTIALS[name]), 'utf-8')])
    )
  )
  const html = page.replace(PARTIAL_SLOT, (slot, name) => {
    const partial = partials.get(name)
    if (partial === undefined) {
      return slot
    }
    return name === 'header' && nav
      ? partial.replace(`data-nav="${nav}"`, `data-nav="${nav}" aria-current="page"`)
      : partial
  })
  return versionAssets(html)
}

/**
 * Добавляет к ссылкам на стили и скрипты версию файла: изменённый файл получает новый адрес,
 * и браузер не может показать устаревший из своего кэша.
 */
async function versionAssets(html) {
  const paths = [...new Set([...html.matchAll(ASSET_REFERENCE)].map(([, , path]) => path))]
  const versions = new Map(
    await Promise.all(
      paths.map(async (path) => [path, await assetVersion(join(PUBLIC_DIR, path)).catch(() => null)])
    )
  )
  return html.replace(ASSET_REFERENCE, (match, attribute, path) => {
    const version = versions.get(path)
    return version ? `${attribute}="${path}?v=${version}"` : match
  })
}

/** Версия файла по размеру и времени изменения — меняется вместе с содержимым. */
async function assetVersion(filePath) {
  const info = await stat(filePath)
  return `${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}`
}

function send(response, status, headers, body) {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers })
  response.end(body)
}

function redirect(response, location, status = 302) {
  send(response, status, { Location: location, 'Cache-Control': 'no-store' })
}

async function handleDownload(response, build) {
  const release = await latestRelease()
  // Без сведений о релизе человек возвращается на страницу скачивания.
  redirect(response, release?.downloads[build] ?? '/download')
}

/**
 * Файл релиза для приложения и страницы скачивания: переадресация на временную ссылку GitHub,
 * так что сам файл идёт с серверов GitHub, а не через этот сервер.
 */
async function handleUpdateFile(response, tag, name) {
  try {
    redirect(response, await assetUrl(await githubRelease(tag), name))
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error
    }
    send(response, 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, 'Not found')
  }
}

async function handleReleaseInfo(response) {
  const release = await latestRelease()
  send(
    response,
    release ? 200 : 503,
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    JSON.stringify(release ? { version: release.version } : {})
  )
}

async function handlePage(response, page, status = 200) {
  send(response, status, { 'Content-Type': HTML, 'Cache-Control': 'no-cache' }, await renderPage(page))
}

async function handleStatic(request, response, pathname, versioned) {
  const filePath = normalize(join(PUBLIC_DIR, decodeURIComponent(pathname)))
  // Путь вида /../ не должен выводить за пределы папки сайта.
  const inside = filePath.startsWith(PUBLIC_DIR + sep)
  const type = CONTENT_TYPES[extname(filePath)]
  if (inside && type) {
    try {
      const etag = `"${await assetVersion(filePath)}"`
      // Адрес с версией меняется вместе с файлом — его можно хранить сколько угодно. Без версии
      // браузер каждый раз сверяется с сервером и не скачивает неизменившийся файл заново.
      const cache = versioned ? 'public, max-age=31536000, immutable' : 'no-cache'
      const headers = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag }
      if (request.headers['if-none-match'] === etag) {
        return send(response, 304, headers)
      }
      return send(response, 200, headers, await readFile(filePath))
    } catch {
      // Ниже — общая страница «не найдено».
    }
  }
  await handlePage(response, NOT_FOUND_PAGE, 404)
}

const server = createServer(async (request, response) => {
  const { pathname, searchParams } = new URL(request.url ?? '/', 'http://localhost')
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return send(response, 405, { Allow: 'GET, HEAD' })
  }
  try {
    // Адрес со слешем на конце ведёт туда же, что и без него.
    if (pathname.length > 1 && pathname.endsWith('/')) {
      return redirect(response, pathname.replace(/\/+$/, ''), 301)
    }
    const [, section, build, file, ...rest] = pathname.split('/')
    if (section === 'download' && Object.hasOwn(BUILDS, build)) {
      return await handleDownload(response, build)
    }
    if (`/${section}` === UPDATES_PATH && RELEASE_TAG.test(build ?? '') && ASSET_NAME.test(file ?? '') && rest.length === 0) {
      return await handleUpdateFile(response, build, file)
    }
    if (MOVED_PAGES[pathname]) {
      return redirect(response, MOVED_PAGES[pathname], 301)
    }
    if (HIDDEN_PAGES.includes(pathname)) {
      return redirect(response, '/')
    }
    if (pathname === '/api/release') {
      return await handleReleaseInfo(response)
    }
    if (pathname === '/health') {
      return send(response, 200, { 'Content-Type': 'text/plain' }, 'ok')
    }
    const page = PAGES[pathname]
    if (page) {
      return await handlePage(response, page)
    }
    await handleStatic(request, response, pathname, searchParams.has('v'))
  } catch (error) {
    console.error('Request failed', pathname, error)
    if (!response.headersSent) {
      send(response, 500, { 'Content-Type': 'text/plain' }, 'Something went wrong')
    }
  }
})

server.listen(PORT, () => console.log(`Atox site is listening on port ${PORT}`))
