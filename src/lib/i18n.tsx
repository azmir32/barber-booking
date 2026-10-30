import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { getLang, setCurrentLang, type Lang } from '@/lib/lang';

const STORAGE_KEY = 'potongku.language';

type LanguageState = { lang: Lang; setLang: (lang: Lang) => void };

const LanguageContext = createContext<LanguageState | null>(null);

function applyLang(lang: Lang) {
  setCurrentLang(lang);
  AsyncStorage.setItem(STORAGE_KEY, lang).catch(() => {});
}

/**
 * Loads the saved language (else the phone's) and re-renders the whole app
 * when it changes, so every t() and date picks up the new language.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(getLang);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (saved === 'en' || saved === 'ms') {
          setCurrentLang(saved);
          setLangState(saved);
        }
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  // Tells the browser and screen readers which language the page is in.
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') document.documentElement.lang = lang;
  }, [lang]);

  if (!ready) return null;

  const setLang = (next: Lang) => {
    applyLang(next);
    setLangState(next);
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang }}>
      <Fragment key={lang}>{children}</Fragment>
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageState {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used inside LanguageProvider');
  return ctx;
}
