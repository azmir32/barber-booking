// Answers that come back out of order on a slow line: only the latest ask's
// answer counts, and a change made in the app after an ask was sent is newer
// than what that ask brings back. Kept free of React Native imports so a
// plain node test can check it.

/** What to check when an answer comes back. */
export type Ask = {
  /** No other ask was sent after this one. */
  latest(): boolean;
  /** Something was changed here after this ask was sent. */
  changedSince(): boolean;
};

export function createAsks() {
  let asked = 0;
  let changes = 0;
  return {
    /** Just before sending a request. */
    ask(): Ask {
      const n = ++asked;
      const seen = changes;
      return { latest: () => n === asked, changedSince: () => changes !== seen };
    },
    /** A change made here, newer than the answer to any ask already sent. */
    changed() {
      changes += 1;
    },
  };
}
