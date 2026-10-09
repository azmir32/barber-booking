import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Share, StyleSheet, useWindowDimensions, View } from 'react-native';

import { QrCode } from '@/components/qr-code';
import { Button, Card, Row, Screen, T } from '@/components/ui';
import { bookingLink } from '@/constants/brand';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { POSTER_TEXT, posterHtml } from '@/lib/poster';
import { printHtml } from '@/lib/print-html';

// The preview is the paper the poster prints on, so it keeps dark ink on
// white in dark mode too, and a screenshot of it prints the same.
const ink = Colors.light;
const PAPER = '#FFFFFF';
const MAX_QR = 320;

/** A poster for the counter with the shop's QR code, so walk-in customers can scan it and book. */
export default function Poster() {
  const { shop } = useMyShop();
  const { width } = useWindowDimensions();
  const [printing, setPrinting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const now = useNow();

  if (!shop) return null;
  const link = bookingLink(shop.slug);
  // A phone camera opens a web link for anyone; an app link only works for people who have the app.
  const webLink = /^https?:\/\//.test(link);
  // As the database decides (shop_is_live): published, and paid or still in the free month.
  const paid =
    shop.subscription_status === 'active' ||
    (shop.subscription_status === 'trialing' && Date.parse(shop.trial_ends_at) > now);
  // What's left inside the screen's and the card's padding.
  const qrSize = Math.min(MAX_QR, Math.min(width, MaxContentWidth) - Spacing.lg * 4 - Spacing.md);

  async function print() {
    setPrinting(true);
    setNote(null);
    try {
      await printHtml(posterHtml({ shopName: shop!.name, link, area: shop!.area }));
    } catch {
      // Some browsers and the demo don't allow printing; a screenshot does the job.
      setNote(t('Printing didn’t open here. Take a screenshot of the poster above and print or send that instead.'));
    } finally {
      setPrinting(false);
    }
  }

  function share() {
    setNote(null);
    // Browsers without a share sheet get the link copied instead.
    Share.share({ message: t('Book your next cut at {shop}: {link}', { shop: shop!.name, link }) }).catch((e) => {
      if (shareCancelled(e)) return;
      Clipboard.setStringAsync(link)
        .then(() => setNote(t('Link copied.')))
        .catch(() => {});
    });
  }

  return (
    <Screen
      edges={[]}
      footer={
        <>
          {note ? (
            <T variant="small" role="status" accessibilityLiveRegion="polite">
              {note}
            </T>
          ) : null}
          <Row>
            {webLink ? <Button title={t('Print')} onPress={print} loading={printing} style={styles.action} /> : null}
            <Button title={t('Share')} variant="secondary" onPress={share} style={styles.action} />
          </Row>
        </>
      }>
      <T variant="muted">
        {t('Print it for your counter or mirror. Walk-in customers scan the code with their phone camera to book.')}
      </T>

      {!shop.is_published ? (
        <Card>
          <T variant="heading">{t('Not live yet')}</T>
          <T variant="muted">{t('Customers can’t book from this poster until you go live on My shop.')}</T>
        </Card>
      ) : !paid ? (
        <Card>
          <T variant="heading">{t('Trial ended, customers can no longer book')}</T>
          <T variant="muted">{t('Once your subscription is active, customers can book from this poster again.')}</T>
        </Card>
      ) : null}

      {webLink ? null : (
        <Card>
          <T variant="muted">
            {t('A poster needs your shop’s web link, and this version of the app doesn’t have one yet.')}
          </T>
        </Card>
      )}

      <Card style={styles.paper}>
        <T variant="title" style={[styles.center, { color: ink.text }]}>
          {shop.name}
        </T>
        {shop.area ? <T style={[styles.center, { color: ink.textSecondary }]}>{shop.area}</T> : null}
        <View style={styles.lines}>
          <T variant="heading" style={[styles.center, { color: ink.tint }]}>
            {POSTER_TEXT.headline[0]}
          </T>
          <T style={[styles.center, styles.second, { color: ink.tint }]}>{POSTER_TEXT.headline[1]}</T>
        </View>
        {webLink ? (
          <QrCode value={link} size={qrSize} accessibilityLabel={t('QR code for your booking link')} />
        ) : null}
        <View style={styles.lines}>
          <T variant="label" style={[styles.center, { color: ink.text }]}>
            {POSTER_TEXT.scan[0]}
          </T>
          <T variant="small" style={[styles.center, { color: ink.textSecondary }]}>
            {POSTER_TEXT.scan[1]}
          </T>
        </View>
        <T variant="small" selectable style={[styles.center, { color: ink.text }]}>
          {link}
        </T>
      </Card>
    </Screen>
  );
}

/** Closing the share sheet without picking an app rejects too (navigator.share on the web). */
const shareCancelled = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

const styles = StyleSheet.create({
  paper: { backgroundColor: PAPER, borderColor: ink.border, alignItems: 'center', paddingVertical: Spacing.xl },
  center: { textAlign: 'center' },
  lines: { gap: 2, alignItems: 'center' },
  second: { fontWeight: '600' },
  action: { flexGrow: 1, flexBasis: '40%' },
});
