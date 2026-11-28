import { useState } from 'react'
import { ChevronDown, Grid3x3, Link2, Ruler, Unlink2, X } from 'lucide-react'
import {
  SCREEN_DEVICES,
  SCREEN_GRID_PARTS,
  SCREEN_SIZE,
  describeScreenGrid,
  devicesOf,
  effectiveScreenGrid,
  type CanvasScreen,
  type DeviceCategory,
  type ScreenGrid,
  type ScreenGridParts,
  type ScreenResize
} from '../../../../shared/canvas'
import { ipcErrorMessage } from '../../lib/ipcError'
import { showMenu, type MenuItem } from '../../lib/menu'
import { describeDevice } from './ScreenFrame'

interface ScreenToolsPanelProps {
  canvasId: string
  screen: CanvasScreen
  onClose(): void
}

const PRESET_SECTIONS: { category: DeviceCategory; label: string }[] = [
  { category: 'phone', label: 'Phone' },
  { category: 'tablet', label: 'Tablet' },
  { category: 'desktop', label: 'Desktop' },
  { category: 'document', label: 'Slide & page' }
]

/**
 * Панель рабочего экрана (двойной клик по экрану): инструменты, которые помогают работать с ним
 * на холсте. Размер — меняет сам экран на холсте (его ширину и высоту), а не HTML. Сетка — равные
 * части поверх экрана (половины, четверти, восьмые…) с выделенным центральным крестом.
 * Настройки хранятся у экрана и переживают перезапуск, а сама страница от сетки не меняется.
 */
export function ScreenToolsPanel({ canvasId, screen, onClose }: ScreenToolsPanelProps) {
  const [error, setError] = useState<string | null>(null)
  const grid = effectiveScreenGrid(screen)
  // Связка осей: одно число частей и для ширины, и для высоты. Разные числа у сетки (их поставил
  // человек раньше или агент) — оси развязаны.
  const [linkChoice, setLinkChoice] = useState(true)
  const linked = linkChoice && grid.columns === grid.rows

  const run = (action: Promise<void>) => {
    setError(null)
    action.catch((failure: unknown) => setError(ipcErrorMessage(failure)))
  }
  const saveGrid = (next: ScreenGrid) =>
    run(window.atox.canvas.setScreenGrid(canvasId, screen.id, next))
  const resize = (look: ScreenResize) => run(window.atox.canvas.resizeScreen(canvasId, screen.id, look))

  // Новое число частей сразу показывает сетку: иначе выбор ничего бы не изменил на экране.
  const pick = (axis: 'both' | 'columns' | 'rows', parts: ScreenGridParts) => {
    const next: ScreenGrid = {
      visible: true,
      columns: axis === 'rows' ? grid.columns : parts,
      rows: axis === 'columns' ? grid.rows : parts
    }
    if (next.columns !== grid.columns || next.rows !== grid.rows || !grid.visible) {
      saveGrid(next)
    }
  }

  const toggleLink = () => {
    if (!linked && grid.columns !== grid.rows) {
      // Связали заново: высота делится так же, как ширина.
      saveGrid({ ...grid, rows: grid.columns })
    }
    setLinkChoice(!linked)
  }

  const openPresets = async (anchor: HTMLElement) => {
    const items: MenuItem<string>[] = PRESET_SECTIONS.map(({ category, label }) => ({
      type: 'submenu',
      label,
      items: devicesOf(category).map((id) => {
        const device = SCREEN_DEVICES[id]
        return {
          action: id,
          label: `${device.name} · ${device.width} × ${device.height}`,
          checked: screen.device === id
        }
      })
    }))
    const action = await showMenu(items, anchor)
    if (action && action in SCREEN_DEVICES) {
      resize({ device: action as keyof typeof SCREEN_DEVICES })
    }
  }

  return (
    <aside className="screen-tools" aria-label={`Tools for ${screen.name}`}>
      <header className="screen-tools__header">
        <div className="screen-tools__heading">
          <h2 className="screen-tools__title">{screen.name}</h2>
          <span className="screen-tools__subtitle">{describeDevice(screen)}</span>
        </div>
        <button
          type="button"
          className="icon-button screen-tools__close"
          aria-label="Close screen tools"
          title="Close (Esc)"
          onClick={onClose}
        >
          <X className="icon" aria-hidden />
        </button>
      </header>

      <section className="screen-tools__section" aria-labelledby="screen-tools-size">
        <div className="screen-tools__row">
          <Ruler className="icon screen-tools__icon" aria-hidden />
          <span id="screen-tools-size" className="screen-tools__label">
            Size
          </span>
          <button
            type="button"
            className="screen-tools__presets"
            aria-haspopup="menu"
            onClick={(event) => void openPresets(event.currentTarget)}
          >
            <span>Presets</span>
            <ChevronDown className="icon" aria-hidden />
          </button>
        </div>
        <SizeForm
          // Размер поменялся снаружи (пресет, агент): поля начинаются с нового.
          key={`${screen.width}x${screen.height}`}
          width={screen.width}
          height={screen.height}
          onSubmit={(width, height) => resize({ device: 'custom', width, height })}
        />
      </section>

      <section className="screen-tools__section" aria-labelledby="screen-tools-grid">
        <label className="screen-tools__row">
          <Grid3x3 className="icon screen-tools__icon" aria-hidden />
          <span id="screen-tools-grid" className="screen-tools__label">
            Grid
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={grid.visible}
            onChange={(event) => saveGrid({ ...grid, visible: event.target.checked })}
          />
        </label>
        <div className="screen-tools__parts">
          <PartsPicker
            label={linked ? 'Parts' : 'Columns'}
            value={grid.columns}
            onPick={(parts) => pick(linked ? 'both' : 'columns', parts)}
          />
          <button
            type="button"
            className="screen-tools__link"
            aria-pressed={linked}
            aria-label={linked ? 'Unlink columns and rows' : 'Link columns and rows'}
            title={
              linked
                ? 'Columns and rows are linked. Click to set them separately'
                : 'Link columns and rows'
            }
            onClick={toggleLink}
          >
            {linked ? <Link2 className="icon" aria-hidden /> : <Unlink2 className="icon" aria-hidden />}
          </button>
          {!linked && (
            <PartsPicker label="Rows" value={grid.rows} onPick={(parts) => pick('rows', parts)} />
          )}
        </div>
        <p className="screen-tools__hint">
          {describeScreenGrid(grid)}, each {formatPx(screen.width / grid.columns)} ×{' '}
          {formatPx(screen.height / grid.rows)} px, with a highlighted centre cross. Only on the
          canvas: the page, export and share link stay unchanged.
        </p>
      </section>
      {error && (
        <p className="screen-tools__error" role="alert">
          {error}
        </p>
      )}
    </aside>
  )
}

