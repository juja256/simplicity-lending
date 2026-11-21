// The scripted testnet demo of both areas (`pnpm demo:testnet`, see `web/README.md`): the lender
// console and the borrower app, each in its own browser context with one of the e2e's seed
// wallets, through a whole loan on Liquid testnet, repaid in an installment and the rest, and a
// short one that the lender liquidates. It broadcasts real testnet transactions and waits for
// their blocks, so one run takes about 20 minutes. Screenshots of every page of both areas go to
// `.demo-output/` (git-ignored).
/// <reference lib="dom" />
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { expect, type Locator, type Page, test } from '@playwright/test'

import { amountText } from '@/areas/borrow/proposalForm'
import { PERCENT_DECIMALS, unitsFromDecimal, unitsToDecimal } from '@/privateLending/lenderTerms'

import { loadEnv, TESTNET_PAIR, webRoot } from '../e2e/env'
import { getRecord, removeRecord } from '../e2e/state'
import { connectSeedWallet } from './wallet'

const OUTPUT = path.join(webRoot, '.demo-output')

const MINUTE = 60_000
/** A transaction's first confirmation, then the indexer and the app's scan: a few blocks. */
const CHAIN_TIMEOUT = 20 * MINUTE

const { collateralAsset: COLLATERAL, principalAsset: PRINCIPAL } = TESTNET_PAIR

const LENDER_NAME = 'E2E Lender'

/** The `directory` stage's terms (`e2eTermsForm`), by their fields on the Terms page. */
const TERMS: [label: string, value: string][] = [
  ['Least APR', '10'],
  [`Most principal per 1 ${COLLATERAL.symbol}`, '10000'],
  ['Shortest term', '1'],
  ['Longest term', '30'],
  ['Smallest principal', '0.1'],
  ['Largest principal', '100'],
]

/** The value of a field of `TERMS`. */
function termOf(label: string): string {
  const value = TERMS.find(([name]) => name === label)?.[1]
  if (value === undefined) throw new Error(`no term ${label}`)
  return value
}

/** The short proposal's collateral in the app: the e2e amount (`scripts/e2e/env.ts`). */
const SHORT_COLLATERAL = `${unitsToDecimal(20_000n, COLLATERAL.decimals)} ${COLLATERAL.symbol}`

type Wallet = 'borrower' | 'lender'

/**
 * Runs `pnpm e2e:private <stage>`, with the app's esplora (`DEMO_ESPLORA_URL`, as the config
 * gives the dev server), logged to `.demo-output/e2e-<stage>.log`; returns its output.
 */
function runE2e(stage: string): Promise<string> {
  const log = path.join(OUTPUT, `e2e-${stage}.log`)
  const esplora = process.env.DEMO_ESPLORA_URL
  const env = esplora ? { ...process.env, VITE_ESPLORA_BASE_URL: esplora } : process.env
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['e2e:private', stage], { cwd: webRoot, env })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', reject)
    child.on('close', code => {
      fs.writeFileSync(log, output)
      if (code === 0) resolve(output)
      else reject(new Error(`pnpm e2e:private ${stage} exited ${code} (${log}):\n${output}`))
    })
  })
}

/** Each wallet's lending-key fingerprint as the `wallets` stage prints it, in 4×4 groups. */
function fingerprintsOf(walletsOutput: string): Record<Wallet, string> {
  const found: Partial<Record<Wallet, string>> = {}
  let wallet: Wallet | undefined
  for (const line of walletsOutput.split('\n')) {
    if (line === 'borrower' || line === 'lender') wallet = line
    const key = /^ {2}lending key ([0-9a-f]{4}(?: [0-9a-f]{4}){3})$/.exec(line)
    if (key && wallet) found[wallet] = key[1]
  }
  if (!found.borrower || !found.lender) throw new Error('the wallets stage printed no fingerprints')
  return { borrower: found.borrower, lender: found.lender }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUTPUT, `${name}.png`), fullPage: true })
}

