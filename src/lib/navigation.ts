import { router, type Href } from 'expo-router';

/**
 * After signing in or up: go back to the screen that asked for it (a shop
 * page keeps the slot the customer picked), or to `next`, or home.
 * Only in-app paths are accepted for `next`.
 */
export function returnAfterAuth(next?: string) {
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : undefined;
  if (safeNext && router.canGoBack()) {
    router.back();
    return;
  }
  router.replace((safeNext ?? '/') as Href);
}
