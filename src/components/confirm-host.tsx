import { useEffect, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';

import { Button, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { setConfirmHost, type ConfirmRequest } from '@/lib/confirm';

/** Shows confirmAction's questions on the web, as a dialog inside the app. */
export function ConfirmHost() {
  const theme = useTheme();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    setConfirmHost(setRequest);
    return () => setConfirmHost(null);
  }, []);

  if (!request) return null;
  const answer = (ok: boolean) => {
    request.resolve(ok);
    setRequest(null);
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => answer(false)}>
      <View style={styles.backdrop}>
        <View
          role="alertdialog"
          aria-modal
          aria-label={request.title}
          style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <T variant="heading">{request.title}</T>
          <T variant="muted">{request.message}</T>
          <View style={styles.actions}>
            {/* The safe answer comes first, so it is the one keyboard focus reaches first. */}
            <Button title={request.cancelLabel} variant="secondary" onPress={() => answer(false)} />
            <Button title={request.confirmLabel} variant="danger" onPress={() => answer(true)} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  card: { width: '100%', maxWidth: 420, borderRadius: 16, borderWidth: 1, padding: Spacing.lg, gap: Spacing.md },
  actions: { gap: Spacing.sm, marginTop: Spacing.sm },
});