/**
 * A principal amount as the app writes it, grouped and with at least `minFraction` decimals:
 * `"0.05 TEST"`, and `"0.10 TEST"` on a Repay button (`loanAmounts`).
 */
function principalText(units: bigint, minFraction = 0): string {
  return `${amountText(units, PRINCIPAL.decimals, minFraction)} ${PRINCIPAL.symbol}`
}

/** The base units of a principal amount as the app writes it, such as `"1,100.5"`. */
function principalUnits(text: string): bigint {
  return unitsFromDecimal(text.replaceAll(',', ''), PRINCIPAL.decimals)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Exactly `text`: a string `name` of a locator matches any label that contains it. */
function exactly(text: string): RegExp {
  return new RegExp(`^${escapeRegExp(text)}$`)
}

/** A row of a details panel or a transaction's summary: its label, then its value. */
function detailRow(label: string, value: string): RegExp {
  return new RegExp(`${escapeRegExp(label)}\\s*${escapeRegExp(value)}`)
}

/** A typed decimal one base unit (of `decimals`) lower. */
function oneUnitBelow(text: string, decimals: number): string {
  return unitsToDecimal(unitsFromDecimal(text, decimals) - 1n, decimals)
}

/** The page scrolls only vertically. */
async function expectNoHorizontalScroll(page: Page, what: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth, `${what}: scrollWidth ≤ clientWidth`).toBeLessThanOrEqual(clientWidth)
}

