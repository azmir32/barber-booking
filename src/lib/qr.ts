// QR codes for the shop's booking link. The app draws them itself (as Views
// on screen, as SVG on the printed poster) from one matrix, so the preview
// and the poster are the same code and no image files are needed.

import makeQr from 'qrcode-generator';

/** White border scanners need around the code, in modules (the QR standard asks for 4). */
export const QUIET_ZONE = 4;

/**
 * Which modules are dark, row by row. Medium error correction still scans
 * with a smudge or a crease on a poster. Booking links are plain ASCII (slugs
 * are a-z, 0-9 and dashes), which is what the encoder expects.
 */
export function qrMatrix(text: string): boolean[][] {
  const qr = makeQr(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, col) => qr.isDark(row, col)));
}

export type QrRun = { row: number; col: number; length: number };

/** Each row's dark modules joined into runs, so drawing takes one box per run rather than one per module. */
export function qrRuns(matrix: boolean[][]): QrRun[] {
  const runs: QrRun[] = [];
  matrix.forEach((cells, row) => {
    let col = 0;
    while (col < cells.length) {
      if (!cells[col]) {
        col += 1;
        continue;
      }
      let end = col;
      while (end < cells.length && cells[end]) end += 1;
      runs.push({ row, col, length: end - col });
      col = end;
    }
  });
  return runs;
}

/** The code as black-on-white SVG with its quiet zone, sized by whatever holds it (it has no width or height). */
export function qrSvg(matrix: boolean[][]): string {
  const side = matrix.length + QUIET_ZONE * 2;
  const path = qrRuns(matrix)
    .map((r) => `M${r.col + QUIET_ZONE} ${r.row + QUIET_ZONE}h${r.length}v1h-${r.length}z`)
    .join('');
  // crispEdges keeps neighbouring rows from showing hairline gaps when scaled.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" aria-hidden="true">` +
    `<rect width="${side}" height="${side}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}
