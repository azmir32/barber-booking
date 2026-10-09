// On the web expo-print can only print the page itself, so the document goes
// into a hidden frame of its own and that frame is printed.

/** How long to wait for the frame to load, and then for the browser to start printing, before giving up. */
const LOAD_TIMEOUT = 5000;
const START_TIMEOUT = 1000;
/** Removes the frame then even if the browser never says printing finished. */
const CLEANUP_AFTER = 60_000;
const STEP = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens the print window. Resolves true once it opens; throws if the browser won't print. */
export async function printHtml(html: string): Promise<boolean> {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Zero size rather than display: none, which some browsers print blank.
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  try {
    await new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve();
      setTimeout(() => reject(new Error('The print frame did not load.')), LOAD_TIMEOUT);
      frame.srcdoc = html;
      document.body.appendChild(frame);
    });
    const win = frame.contentWindow;
    if (!win) throw new Error('The print frame did not load.');
    // The frame's print events only set flags: Chrome drops promise and React
    // work queued from inside them, which froze the whole app.
    let started = false;
    let finished = false;
    win.addEventListener('beforeprint', () => (started = true));
    win.addEventListener('afterprint', () => (finished = true));
    win.focus();
    win.print();
    // print() returns when the print window closes, or straight away in some
    // browsers, which start a moment later. A sandboxed page (like the demo)
    // ignores it without an error, so only beforeprint shows it worked.
    for (let waited = 0; !started && waited < START_TIMEOUT; waited += STEP) await sleep(STEP);
    if (!started) throw new Error('The browser did not open the print window.');
    // Removing the frame while the print window is open would cancel it.
    const removeAt = Date.now() + CLEANUP_AFTER;
    const timer = setInterval(() => {
      if (!finished && Date.now() < removeAt) return;
      clearInterval(timer);
      frame.remove();
    }, 500);
    return true;
  } catch (e) {
    frame.remove();
    throw e;
  }
}
