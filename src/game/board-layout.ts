export type BoardLayout = {
  width: number;
  height: number;
  gap: number;
  tileFontSize: number;
  tileRadius: number;
  lineWidth: number;
};

export function calculateBoardLayout(
  availableWidth: number,
  rows: number,
  columns: number,
  maximumWidth = 620,
): BoardLayout {
  const safeWidth = Math.max(240, Math.min(availableWidth, maximumWidth));
  const safeRows = Math.max(1, rows);
  const safeColumns = Math.max(1, columns);
  const tileWidth = safeWidth / safeColumns;
  const tileHeight = (safeWidth * safeRows) / safeColumns / safeRows;
  const tileSize = Math.min(tileWidth, tileHeight);

  return {
    width: safeWidth,
    height: (safeWidth * safeRows) / safeColumns,
    gap: Math.max(2, Math.min(8, tileSize * 0.08)),
    tileFontSize: Math.max(14, Math.min(64, tileSize * 0.46)),
    tileRadius: Math.max(6, Math.min(20, tileSize * 0.18)),
    lineWidth: Math.max(4, Math.min(9, tileSize * 0.12)),
  };
}
