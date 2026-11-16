// Connects a seed wallet through the app's connect modal, as a person does in demo mode
// (`VITE_DEMO_MODE`): "Connect Wallet", "Seed phrase", the phrase, "Connect". The phrase is typed
// into the page only; it is never logged.
import { expect, type Locator, type Page } from '@playwright/test'

/** A first connection syncs the whole wallet from waterfalls, which can take a few minutes. */
const CONNECT_TIMEOUT = 5 * 60_000

/** Empties every word field it can; a field that cannot be emptied is left as it is. */
async function clearWords(words: Locator): Promise<void> {
  let fields: Locator[]
  try {
    fields = await words.all()
  } catch {
    return
  }
  for (const word of fields) await word.fill('', { timeout: 5_000 }).catch(() => {})
}

/**
 * The modal's error text for a failure message, or null when it holds any word of `mnemonic`: no
 * message built here may repeat a word of the phrase.
 */
function safeShown(shown: string[], mnemonic: string): string | null {
  const text = shown.join(' ').trim()
  if (text === '') return null
  const seedWords = new Set(mnemonic.toLowerCase().split(/\s+/).filter(Boolean))
  const holdsSeedWord = text
    .toLowerCase()
    .split(/[^a-z]+/)
    .some(word => seedWords.has(word))
  return holdsSeedWord ? null : text
}

/**
 * Connects the wallet of `mnemonic` on `page`, which shows the connect button (an area's page
 * without a wallet), and waits until the page no longer offers it.
 *
 * While the phrase is in the modal's fields, nothing here is a locator assertion (`expect`): a
 * failed one attaches a snapshot of the page, with the fields' values, to the failure's
 * `error-context.md`. A failure clears the fields, then throws an error of its own without the
 * original as its `cause`: Playwright's error carries the call log, and the log of `fill` holds
 * the value typed, which the reporter would print.
 */
export async function connectSeedWallet(page: Page, mnemonic: string): Promise<void> {
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /Seed phrase/ }).click()
  const words = dialog.getByRole('textbox', { name: /^Word \d+$/ })
  let step = 'typing the phrase'
  try {
    // A whole phrase typed into the first word spreads over the twelve fields.
    await words.first().fill(mnemonic)
    step = 'pressing Connect'
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    step = 'waiting for the wallet to connect'
    await dialog.waitFor({ state: 'hidden', timeout: CONNECT_TIMEOUT })
  } catch (error) {
    // Only the error's class name is kept (such as `TimeoutError`): never its message.
    const kind =
      error instanceof Error && /^[A-Za-z]*Error$/.test(error.name) ? error.name : 'an error'
    const shown = await dialog
      .locator('.text-danger')
      .allTextContents()
      .catch(() => [])
    // The fields stay editable while the wallet connects; "Back" does not.
    await clearWords(words)
    const reason = safeShown(shown, mnemonic)
    throw new Error(
      `the wallet did not connect (${kind} while ${step})${reason === null ? '' : `: ${reason}`}`,
    )
  }
  // No field holds the phrase any more: the modal is closed.
  await expect(page.getByRole('button', { name: 'Connect Wallet' })).toHaveCount(0, {
    timeout: CONNECT_TIMEOUT,
  })
}