/** The element lies within the viewport's width, so it is reachable without scrolling sideways. */
async function expectWithinWidth(page: Page, locator: Locator, what: string): Promise<void> {
  const box = await locator.boundingBox()
  const width = page.viewportSize()?.width ?? 0
  expect(box, `${what} is laid out`).not.toBeNull()
  expect(box!.x, `${what}: left edge`).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${what}: right edge`).toBeLessThanOrEqual(width)
}

/**
 * Confirms the open action modal with its `label` button and waits for the broadcast; with
 * `confirmed`, also for the first confirmation. Checks the transaction's `summary` rows, then
 * closes it with "Done".
 */
async function confirmTransaction(
  page: Page,
  label: string | RegExp,
  {
    confirmed = true,
    summary = [],
  }: { confirmed?: boolean; summary?: [label: string, value: string][] } = {},
): Promise<void> {
  const dialog = page.getByRole('dialog')
  const button = dialog.getByRole('button', { name: label })
  await expect(button).toBeEnabled({ timeout: 2 * MINUTE })
  await button.click()
  const outcome = dialog.getByText(
    confirmed ? /Transaction (Complete|Failed)/ : /Transaction (Pending…|Complete|Failed)/,
  )
  await expect(outcome).toBeVisible({ timeout: CHAIN_TIMEOUT })
  if ((await outcome.textContent())?.includes('Failed')) {
    throw new Error(`the transaction failed: ${await dialog.innerText()}`)
  }
  for (const [name, value] of summary) await expect(dialog).toContainText(detailRow(name, value))
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
}

test('the lender console and the borrower app on Liquid testnet', async ({ browser }) => {
  fs.mkdirSync(OUTPUT, { recursive: true })
  const env = loadEnv()

  // The `wallets` stage exits 1 naming each shortfall, with the address to fund.
  const fingerprints = fingerprintsOf(
    await test.step('the e2e wallets are funded', () => runE2e('wallets')),
  )

  const lenderContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const borrowerContext = await browser.newContext({ viewport: { width: 375, height: 812 } })
  const lender = await lenderContext.newPage()
  const borrower = await borrowerContext.newPage()
  const lenderNavigation = lender.getByRole('navigation', { name: 'Lender console' })
  const sidebar = lender.getByRole('complementary').filter({ has: lenderNavigation })
  const lenderNav = (name: string) => lenderNavigation.getByRole('link', { name })
  const borrowerSteps = (name: string) =>
    borrower.getByRole('navigation', { name: 'Borrowing steps' }).getByRole('link', { name })
  let lenderKey = ''

  await test.step('1. the lender publishes terms on /lend/terms', async () => {
    await lender.goto('/lend/terms')
    await connectSeedWallet(lender, env.lenderMnemonic)
    // The header names the key by its fingerprint, and the signer on the wallet button.
    await expect(sidebar.getByText(fingerprints.lender, { exact: true })).toBeVisible({
      timeout: 2 * MINUTE,
    })
    await expect(sidebar.getByRole('button', { name: 'Seed phrase' })).toBeVisible()

    const publish = lender.getByRole('button', { name: 'Sign and publish' })
    await expect(publish).toBeVisible({ timeout: 2 * MINUTE })
    // A first publish signs a name; an entry that verified keeps its own.
    const nameField = lender.getByRole('textbox', { name: 'Display name', exact: true })
    if (await nameField.isVisible()) await nameField.fill(LENDER_NAME)
    for (const [label, value] of TERMS) {
      await lender.getByRole('textbox', { name: label, exact: true }).fill(value)
    }
    await publish.click()
    await expect(lender.getByText('Terms published')).toBeVisible({ timeout: 2 * MINUTE })
    await expect(sidebar.getByText(LENDER_NAME, { exact: true })).toBeVisible({
      timeout: 2 * MINUTE,
    })
    await shot(lender, 'lend-terms-published')

    // The profile shows the same key, whole.
    await lenderNav('Profile').click()
    const main = lender.getByRole('main')
    await expect(main.getByText(fingerprints.lender, { exact: true })).toBeVisible()
    lenderKey = (await main.getByText(/^[0-9a-f]{64}$/).textContent()) ?? ''
    expect(lenderKey).toMatch(/^[0-9a-f]{64}$/)
    await shot(lender, 'lend-profile-published')

    // Back on Terms, the form opens on the published entry, verified against the key.
    await lenderNav('Terms').click()
    await expect(lender.getByText(`as ${LENDER_NAME}`)).toBeVisible({ timeout: MINUTE })
    await expect(nameField).toHaveCount(0)
    for (const [label, value] of TERMS) {
      const field = lender.getByRole('textbox', { name: label, exact: true })
      await expect
        .poll(async () => Number(await field.inputValue()), { message: `${label} is pre-filled` })
        .toBe(Number(value))
    }
    await shot(lender, 'lend-terms-prefilled')

    // Desktop first: the sidebar beside the work area; under 1024 px, a bar above it.
    const main1280 = (await lender.getByRole('main').boundingBox())!
    const side1280 = (await sidebar.boundingBox())!
    expect(side1280.x + side1280.width).toBeLessThanOrEqual(main1280.x + 1)
    await lender.setViewportSize({ width: 900, height: 800 })
    await expect
      .poll(async () => {
        const side = (await sidebar.boundingBox())!
        const main = (await lender.getByRole('main').boundingBox())!
        return side.y + side.height <= main.y + 1 && side.width >= 899
      })
      .toBe(true)
    await expectNoHorizontalScroll(lender, 'the lender console at 900 px')
    await shot(lender, 'lend-terms-900')
    await lender.setViewportSize({ width: 1280, height: 800 })
  })

  const loanRow = borrower
    .getByRole('main')
    .getByRole('listitem')
    .filter({
      hasText: `Waiting for ${LENDER_NAME}`,
    })
  let walletAddress = ''
  // The borrower's loan, once the lender accepted it: picked by its collateral, set below.
  let ownLoan: Locator = loanRow
  const send = borrower.getByRole('button', { name: 'Lock collateral and send' })

  await test.step('2. the borrower proposes within the terms, and not below them', async () => {
    await borrower.goto('/borrow')
    await connectSeedWallet(borrower, env.borrowerMnemonic)
    const walletButton = borrower.getByRole('banner').getByRole('button', { name: /\.\.\./ })
    await expect(walletButton).toBeVisible()
    walletAddress = (await walletButton.textContent()) ?? ''

    const lenderRow = borrower.getByRole('listitem').filter({ hasText: LENDER_NAME })
    await expect(lenderRow).toContainText(fingerprints.lender, { timeout: 2 * MINUTE })
    await shot(borrower, 'borrow-choose-lender')
    await lenderRow.getByRole('link', { name: `Borrow from ${LENDER_NAME}` }).click()
    await expect(borrower).toHaveURL(new RegExp(`/borrow/${lenderKey}$`))

    // The form opens at the lender's minimums.
    const field = (name: string) => borrower.getByRole('textbox', { name, exact: true })
    await expect(field('Principal')).toHaveValue(termOf('Smallest principal'))
    await expect(field('Term')).toHaveValue(termOf('Shortest term'))
    await expect(field('APR')).toHaveValue(termOf('Least APR'))
    const hint = borrower.getByText(/^At least \S+ \S+ for this principal\.$/)
    const least = /^At least (\S+) /.exec((await hint.textContent()) ?? '')?.[1] ?? ''
    await expect(field('Collateral')).toHaveValue(least)
    const leastText = `${least} ${COLLATERAL.symbol}`
    ownLoan = borrower
      .getByRole('main')
      .getByRole('listitem')
      .filter({ hasText: `Collateral${leastText}` })

    // The summary sentence follows the form as the borrower types.
    const sentence = borrower.getByRole('region', { name: 'Summary' }).locator('p').first()
    await expect(sentence).toContainText(`If you don't, ${LENDER_NAME} keeps your ${leastText}.`)
    const atMinimums = (await sentence.textContent()) ?? ''
    expect(atMinimums).toMatch(new RegExp(`^You repay \\S+ ${PRINCIPAL.symbol} by `))
    await field('Principal').fill('0.2')
    const doubled = unitsToDecimal(
      2n * unitsFromDecimal(least, COLLATERAL.decimals),
      COLLATERAL.decimals,
    )
    await expect(field('Collateral')).toHaveValue(doubled)
    await expect(sentence).toContainText(`keeps your ${doubled} ${COLLATERAL.symbol}.`)
    await expect(sentence).not.toHaveText(atMinimums)
    await field('Principal').fill(termOf('Smallest principal'))
    await expect(sentence).toHaveText(atMinimums)

    // One basis point and one base unit below the minimums: each field says why.
    await field('APR').fill(oneUnitBelow(termOf('Least APR'), PERCENT_DECIMALS))
    await field('Collateral').fill(oneUnitBelow(least, COLLATERAL.decimals))
    await expect(borrower.getByText(/^The lender's least APR is /)).toBeVisible()
    await expect(
      borrower.getByText(`The lender needs at least ${leastText} for this principal.`),
    ).toBeVisible()
    await expect(sentence).toHaveText(/^Bring each field within the terms/)
    await expect(send).toBeDisabled()
    await shot(borrower, 'borrow-proposal-below')

    await field('APR').fill(termOf('Least APR'))
    await field('Collateral').fill(least)
    await expect(sentence).toHaveText(atMinimums)
    await expect(send).toBeEnabled({ timeout: 2 * MINUTE })
    await expectNoHorizontalScroll(borrower, 'the proposal page')
    await expectWithinWidth(borrower, sentence, 'the summary')
    await expectWithinWidth(borrower, send, '"Lock collateral and send"')
    await shot(borrower, 'borrow-proposal-minimums')

    await send.click()
    await expect(borrower.getByRole('dialog')).toContainText('Send your proposal')
    await confirmTransaction(borrower, 'Lock collateral and send', { confirmed: false })
    await expect(borrower).toHaveURL(/\/borrow\/loans$/)
    await expect(borrower.getByText('Your new proposal')).toBeVisible()

    await expect(loanRow).toBeVisible({ timeout: CHAIN_TIMEOUT })
    await expect(ownLoan).toContainText(`Waiting for ${LENDER_NAME}`)
    await expect(ownLoan.getByRole('button', { name: 'Cancel' })).toBeVisible()
    // The proposal received at an address past the shown one, which stays the user's: once the
    // wallet's scan sees the proposal, the button moves on past both.
    await expect(walletButton).not.toHaveText(walletAddress, { timeout: 5 * MINUTE })
    await shot(borrower, 'borrow-loans-waiting')
  })

  /** The row of the console's table on screen that holds `text`. */
  const tableRow = (text: string | RegExp) =>
    lender.getByRole('main').getByRole('row').filter({ hasText: text })

  await test.step('3. a 15-block proposal shows as "term shorter than 1 day"', async () => {
    // An earlier demo's short proposal expired long ago: its confirmed record is removed here,
    // and the stage removes an unfinished one that expired, so the stage makes a new one.
    if (getRecord('short-proposal')?.status === 'confirmed') removeRecord('short-proposal')
    await runE2e('short-proposal')

    await lenderNav('Proposals').click()
    await expect(tableRow(/Term shorter than 1 day/i)).toBeVisible({ timeout: CHAIN_TIMEOUT })
    await expect(tableRow('Within your terms')).toBeVisible({ timeout: CHAIN_TIMEOUT })
    await shot(lender, 'lend-proposals-badge')
  })

  await test.step('5a. the lender accepts the short proposal outside its terms', async () => {
    // Its term is 15 blocks: it is accepted at once, and liquidated once the main loan is done.
    await tableRow(/Term shorter than 1 day/i)
      .getByRole('button', { name: 'Review' })
      .click()
    const dialog = lender.getByRole('dialog')
    await expect(dialog).toContainText('This proposal is outside your terms:')
    await expect(dialog).toContainText('term shorter than 1 day')
    const accept = dialog.getByRole('button', { name: 'Accept and lend' })
    await expect(accept).toBeDisabled()
    await dialog.getByText('Accept outside my terms').click()
    await expect(dialog.getByRole('checkbox', { name: 'Accept outside my terms' })).toBeChecked()
    await expect(accept).toBeEnabled()
    await shot(lender, 'lend-accept-outside-terms')
    await confirmTransaction(lender, 'Accept and lend')
  })

  /** The loan book's cell of the column `name` in `row`. */
  const bookCell = async (row: Locator, name: string): Promise<Locator> => {
    const headers = await lender.getByRole('main').getByRole('columnheader').allTextContents()
    const index = headers.findIndex(header => header.trim() === name)
    if (index < 0) throw new Error(`the loan book has no column ${name}`)
    return row.getByRole('cell').nth(index)
  }

  const step4 = '4. the main loan: accepted, received, paid in two parts and claimed in two'
  await test.step(step4, async () => {
    await tableRow('Within your terms').getByRole('button', { name: 'Review' }).click()
    const dialog = lender.getByRole('dialog')
    await expect(dialog).toContainText('The proposal is within your published terms.')
    await expect(dialog.getByText('Accept outside my terms')).toHaveCount(0)
    await shot(lender, 'lend-accept-within-terms')
    await confirmTransaction(lender, 'Accept and lend')

    // The borrower receives the principal.
    const receive = ownLoan.getByRole('button', { name: /^Receive / })
    await expect(ownLoan).toContainText('Accepted', { timeout: CHAIN_TIMEOUT })
    await expect(receive).toHaveText(`Receive ${termOf('Smallest principal')} ${PRINCIPAL.symbol}`)
    await shot(borrower, 'borrow-loans-accepted')
    await receive.click()
    await confirmTransaction(
      borrower,
      `Receive ${termOf('Smallest principal')} ${PRINCIPAL.symbol}`,
    )

    // Once the loan is read on chain, the row counts what is repaid of the repayment, and Repay
    // names what it still owes: the whole repayment, before any installment.
    const repay = ownLoan.getByRole('button', { name: /^Repay / })
    await expect(repay).toBeVisible({ timeout: CHAIN_TIMEOUT })
    const unread = new RegExp(`Active, 0 of \\S+ ${PRINCIPAL.symbol} repaid, due in `)
    await expect(ownLoan).toContainText(unread, { timeout: 2 * MINUTE })
    const owedText = /^Repay (\S+) /.exec((await repay.textContent()) ?? '')?.[1] ?? ''
    const repayment = principalUnits(owedText)
    const repaidOf = (paid: bigint) =>
      `Active, ${amountText(paid, PRINCIPAL.decimals)} of ${principalText(repayment)} repaid, ` +
      'due in '
    await expect(ownLoan).toContainText(repaidOf(0n))
    await shot(borrower, 'borrow-loans-active')

    // The borrower pays half of it as an installment. The form opens on what the loan owes, and
    // warns that the lender keeps an installment if it liquidates the loan.
    const half = repayment / 2n
    const rest = repayment - half
    const repayForm = borrower.getByRole('dialog')
    const amount = repayForm.getByRole('textbox', { name: 'Amount', exact: true })
    const warning = repayForm.getByText(
      'Installments are not refunded if the loan is liquidated: the lender keeps them and the ' +
        'collateral.',
    )
    await repay.click()
    await expect(amount).toHaveValue(unitsToDecimal(repayment, PRINCIPAL.decimals), {
      timeout: 2 * MINUTE,
    })
    await expect(repayForm).toContainText(detailRow('Paid so far', principalText(0n)))
    await expect(repayForm).toContainText(detailRow('Still owed', principalText(repayment)))
    await amount.fill(unitsToDecimal(half, PRINCIPAL.decimals))
    await expect(warning).toBeVisible()
    await warning.scrollIntoViewIfNeeded()
    await shot(borrower, 'borrow-repay-installment')
    await confirmTransaction(borrower, exactly(`Pay ${principalText(half, 2)}`), {
      summary: [
        ['You pay', principalText(half)],
        ['Still owed after it', principalText(rest)],
      ],
    })
    // The row counts the installment once the indexer lists it.
    await expect(ownLoan).toContainText(repaidOf(half), { timeout: CHAIN_TIMEOUT })
    await expect(repay).toHaveText(`Repay ${principalText(rest, 2)}`, { timeout: CHAIN_TIMEOUT })
    await shot(borrower, 'borrow-loans-installment')

    // The lender claims the installment: the loan book counts it as repaid and claimable.
    await lenderNav('Loan book').click()
    const lent = `${termOf('Smallest principal')} ${PRINCIPAL.symbol}`
    const mainLoan = lender
      .getByRole('main')
      .getByRole('row')
      .filter({ has: lender.getByRole('cell', { name: lent, exact: true }) })
    const claim = mainLoan.getByRole('button', { name: 'Claim', exact: true })
    await expect(claim).toBeVisible({ timeout: CHAIN_TIMEOUT })
    await expect(await bookCell(mainLoan, 'Repaid')).toHaveText(principalText(half))
    await expect(await bookCell(mainLoan, 'Remaining')).toHaveText(principalText(rest))
    await expect(await bookCell(mainLoan, 'Claimable')).toHaveText(principalText(half))
    await shot(lender, 'lend-loans-installment')
    await claim.click()
    await confirmTransaction(lender, exactly('Claim installments'), {
      summary: [['You claim', principalText(half)]],
    })
    // Nothing is claimable once the indexer lists the installment as spent.
    await expect(await bookCell(mainLoan, 'Claimable')).toHaveText('–', { timeout: CHAIN_TIMEOUT })
    await expect(claim).toHaveCount(0)

    // The borrower repays the rest, which closes the loan.
    await repay.click()
    await expect(amount).toHaveValue(unitsToDecimal(rest, PRINCIPAL.decimals), {
      timeout: 2 * MINUTE,
    })
    await expect(repayForm).toContainText(detailRow('Paid so far', principalText(half)))
    await expect(repayForm).toContainText(detailRow('Still owed', principalText(rest)))
    await expect(warning).toBeVisible()
    await warning.scrollIntoViewIfNeeded()
    await shot(borrower, 'borrow-repay-rest')
    await confirmTransaction(borrower, exactly(`Repay ${principalText(rest, 2)}`), {
      summary: [['You repay', principalText(rest)]],
    })
    await expect(ownLoan).toContainText('Repaid', { timeout: CHAIN_TIMEOUT })
    // The row waits for the repayment's second confirmation before it drops its spinner.
    await expect(ownLoan).toContainText('Your collateral came back to you.', {
      timeout: CHAIN_TIMEOUT,
    })

    // The lender's final claim takes the repayment of the rest: no installment is left to sweep.
    const claimRepayment = mainLoan.getByRole('button', { name: 'Claim repayment', exact: true })
    await expect(claimRepayment).toBeVisible({ timeout: CHAIN_TIMEOUT })
    await expect(await bookCell(mainLoan, 'Claimable')).toHaveText(principalText(rest), {
      timeout: 2 * MINUTE,
    })
    await claimRepayment.click()
    await confirmTransaction(lender, exactly('Claim repayment'), {
      summary: [['You claim now', principalText(rest)]],
    })
    // The book shows the loan repaid in full, with nothing left to claim.
    await expect(mainLoan).toContainText('Claimed', { timeout: CHAIN_TIMEOUT })
    await expect(await bookCell(mainLoan, 'Repaid')).toHaveText(principalText(repayment), {
      timeout: 2 * MINUTE,
    })
    await expect(await bookCell(mainLoan, 'Remaining')).toHaveText(principalText(0n))
    await expect(await bookCell(mainLoan, 'Claimable')).toHaveText('–')
    await expect(claimRepayment).toHaveCount(0)
    await shot(lender, 'lend-loans-claimed')
  })

  await test.step('5b. the lender liquidates the short loan once it expired', async () => {
    const liquidate = lender.getByRole('main').getByRole('button', { name: 'Liquidate' })
    await expect(liquidate).toBeVisible({ timeout: 3 * CHAIN_TIMEOUT })
    await expect(tableRow('Overdue')).toBeVisible()
    await liquidate.click()
    await confirmTransaction(lender, 'Liquidate and claim collateral')
    await expect(tableRow('Liquidated')).toBeVisible({ timeout: CHAIN_TIMEOUT })
    await shot(lender, 'lend-loans-liquidated')

    const shortLoan = borrower
      .getByRole('main')
      .getByRole('listitem')
      .filter({ hasText: `Collateral${SHORT_COLLATERAL}` })
    await expect(shortLoan).toContainText('Collateral taken', { timeout: CHAIN_TIMEOUT })
  })

  await test.step('6. every page at 375 px, and a screenshot of each', async () => {
    await borrowerSteps('Choose a lender').click()
    await expect(borrower.getByRole('link', { name: `Borrow from ${LENDER_NAME}` })).toBeVisible()
    await expectNoHorizontalScroll(borrower, 'Choose a lender')
    await shot(borrower, 'borrow-choose')
    await borrower.getByRole('link', { name: `Borrow from ${LENDER_NAME}` }).click()
    await expect(send).toBeVisible()
    await expectNoHorizontalScroll(borrower, 'the proposal page')
    await shot(borrower, 'borrow-proposal')
    await borrowerSteps('My loans').click()
    await expect(ownLoan).toBeVisible({ timeout: 2 * MINUTE })
    await expectNoHorizontalScroll(borrower, 'My loans')
    await shot(borrower, 'borrow-loans')

    for (const [name, file] of [
      ['Proposals', 'lend-proposals'],
      ['Loan book', 'lend-loans'],
      ['Terms', 'lend-terms'],
      ['Profile', 'lend-profile'],
    ]) {
      await lenderNav(name).click()
      await expect(lender.getByRole('heading', { level: 1, name })).toBeVisible()
      await shot(lender, file)
    }
  })

  await lenderContext.close()
  await borrowerContext.close()
})
