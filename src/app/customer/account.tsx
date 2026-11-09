import { AccountPanel } from '@/components/account-panel';
import { Screen, T } from '@/components/ui';
import { t } from '@/lib/lang';

export default function CustomerAccount() {
  return (
    <Screen>
      <T variant="title">{t('Account')}</T>
      <AccountPanel />
    </Screen>
  );
}
