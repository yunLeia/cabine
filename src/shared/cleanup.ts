import { loadState, updateGarment } from './store.ts';

// A closed panel releases its Web Locks. Do not disturb work in another panel.
export async function recoverInterruptedCleanups(): Promise<void> {
  const { garments } = await loadState();
  for (const g of garments.filter((item) => item.cleanStatus === 'pending')) {
    await navigator.locks.request(`cabine:cleanup:${g.id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      const current = (await loadState()).garments.find((item) => item.id === g.id);
      if (current?.cleanStatus === 'pending') await updateGarment(g.id, { cleanStatus: 'failed' });
    });
  }
}
