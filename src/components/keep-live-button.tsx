import { Linking } from 'react-native';

import { Button } from '@/components/ui';
import { APP_NAME, bookingLink, SUPPORT_WHATSAPP } from '@/constants/brand';
import { t } from '@/lib/lang';
import { whatsappUrl } from '@/lib/phone';
import type { Shop } from '@/lib/types';

/**
 * For a shop whose free month is running out or has run out: opens WhatsApp
 * to the PotongKu team with the shop's name and link already written, since
 * subscriptions are set up by hand until payments are built.
 */
export function KeepLiveButton({ shop, variant = 'primary' }: { shop: Shop; variant?: 'primary' | 'secondary' }) {
  const message = t('Hi {app}, I’d like to subscribe so {shop} stays live: {link}', {
    app: APP_NAME,
    shop: shop.name,
    link: bookingLink(shop.slug),
  });
  return (
    <Button
      title={t('Keep my shop live')}
      icon="logo-whatsapp"
      variant={variant}
      onPress={() => Linking.openURL(whatsappUrl(SUPPORT_WHATSAPP, message)).catch(() => {})}
    />
  );
}
