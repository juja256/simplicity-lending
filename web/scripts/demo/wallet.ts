// Connects a seed wallet through the app's connect modal, as a person does in demo mode
// (`VITE_DEMO_MODE`): "Connect Wallet", "Seed phrase", the phrase, "Connect". The phrase is typed
// into the page only; it is never logged.
import { expect, type Page } from '@playwright/test'

/** A first connection syncs the whole wallet from waterfalls, which can take a few minutes. */
const CONNECT_TIMEOUT = 5 * 60_000

/**
 * Connects the wallet of `mnemonic` on `page`, which shows the connect button (an area's page
 * without a wallet), and waits until the page no longer offers it.
 */
export async function connectSeedWallet(page: Page, mnemonic: string): Promise<void> {
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /Seed phrase/ }).click()
  // A whole phrase typed into the first word spreads over the twelve fields.
  await dialog.getByRole('textbox', { name: 'Word 1', exact: true }).fill(mnemonic)
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  try {
    await expect(dialog).toBeHidden({ timeout: CONNECT_TIMEOUT })
  } catch (error) {
    // Leave no phrase on the page for the failure's page snapshot: back to the wallet list.
    const shown = await dialog.locator('.text-danger').allTextContents()
    await dialog.getByRole('button', { name: 'Back' }).click()
    throw new Error(`the wallet did not connect${shown.length ? `: ${shown.join(' ')}` : ''}`, {
      cause: error,
    })
  }
  await expect(page.getByRole('button', { name: 'Connect Wallet' })).toHaveCount(0, {
    timeout: CONNECT_TIMEOUT,
  })
}
