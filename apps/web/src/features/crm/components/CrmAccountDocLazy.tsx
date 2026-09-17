import { lazy, Suspense } from 'react'

// Lazy boundary so TipTap (~600 kB) stays out of the main bundle and loads only on a CRM account
// page - the same split the library's DocEditor makes for the planning docs. Re-exported under the plain name
// so the call site does not change.
const CrmAccountDocInner = lazy(() =>
  import('./CrmAccountDoc.tsx').then((m) => ({ default: m.CrmAccountDoc })),
)

export function CrmAccountDoc({ accountId }: { accountId: string }) {
  return (
    <Suspense
      fallback={
        <div className='grid min-h-[24rem] flex-1 place-items-center bg-bg px-4 py-10 text-center text-body-sm text-muted-foreground'>
          Loading editor…
        </div>
      }>
      <CrmAccountDocInner accountId={accountId} />
    </Suspense>
  )
}
