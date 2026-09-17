import { AppShell, PageContainer } from '@silkweave/box-ui'
import { useGroupNav } from '../../../lib/nav.ts'
import { AlertsFeedSection } from './AlertsSections.tsx'

/** The recorded alert history. */
export function AlertsView() {
  const groupNav = useGroupNav('alerts')
  return (
    <AppShell items={[]} activeId='' onSelect={() => undefined} groupNav={groupNav} topbar={{ crumbs: [{ label: 'Alerts' }] }}>
      <PageContainer width='wide' className='flex h-full flex-col'>
        <AlertsFeedSection />
      </PageContainer>
    </AppShell>
  )
}
