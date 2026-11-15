import { amountText, formatDay, type ProposalAmounts } from './proposalForm'
import { PAIR } from './useLenders'

interface ProposalSummaryProps {
  /** The lender's directory name: chosen by whoever holds its key, so it is shown in <bdi>. */
  lenderName: string
  /** The proposal of the form; null while a field is outside the lender's terms. */
  proposal: ProposalAmounts | null
  /** About when the term ends: the date to repay by. */
  repayBy: Date
}

/**
 * The proposal in one sentence, what the borrower repays by when and what the lender keeps
 * otherwise, updated as the borrower types; then what the borrower can still undo, and who can
 * read it.
 */
export default function ProposalSummary({ lenderName, proposal, repayBy }: ProposalSummaryProps) {
  const name = <bdi>{lenderName}</bdi>
  const { principal, collateral } = PAIR

  return (
    <section aria-label='Summary' className='flex flex-col gap-3'>
      {proposal === null ? (
        <p className='text-h3 text-muted'>
          Bring each field within the terms above to see what you repay.
        </p>
      ) : (
        <p className='text-h3 text-foreground wrap-break-word'>
          You repay{' '}
          <span className='tabular-nums'>
            {amountText(proposal.repayment, principal.decimals, 2)} {principal.symbol}
          </span>{' '}
          by {formatDay(repayBy)}. If you don&apos;t, {name} keeps your{' '}
          <span className='tabular-nums'>
            {amountText(proposal.collateral, collateral.decimals)} {collateral.symbol}
          </span>
          .
        </p>
      )}
      <div className='text-muted flex flex-col gap-1 text-sm wrap-break-word'>
        <p>You can cancel and take your collateral back until {name} accepts.</p>
        <p>Only you and {name} can read this proposal.</p>
      </div>
    </section>
  )
}
