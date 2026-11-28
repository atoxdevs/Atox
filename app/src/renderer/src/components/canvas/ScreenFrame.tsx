import { memo, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { Grid3x3, Pencil, Trash2, TriangleAlert, Wrench } from 'lucide-react'
import {
  CANVAS_NAME_MAX_LENGTH,
  canvasScreenUrl,
  effectiveScreenGrid,
  SCREEN_DEVICES,
  type CanvasScreen,
  type ScreenFrame as FrameKind
} from '../../../../shared/canvas'
import { FRAME_INSETS, screenFrame, type Point } from '../../lib/canvasView'
import { showMenu } from '../../lib/menu'
import { InlineRename } from '../InlineRename'
import { ScreenGridOverlay } from './ScreenGridOverlay'

type ScreenAction = 'fix' | 'tools' | 'rename' | 'remove'

interface ScreenFrameProps {
  canvasId: string
  screen: CanvasScreen
  /** Где стоит экран: пока его тянут, позиция отличается от сохранённой. */
  position: Point
  selected: boolean
  /** Рабочий экран: выбран двойным кликом, у него открыта панель инструментов. */
  working: boolean
  /** Экран тянут прямо сейчас. */
  dragging: boolean
  /** Версия из истории, которую показывает экран вместо текущей. */
  previewVersionId: string | null
  onPointerDown(screenId: string, event: PointerEvent<HTMLElement>): void
  /** Подводит холст к экрану — с клавиатуры; мышью это решает `onPointerDown`. */
  onFocus(screenId: string): void
  /** «Fix» из меню экрана: открывает окно просьбы к агенту. */
  onFix(screenId: string): void
  /** «Screen tools» из меню экрана: делает его рабочим, как двойной клик. */
  onWork(screenId: string): void
}

/** Подпись устройства: «iPhone 390 × 844», у своего размера — «Custom 500 × 300». */
export function describeDevice(screen: Pick<CanvasScreen, 'device' | 'width' | 'height'>): string {
  const name = screen.device === 'custom' ? 'Custom' : SCREEN_DEVICES[screen.device].name
  return `${name} ${screen.width} × ${screen.height}`
}

/**
 * Экран на холсте: подпись над ним, рамка устройства и сам HTML в iframe. Поверх iframe лежит
 * прозрачный слой: человек не нажимает кнопки дизайна, а двигает экран, подходит к нему кликом
 * и по правой кнопке выбирает «Fix», переименование или удаление. Двойной клик делает экран
 * рабочим. Сетка экрана (инструмент Grid) лежит над iframe и в саму страницу не попадает.
 */
export const ScreenFrame = memo(function ScreenFrame({
  canvasId,
  screen,
  position,
  selected,
  working,
  dragging,
  previewVersionId,
  onPointerDown,
  onFocus,
  onFix,
  onWork
}: ScreenFrameProps) {
  const [renaming, setRenaming] = useState(false)
  const frame = screenFrame(screen)
  const insets = FRAME_INSETS[frame]
  const frameWidth = screen.width + insets.left + insets.right
  const grid = effectiveScreenGrid(screen)
  const style = {
    transform: `translate(${position.x}px, ${position.y}px)`,
    width: frameWidth,
    height: screen.height + insets.top + insets.bottom,
    '--frame-width': frameWidth,
    '--frame-top': `${insets.top}px`,
    '--frame-side': `${insets.left}px`
  } as CSSProperties

  const rename = (name: string) => {
    setRenaming(false)
    void window.atox.canvas.renameScreen(canvasId, screen.id, name.slice(0, CANVAS_NAME_MAX_LENGTH))
  }

  const openMenu = async (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    const action = await showMenu<ScreenAction>(
      [
        { action: 'fix', label: 'Fix…', icon: <Wrench /> },
        { action: 'tools', label: 'Screen tools', icon: <Grid3x3 /> },
        { action: 'rename', label: 'Rename', icon: <Pencil /> },
        { type: 'separator' },
        { action: 'remove', label: 'Remove from canvas…', icon: <Trash2 />, destructive: true }
      ],
      event
    )
    if (action === 'fix') {
      onFix(screen.id)
    } else if (action === 'tools') {
      onWork(screen.id)
    } else if (action === 'rename') {
      setRenaming(true)
    } else if (action === 'remove') {
      void window.atox.canvas.removeScreen(canvasId, screen.id)
    }
  }

  return (
    <div
      className="canvas-screen"
      data-screen-id={screen.id}
      data-frame={frame}
      data-selected={selected}
      data-working={working}
      data-dragging={dragging}
      style={style}
    >
      <div className="canvas-screen__label">
        {renaming ? (
          <InlineRename
            value={screen.name}
            label="Screen name"
            onSubmit={rename}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span
            className="canvas-screen__name"
            title="Double-click to rename"
            onDoubleClick={() => setRenaming(true)}
          >
            {screen.name}
          </span>
        )}
        <span className="canvas-screen__device">{describeDevice(screen)}</span>
        {screen.missing && <ScreenNote text="File not found, showing the last saved version" />}
        {screen.buildError && (
          <span className="canvas-screen__badge" title={screen.buildError}>
            Build error
          </span>
        )}
        {previewVersionId && <span className="canvas-screen__tag">Older version</span>}
        {working && <span className="canvas-screen__tag">Working</span>}
      </div>
      <div className="canvas-screen__device-frame">
        <DeviceChrome frame={frame} file={screen.file} />
        <iframe
          className="canvas-screen__content"
          title={screen.name}
          sandbox="allow-scripts"
          tabIndex={-1}
          src={canvasScreenUrl(canvasId, screen.id, screen.revision, previewVersionId ?? undefined)}
          style={{ width: screen.width, height: screen.height }}
        />
        {grid.visible && (
          <ScreenGridOverlay
            width={screen.width}
            height={screen.height}
            columns={grid.columns}
            rows={grid.rows}
          />
        )}
        {frame === 'phone' && <span className="canvas-screen__island" aria-hidden />}
      </div>
      <button
        type="button"
        className="canvas-screen__overlay"
        aria-label={`Go to ${screen.name}`}
        aria-haspopup="menu"
        onPointerDown={(event) => onPointerDown(screen.id, event)}
        onContextMenu={(event) => void openMenu(event)}
        // Клик мышью уже обработан протяжкой; здесь — Enter и пробел (у них `detail` равен 0).
        onClick={(event) => event.detail === 0 && onFocus(screen.id)}
      />
      {(selected || working) && <div className="canvas-screen__ring" aria-hidden />}
    </div>
  )
})

/** Тихое предупреждение в подписи экрана. */
function ScreenNote({ text }: { text: string }) {
  return (
    <span className="canvas-screen__note" title={text}>
      <TriangleAlert className="icon" aria-hidden />
      <span className="canvas-screen__note-text">{text}</span>
    </span>
  )
}

/** Полоса окна или браузера над экраном: кнопки светофора и адрес. */
function DeviceChrome({ frame, file }: { frame: FrameKind; file: string }) {
  if (frame !== 'window' && frame !== 'browser') {
    return null
  }
  return (
    <div className="canvas-screen__chrome" aria-hidden>
      <span className="canvas-screen__lights">
        <i />
        <i />
        <i />
      </span>
      {frame === 'browser' && (
        <span className="canvas-screen__address">{file.split(/[\\/]/).pop()}</span>
      )}
    </div>
  )
}
