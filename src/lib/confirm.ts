import { Alert, Platform } from 'react-native';

import { t } from '@/lib/lang';

/** Asks before a destructive action. Resolves true if the person confirms. */
export function confirmAction(title: string, message: string, confirmLabel: string, cancelLabel = t('Keep it')) {
  if (Platform.OS === 'web') {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise<boolean>((resolve) => {
    Alert.alert(title, message, [
      { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
}
