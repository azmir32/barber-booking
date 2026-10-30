// Prints a complete HTML document, such as the shop poster, through the
// phone's print window. The web has its own version in print-html.web.ts.

import * as Print from 'expo-print';

/**
 * A4 at 96 px per inch, the size browsers lay A4 out at, so the poster looks
 * the same printed from a phone; iOS scales the page down to the paper.
 */
const PAGE = { width: 794, height: 1123 };

/** Opens the print window. Resolves false if the person closed it without printing; throws if printing can't start. */
export async function printHtml(html: string): Promise<boolean> {
  try {
    await Print.printAsync({ html, ...PAGE });
    return true;
  } catch (e) {
    // iOS rejects when the print window is closed without printing, which is not a failure.
    if ((e as { code?: string } | null)?.code === 'ERR_PRINT_INCOMPLETE') return false;
    throw e;
  }
}
