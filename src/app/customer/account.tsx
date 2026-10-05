import { AccountPanel } from '@/components/account-panel';
import { Screen, T } from '@/components/ui';

export default function CustomerAccount() {
  return (
    <Screen>
      <T variant="title">Account</T>
      <AccountPanel />
    </Screen>
  );
}