/** Ряд «2 · 4 · 8 · 16 · 32»: на сколько равных частей делится сторона экрана. */
function PartsPicker({
  label,
  value,
  onPick
}: {
  label: string
  value: ScreenGridParts
  onPick(parts: ScreenGridParts): void
}) {
  return (
    <div className="screen-tools__parts-row">
      <span className="screen-tools__parts-label">{label}</span>
      <div
        className="segmented segmented--small screen-tools__segments"
        role="radiogroup"
        aria-label={`Grid ${label.toLowerCase()}`}
      >
        {SCREEN_GRID_PARTS.map((parts) => (
          <button
            key={parts}
            type="button"
            role="radio"
            aria-checked={parts === value}
            className="segmented__item screen-tools__segment"
            title={`${parts} equal parts`}
            onClick={() => onPick(parts)}
          >
            {parts}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Сторона части: целое число или до двух знаков после запятой (390 / 8 = 48.75). */
function formatPx(value: number): string {
  return String(Number(value.toFixed(2)))
}

/** Поля ширины и высоты: Enter или «Apply» меняет размер экрана. */
function SizeForm({
  width,
  height,
  onSubmit
}: {
  width: number
  height: number
  onSubmit(width: number, height: number): void
}) {
  const [draftWidth, setDraftWidth] = useState(String(width))
  const [draftHeight, setDraftHeight] = useState(String(height))
  const nextWidth = parseDimension(draftWidth)
  const nextHeight = parseDimension(draftHeight)
  const changed = nextWidth !== width || nextHeight !== height
  const ready = nextWidth !== null && nextHeight !== null && changed

  return (
    <form
      className="screen-tools__size"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) {
          onSubmit(nextWidth, nextHeight)
        }
      }}
    >
      <input
        className="screen-tools__number"
        type="number"
        inputMode="numeric"
        aria-label="Width"
        min={SCREEN_SIZE.min}
        max={SCREEN_SIZE.max}
        step={1}
        value={draftWidth}
        aria-invalid={nextWidth === null}
        onChange={(event) => setDraftWidth(event.target.value)}
      />
      <span className="screen-tools__times" aria-hidden>
        ×
      </span>
      <input
        className="screen-tools__number"
        type="number"
        inputMode="numeric"
        aria-label="Height"
        min={SCREEN_SIZE.min}
        max={SCREEN_SIZE.max}
        step={1}
        value={draftHeight}
        aria-invalid={nextHeight === null}
        onChange={(event) => setDraftHeight(event.target.value)}
      />
      <button type="submit" className="screen-tools__apply" disabled={!ready}>
        Apply
      </button>
    </form>
  )
}

/** Сторона экрана: целое число в допустимых границах; иначе `null`. */
function parseDimension(value: string): number | null {
  const number = Number(value.trim())
  return value.trim() !== '' &&
    Number.isInteger(number) &&
    number >= SCREEN_SIZE.min &&
    number <= SCREEN_SIZE.max
    ? number
    : null
}
