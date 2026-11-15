// Connects a seed wallet through the app's connect modal, as a person does in demo mode
// (`VITE_DEMO_MODE`): "Connect Wallet", "Seed phrase", the phrase, "Connect". The phrase is typed
// into the page only; it is never logged.
import { expect, type Page } from '@playwright/test'

/** A first connection syncs the whole wallet from waterfalls, which can take a few minutes. */
const CONNECT_TIMEOUT = 5 * 60_000

/**
 * Connects the wallet of `mnemonic` on `page`, which shows the connect button (an area's page
 * without a wallet), and waits until the page no longer offers it.
 *
 * While the phrase is in the modal's fields, nothing here is a locator assertion (`expect`): a
 * failed one attaches a snapshot of the page, with the fields' values, to the failure's
 * `error-context.md`. A failure clears the fields before it is thrown.
 */
export async function connectSeedWallet(page: Page, mnemonic: string): Promise<void> {
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /Seed phrase/ }).click()
  const words = dialog.getByRole('textbox', { name: /^Word \d+$/ })
  try {
    // A whole phrase typed into the first word spreads over the twelve fields.
    await words.first().fill(mnemonic)
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: CONNECT_TIMEOUT })
  } catch (error) {
    const shown = await dialog
      .locator('.text-danger')
      .allTextContents()
      .catch(() => [])
    // The fields stay editable while the wallet connects; "Back" does not.
    for (const word of await words.all()) await word.fill('', { timeout: 5_000 }).catch(() => {})
    throw new Error(`the wallet did not connect${shown.length ? `: ${shown.join(' ')}` : ''}`, {
      cause: error,
    })
  }
  // No field holds the phrase any more: the modal is closed.
  await expect(page.getByRole('button', { name: 'Connect Wallet' })).toHaveCount(0, {
    timeout: CONNECT_TIMEOUT,
  })
}
