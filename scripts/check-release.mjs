// Runs before EAS installs packages (the eas-build-pre-install hook in
// package.json). A store build without these would ship an app that can't
// sign anyone in, or whose "Keep my shop live" button WhatsApps nobody.
const profile = process.env.EAS_BUILD_PROFILE;
const needed = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY', 'EXPO_PUBLIC_SUPPORT_WHATSAPP'];

if (profile === 'production') {
  const missing = needed.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    console.error(`Set ${missing.join(', ')} for the production build (see .env.example and the README).`);
    process.exit(1);
  }
}
