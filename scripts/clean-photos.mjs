// Removes photo files no photo points at any more, a day after they came:
// left by an upload whose photo was never saved, a removal whose files didn't
// go, or a shop deleted outside the app (README, "Photos of the shop's cuts").
// Run it now and then, or daily from a cron job:
//
//   SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/clean-photos.mjs
//
// Add --dry-run to list them without removing anything. The service role key
// is the only one that may list them; keep it off phones and out of the app.
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dryRun = process.argv.includes('--dry-run');
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (Project Settings, API keys).');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const bucket = supabase.storage.from('shop-photos');
const PAGE = 1000;
// Storage removes a list of files per request; smaller lists keep each one quick.
const CHUNK = 100;

let removed = 0;
const tried = new Set();
for (;;) {
  const { data, error } = await supabase.rpc('shop_photo_files_left_behind', { p_limit: PAGE });
  if (error) {
    console.error(`Couldn't list the files: ${error.message}`);
    process.exit(1);
  }
  const names = data ?? [];
  // One listed again was removed without going, so asking again would loop.
  const again = names.find((name) => tried.has(name));
  if (again) {
    console.error(`${again} is still there after removing it; stopped after ${removed}.`);
    process.exit(1);
  }
  for (const name of names) tried.add(name);
  if (dryRun) {
    for (const name of names) console.log(name);
    console.log(`${names.length} file(s) to remove${names.length === PAGE ? ' (the first page)' : ''}.`);
    break;
  }
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    const { error: failed } = await bucket.remove(chunk);
    if (failed) {
      console.error(`Couldn't remove ${chunk.length} file(s) after ${removed}: ${failed.message}`);
      process.exit(1);
    }
    removed += chunk.length;
  }
  // A short page is the last one.
  if (names.length < PAGE) break;
}
if (!dryRun) console.log(`Removed ${removed} file(s) no photo points at.`);
