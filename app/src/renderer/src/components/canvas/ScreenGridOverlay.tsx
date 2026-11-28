import { memo, type CSSProperties } from 'react'
import type { ScreenGridParts } from '../../../../shared/canvas'

interface ScreenGridOverlayProps {
  width: number
  height: number
  columns: ScreenGridParts
  rows: ScreenGridParts
}

/** Вес линии: центр (1/2), четверти (1/4 и 3/4, когда частей от 8) и остальные. */
type LineWeight = 'cross' | 'quarter' | 'fine'

function weightOf(index: number, parts: number): LineWeight {
  if (index * 2 === parts) {
    return 'cross'
  }
  return parts >= 8 && (index * 4 === parts || index * 4 === parts * 3) ? 'quarter' : 'fine'
}

/**
 * Пути линий одной оси по весам. Линия `k` стоит ровно на `k / parts` стороны: координата
 * считается от края для каждой линии отдельно, без накопления шага, поэтому части равны.
 */
function linesOf(
  parts: number,
  side: number,
  across: number,
  vertical: boolean,
  paths: Record<LineWeight, string[]>
): void {
  for (let index = 1; index < parts; index += 1) {
    const at = (side * index) / parts
    paths[weightOf(index, parts)].push(vertical ? `M${at} 0V${across}` : `M0 ${at}H${across}`)
  }
}

/**
 * Сетка поверх экрана: делит его на равные части, центральный крест — акцентом. Слой холста в
 * координатах страницы (px экрана), линии — постоянной толщины в пикселях окна при любом
 * масштабе. Каждая линия — тёмная середина со светлой каймой, поэтому видна на любой странице.
 * Мышь проходит насквозь; в страницу, выгрузку, ссылку и миниатюры сетка не попадает.
 */
export const ScreenGridOverlay = memo(function ScreenGridOverlay({
  width,
  height,
  columns,
  rows
}: ScreenGridOverlayProps) {
  const paths: Record<LineWeight, string[]> = { cross: [], quarter: [], fine: [] }
  linesOf(columns, width, height, true, paths)
  linesOf(rows, height, width, false, paths)
  const fine = paths.fine.join('')
  const quarter = paths.quarter.join('')
  const cross = paths.cross.join('')
  // Самая узкая доля в px страницы: толще её восьмой части линии не бывают.
  const part = Math.min(width / columns, height / rows)

  return (
    <div className="canvas-screen__grid" aria-hidden style={{ width, height }}>
      <svg
        className="screen-grid"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ '--grid-part': `${part}px` } as CSSProperties}
      >
        <path className="screen-grid__halo" d={fine + quarter} />
        <path className="screen-grid__halo screen-grid__halo--cross" d={cross} />
        <path className="screen-grid__line" d={fine} />
        <path className="screen-grid__line screen-grid__line--quarter" d={quarter} />
        <path className="screen-grid__line screen-grid__line--cross" d={cross} />
      </svg>
    </div>
  )
})
