import { Alert, Platform } from 'react-native';

import { t } from '@/lib/lang';

export type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  resolve: (ok: boolean) => void;
};

let showOnWeb: ((request: ConfirmRequest) => void) | null = null;

/** Lets <ConfirmHost /> show web confirmations as a dialog inside the app. */
export function setConfirmHost(show: ((request: ConfirmRequest) => void) | null) {
  showOnWeb = show;
}

/** Asks before a destructive action. Resolves true if the person confirms. */
export function confirmAction(title: string, message: string, confirmLabel: string, cancelLabel = t('Keep it')) {
  if (Platform.OS === 'web') {
    // window.confirm is plain, can't name the buttons and is blocked in some
    // embedded browsers, so the web uses the app's own dialog when it's mounted.
    return new Promise<boolean>((resolve) => {
      if (showOnWeb) showOnWeb({ title, message, confirmLabel, cancelLabel, resolve });
      else resolve(window.confirm(`${title}\n\n${message}`));
    });
  }
  return new Promise<boolean>((resolve) => {
    Alert.alert(title, message, [
      { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
}
