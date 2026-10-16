import AsyncStorage from '@react-native-async-storage/async-storage';

import { createCache } from '@/lib/cache';

/** The app's one cache of last answers (see cache.ts), kept in AsyncStorage. */
export const appCache = createCache(AsyncStorage);
